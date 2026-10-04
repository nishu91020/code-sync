/**
 * Persistence adapters for room documents and room access.
 *
 * A storage adapter exposes:
 *   createRoom(docName, { hostName, hostTokenHash, update }) -> Promise<void>
 *   load(docName)                     -> Promise<Uint8Array | null>
 *   save(docName, update)             -> Promise<boolean>  false if the room does not exist
 *   getAccess(docName)                -> Promise<{ hostName, hostTokenHash, members } | null>
 *   addMember(docName, member)        -> Promise<void>
 *   removeMember(docName, memberId)   -> Promise<boolean>
 *   close()                           -> Promise<void>
 *
 * Rooms are only ever created by `createRoom`; `save` never creates one, so a
 * document name that did not come from the API can never be persisted.
 *
 * The Prisma adapter is used when DATABASE_URL is configured; otherwise rooms
 * live only in memory and are lost when the process exits.
 */

const ROOM_PREFIX = 'room-'

/** Derives the public room slug from a Yjs document name. */
export function slugFromDocName(docName) {
  return docName.startsWith(ROOM_PREFIX) ? docName.slice(ROOM_PREFIX.length) : docName
}

export function createMemoryStorage() {
  /** @type {Map<string, { hostName: string|null, hostTokenHash: string|null, members: Map<string, object>, snapshot: Uint8Array|null }>} */
  const rooms = new Map()

  return {
    name: 'memory',

    async createRoom(docName, { hostName = null, hostTokenHash = null, update = null } = {}) {
      if (rooms.has(docName)) throw new Error(`Room ${docName} already exists`)
      rooms.set(docName, { hostName, hostTokenHash, members: new Map(), snapshot: update })
    },

    async load(docName) {
      return rooms.get(docName)?.snapshot ?? null
    },

    async save(docName, update) {
      const room = rooms.get(docName)
      if (!room) return false
      room.snapshot = update
      return true
    },

    async getAccess(docName) {
      const room = rooms.get(docName)
      if (!room) return null
      return {
        hostName: room.hostName,
        hostTokenHash: room.hostTokenHash,
        members: Array.from(room.members.values())
      }
    },

    async addMember(docName, { id, name, tokenHash }) {
      const room = rooms.get(docName)
      if (!room) throw new Error(`Room ${docName} does not exist`)
      room.members.set(id, { id, name, tokenHash, admittedAt: new Date() })
    },

    async removeMember(docName, memberId) {
      return rooms.get(docName)?.members.delete(memberId) ?? false
    },

    async close() {
      rooms.clear()
    }
  }
}

export function createPrismaStorage(prisma) {
  return {
    name: 'prisma',

    async createRoom(docName, { hostName = null, hostTokenHash = null, update = null } = {}) {
      await prisma.room.create({
        data: {
          slug: slugFromDocName(docName),
          hostName,
          hostTokenHash,
          ...(update ? { docState: { create: { update: Buffer.from(update), version: 1 } } } : {})
        }
      })
    },

    async load(docName) {
      const room = await prisma.room.findUnique({
        where: { slug: slugFromDocName(docName) },
        select: { docState: { select: { update: true } } }
      })

      const update = room?.docState?.update
      return update ? new Uint8Array(update) : null
    },

    async save(docName, update) {
      const payload = Buffer.from(update)

      // `update`, never `upsert`: an unknown name must not turn into a room.
      const room = await prisma.room
        .update({
          where: { slug: slugFromDocName(docName) },
          data: { lastActiveAt: new Date() },
          select: { id: true }
        })
        .catch((err) => {
          if (err?.code === 'P2025') return null
          throw err
        })
      if (!room) return false

      await prisma.docState.upsert({
        where: { roomId: room.id },
        create: { roomId: room.id, update: payload, version: 1 },
        update: { update: payload, version: { increment: 1 } }
      })
      return true
    },

    async getAccess(docName) {
      return prisma.room.findUnique({
        where: { slug: slugFromDocName(docName) },
        select: {
          hostName: true,
          hostTokenHash: true,
          members: {
            select: { id: true, name: true, tokenHash: true, admittedAt: true },
            orderBy: { admittedAt: 'asc' }
          }
        }
      })
    },

    async addMember(docName, { id, name, tokenHash }) {
      await prisma.room.update({
        where: { slug: slugFromDocName(docName) },
        data: { members: { create: { id, name, tokenHash } } }
      })
    },

    async removeMember(docName, memberId) {
      const { count } = await prisma.roomMember.deleteMany({
        where: { id: memberId, room: { slug: slugFromDocName(docName) } }
      })
      return count > 0
    },

    async close() {
      await prisma.$disconnect()
    }
  }
}

/**
 * Creates a Prisma client bound to `databaseUrl`. Prisma 7 routes queries
 * through a driver adapter rather than a built-in engine, so the connection
 * string is handed to node-postgres.
 */
export async function createPrismaClient(databaseUrl) {
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
    import('@prisma/client'),
    import('@prisma/adapter-pg')
  ])
  const adapter = new PrismaPg({ connectionString: databaseUrl })
  return new PrismaClient({ adapter })
}

/**
 * Builds the adapter appropriate for the current environment. Falls back to
 * in-memory storage when no database is configured or the client cannot be
 * loaded, so the server always starts.
 */
export async function createStorage({ databaseUrl = process.env.DATABASE_URL } = {}) {
  if (!databaseUrl) {
    console.log('💾 Persistence: in-memory (set DATABASE_URL to persist rooms)')
    return createMemoryStorage()
  }

  try {
    const prisma = await createPrismaClient(databaseUrl)
    // `$connect` is lazy with driver adapters, so issue a real query to make
    // sure the database is actually reachable before committing to it.
    await prisma.$queryRaw`SELECT 1`
    console.log('💾 Persistence: Postgres via Prisma')
    return createPrismaStorage(prisma)
  } catch (err) {
    console.error('⚠️  Falling back to in-memory persistence:', err.message)
    return createMemoryStorage()
  }
}
