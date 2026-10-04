import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * Room access control.
 *
 * Whoever creates a room is its **host** and receives a secret host token.
 * Anyone else must ask to join; the host admits or denies them, and an
 * admitted guest receives their own member token. Every token is 256 bits of
 * randomness and only its SHA-256 hash is stored, so a database leak does not
 * leak working credentials.
 *
 * Join requests are deliberately in memory and short-lived: they only matter
 * while the guest is waiting on the other side.
 */

const ROOM_PREFIX = 'room-'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COLOR_RE = /^#[0-9a-f]{6}$/i
const MAX_NAME_LENGTH = 32

/** The WebSocket close codes used when a connection is refused. */
export const CLOSE_CODES = {
  invalid: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404
}

export class AccessError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status
   * @param {number} closeCode WebSocket close code
   */
  constructor(message, status, closeCode) {
    super(message)
    this.name = 'AccessError'
    this.status = status
    this.closeCode = closeCode
  }
}

export const isValidRoomId = (roomId) => typeof roomId === 'string' && UUID_RE.test(roomId)

export const docNameFor = (roomId) => `${ROOM_PREFIX}${roomId}`

/** The room id inside a WebSocket document name, or `null` if malformed. */
export function roomIdFromDocName(docName) {
  if (typeof docName !== 'string' || !docName.startsWith(ROOM_PREFIX)) return null
  const roomId = docName.slice(ROOM_PREFIX.length)
  return isValidRoomId(roomId) ? roomId : null
}

export const newToken = () => randomBytes(32).toString('base64url')

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex')

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/** Trims and strips control characters; `null` if nothing usable is left. */
export function cleanName(name) {
  if (typeof name !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH)
  return cleaned || null
}

const notFound = () => new AccessError('Room not found', 404, CLOSE_CODES.notFound)

/**
 * @param {object} options
 * @param {object} options.storage a storage adapter (see storage.js)
 * @param {() => number} [options.now]
 * @param {number} [options.staleMs] drop a pending request the guest stopped polling
 * @param {number} [options.decidedTtlMs] keep a decided request for the guest to collect
 * @param {number} [options.maxPendingPerRoom]
 */
export function createAccessControl({
  storage,
  now = Date.now,
  staleMs = 30_000,
  decidedTtlMs = 120_000,
  maxPendingPerRoom = 20
}) {
  /** @type {Map<string, Map<string, object>>} roomId -> requestId -> request */
  const requests = new Map()

  function sweep(roomId) {
    const room = requests.get(roomId)
    if (!room) return
    const t = now()
    for (const [id, request] of room) {
      const expired =
        request.status === 'pending'
          ? t - request.lastSeenAt > staleMs
          : t - request.decidedAt > decidedTtlMs
      if (expired) room.delete(id)
    }
    if (room.size === 0) requests.delete(roomId)
  }

  async function loadAccess(roomId) {
    if (!isValidRoomId(roomId)) {
      throw new AccessError('Invalid room id', 400, CLOSE_CODES.invalid)
    }
    const access = await storage.getAccess(docNameFor(roomId))
    if (!access) throw notFound()
    return access
  }

  function findRequest(roomId, requestId) {
    sweep(roomId)
    const request = requests.get(roomId)?.get(requestId)
    if (!request) {
      throw new AccessError('This join request has expired. Ask again.', 404, CLOSE_CODES.notFound)
    }
    return request
  }

  return {
    /** Creates a room with its host. Returns the host's secret token once. */
    async createRoom({ hostName, update }) {
      const roomId = randomUUID()
      const hostToken = newToken()
      await storage.createRoom(docNameFor(roomId), {
        hostName: cleanName(hostName) ?? 'Host',
        hostTokenHash: hashToken(hostToken),
        update
      })
      return { roomId, hostToken }
    },

    /** Whether the room exists, and whether it can be joined at all. */
    async describeRoom(roomId) {
      if (!isValidRoomId(roomId)) return { exists: false, joinable: false }
      const access = await storage.getAccess(docNameFor(roomId))
      return { exists: access !== null, joinable: Boolean(access?.hostTokenHash) }
    },

    /**
     * Resolves a token to who is using it: the host, or an admitted member.
     * Throws an AccessError for anything else.
     */
    async authenticate(roomId, token) {
      const access = await loadAccess(roomId)
      if (!token) {
        throw new AccessError('This room requires an invitation', 401, CLOSE_CODES.unauthenticated)
      }

      const hash = hashToken(token)
      if (access.hostTokenHash && sameHash(hash, access.hostTokenHash)) {
        return { role: 'host', name: access.hostName ?? 'Host', memberId: null }
      }
      const member = access.members.find((candidate) => sameHash(hash, candidate.tokenHash))
      if (member) {
        return { role: 'member', name: member.name, memberId: member.id }
      }
      throw new AccessError(
        'You do not have access to this room',
        403,
        CLOSE_CODES.forbidden
      )
    },

    async requestToJoin(roomId, { name, color } = {}) {
      const access = await loadAccess(roomId)
      if (!access.hostTokenHash) {
        throw new AccessError(
          'This room was created before access control and has no host, so nobody can be admitted. Create a new room.',
          409,
          CLOSE_CODES.forbidden
        )
      }

      const cleaned = cleanName(name)
      if (!cleaned) throw new AccessError('A name is required', 400, CLOSE_CODES.invalid)

      sweep(roomId)
      let room = requests.get(roomId)
      const pending = room
        ? Array.from(room.values()).filter((request) => request.status === 'pending').length
        : 0
      if (pending >= maxPendingPerRoom) {
        throw new AccessError('Too many people are waiting to join this room', 429, CLOSE_CODES.forbidden)
      }

      if (!room) {
        room = new Map()
        requests.set(roomId, room)
      }

      const requestId = randomUUID()
      const requestSecret = newToken()
      const t = now()
      room.set(requestId, {
        id: requestId,
        name: cleaned,
        color: COLOR_RE.test(color ?? '') ? color : null,
        secretHash: hashToken(requestSecret),
        status: 'pending',
        createdAt: t,
        lastSeenAt: t,
        decidedAt: null,
        token: null,
        memberId: null
      })
      return { requestId, requestSecret }
    },

    /** What the waiting guest sees. Polling also keeps the request alive. */
    pollRequest(roomId, requestId, requestSecret) {
      const request = findRequest(roomId, requestId)
      if (!sameHash(hashToken(requestSecret), request.secretHash)) {
        throw new AccessError('Not your request', 403, CLOSE_CODES.forbidden)
      }
      request.lastSeenAt = now()

      if (request.status === 'admitted') {
        return { status: 'admitted', token: request.token, memberId: request.memberId, name: request.name }
      }
      return { status: request.status }
    },

    cancelRequest(roomId, requestId, requestSecret) {
      const request = findRequest(roomId, requestId)
      if (!sameHash(hashToken(requestSecret), request.secretHash)) {
        throw new AccessError('Not your request', 403, CLOSE_CODES.forbidden)
      }
      requests.get(roomId)?.delete(requestId)
    },

    /** The host's view: who is waiting and who has been admitted. */
    async listAccess(roomId) {
      const access = await loadAccess(roomId)
      sweep(roomId)
      const pending = Array.from(requests.get(roomId)?.values() ?? [])
        .filter((request) => request.status === 'pending')
        .map(({ id, name, color, createdAt }) => ({ id, name, color, requestedAt: createdAt }))
      const members = access.members.map(({ id, name, admittedAt }) => ({ id, name, admittedAt }))
      return { host: { name: access.hostName ?? 'Host' }, pending, members }
    },

    async admit(roomId, requestId) {
      const request = findRequest(roomId, requestId)
      if (request.status !== 'pending') {
        throw new AccessError(`This request was already ${request.status}`, 409, CLOSE_CODES.forbidden)
      }

      const token = newToken()
      const memberId = randomUUID()
      await storage.addMember(docNameFor(roomId), {
        id: memberId,
        name: request.name,
        tokenHash: hashToken(token)
      })

      // Held only until the guest collects it, or `decidedTtlMs` passes.
      Object.assign(request, { status: 'admitted', token, memberId, decidedAt: now() })
      return { memberId, name: request.name }
    },

    deny(roomId, requestId) {
      const request = findRequest(roomId, requestId)
      if (request.status !== 'pending') {
        throw new AccessError(`This request was already ${request.status}`, 409, CLOSE_CODES.forbidden)
      }
      Object.assign(request, { status: 'denied', decidedAt: now() })
    },

    async removeMember(roomId, memberId) {
      await loadAccess(roomId)
      const removed = await storage.removeMember(docNameFor(roomId), memberId)
      if (!removed) throw new AccessError('No such member', 404, CLOSE_CODES.notFound)
    }
  }
}
