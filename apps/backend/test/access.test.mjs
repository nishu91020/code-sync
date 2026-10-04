import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { setRunnerDriver } from '../lib/runner/index.js'
import { createAccessControl, hashToken } from '../lib/access.js'
import { createMemoryStorage } from '../lib/storage.js'
import { createFakeDriver } from './helpers/fakeRunnerDriver.mjs'
import {
  admitGuest,
  authHeaders,
  closeCodeFor,
  connect,
  createRoom,
  waitFor
} from './helpers/rooms.mjs'

const PORT = 45995
const HTTP_URL = `http://localhost:${PORT}`
const WS_URL = `ws://localhost:${PORT}`

process.env.PORT = String(PORT)
process.env.CORS_ORIGIN = '*'
process.env.JOIN_RATE_LIMIT = '40'
delete process.env.DATABASE_URL

const fake = createFakeDriver()
let server
let storage

before(async () => {
  setRunnerDriver(fake.driver)
  const mod = await import('../index.js')
  server = mod.server
  storage = mod.storage
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve))
  }
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
})

const api = (path, options = {}) => fetch(`${HTTP_URL}${path}`, options)

async function requestToJoin(roomId, name = 'Guest') {
  const response = await api(`/api/room/${roomId}/join-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color: '#30bced' })
  })
  return { status: response.status, body: await response.json() }
}

function poll(roomId, requestId, secret) {
  return api(`/api/room/${roomId}/join-requests/${requestId}`, { headers: authHeaders(secret) })
}

async function listAccess(roomId, token) {
  return api(`/api/room/${roomId}/access`, { headers: authHeaders(token) })
}

describe('room names', () => {
  test('a made-up room name is refused and nothing is created', async () => {
    const before = (await (await api('/health')).json()).rooms

    const { code } = await closeCodeFor(WS_URL, 'room-converge-123')

    assert.equal(code, 4400)
    assert.equal(await storage.getAccess('room-converge-123'), null)
    assert.equal(await storage.load('room-converge-123'), null)
    assert.equal((await (await api('/health')).json()).rooms, before, 'no document is loaded')
  })

  test('a name without the room prefix is refused', async () => {
    assert.equal((await closeCodeFor(WS_URL, 'anything-at-all')).code, 4400)
  })

  test('a well-formed id that was never created is refused and stays nonexistent', async () => {
    const roomId = crypto.randomUUID()

    const { code } = await closeCodeFor(WS_URL, `room-${roomId}?token=whatever`)

    assert.equal(code, 4404)
    const body = await (await api(`/api/room/${roomId}`)).json()
    assert.equal(body.exists, false)
  })

  test('a client that edits anyway cannot persist a made-up room', async () => {
    const client = connect(WS_URL, crypto.randomUUID(), 'forged')
    try {
      await waitFor(() => client.closes.length > 0, 'the server to refuse')
      assert.equal(client.closes[0], 4404)
      assert.equal(client.provider.synced, false)
    } finally {
      client.destroy()
    }
  })
})

describe('host', () => {
  test('creating a room returns a host token, and only the host token', async () => {
    const response = await api('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' })
    })
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.deepEqual(Object.keys(body).sort(), ['hostToken', 'roomId'])
    assert.ok(body.hostToken.length >= 43, 'a 256-bit token')

    const described = await (await api(`/api/room/${body.roomId}`)).json()
    assert.deepEqual(described, { roomId: body.roomId, exists: true, joinable: true })

    // Only a hash is stored.
    const stored = await storage.getAccess(`room-${body.roomId}`)
    assert.equal(stored.hostTokenHash, hashToken(body.hostToken))
    assert.notEqual(stored.hostTokenHash, body.hostToken)
  })

  test('connecting needs a valid token', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL, 'Alice')

    assert.equal((await closeCodeFor(WS_URL, `room-${roomId}`)).code, 4401)
    assert.equal((await closeCodeFor(WS_URL, `room-${roomId}?token=wrong`)).code, 4403)

    const host = connect(WS_URL, roomId, hostToken)
    try {
      await waitFor(() => host.provider.synced, 'the host to sync')
    } finally {
      host.destroy()
    }
  })

  test('a host token only opens its own room', async () => {
    const first = await createRoom(HTTP_URL, 'Alice')
    const second = await createRoom(HTTP_URL, 'Bob')

    const { code } = await closeCodeFor(WS_URL, `room-${second.roomId}?token=${first.hostToken}`)
    assert.equal(code, 4403)
  })

  test('/me identifies the host', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL, 'Alice')

    const me = await (await api(`/api/room/${roomId}/me`, { headers: authHeaders(hostToken) })).json()
    assert.deepEqual(me, { role: 'host', name: 'Alice', memberId: null })

    assert.equal((await api(`/api/room/${roomId}/me`)).status, 401)
    assert.equal((await api(`/api/room/${roomId}/me`, { headers: authHeaders('nope') })).status, 403)
  })
})

describe('admission', () => {
  test('a guest gets in only after the host admits them', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL, 'Alice')
    const host = connect(WS_URL, roomId, hostToken)

    try {
      await waitFor(() => host.provider.synced, 'the host to sync')
      host.text.insert(0, 'secret plan')

      const { status, body } = await requestToJoin(roomId, 'Bob')
      assert.equal(status, 202)
      const { requestId, requestSecret } = body

      // The request secret is not a room credential.
      assert.equal((await closeCodeFor(WS_URL, `room-${roomId}?token=${requestSecret}`)).code, 4403)

      const waiting = await (await poll(roomId, requestId, requestSecret)).json()
      assert.deepEqual(waiting, { status: 'pending' })

      const seen = await (await listAccess(roomId, hostToken)).json()
      assert.deepEqual(
        seen.pending.map(({ id, name, color }) => ({ id, name, color })),
        [{ id: requestId, name: 'Bob', color: '#30bced' }]
      )
      assert.deepEqual(seen.members, [])

      const admitted = await api(`/api/room/${roomId}/join-requests/${requestId}/admit`, {
        method: 'POST',
        headers: authHeaders(hostToken)
      })
      assert.equal(admitted.status, 200)

      const result = await (await poll(roomId, requestId, requestSecret)).json()
      assert.equal(result.status, 'admitted')
      assert.ok(result.token)

      const guest = connect(WS_URL, roomId, result.token)
      try {
        await waitFor(() => guest.text.toString() === 'secret plan', 'the guest to see the document')
      } finally {
        guest.destroy()
      }

      const me = await (await api(`/api/room/${roomId}/me`, { headers: authHeaders(result.token) })).json()
      assert.equal(me.role, 'member')
      assert.equal(me.name, 'Bob')

      const after = await (await listAccess(roomId, hostToken)).json()
      assert.deepEqual(after.pending, [])
      assert.deepEqual(after.members.map((member) => member.name), ['Bob'])
    } finally {
      host.destroy()
    }
  })

  test('a denied guest gets no token', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL)
    const { body } = await requestToJoin(roomId, 'Mallory')

    const denied = await api(`/api/room/${roomId}/join-requests/${body.requestId}/deny`, {
      method: 'POST',
      headers: authHeaders(hostToken)
    })
    assert.equal(denied.status, 204)

    const result = await (await poll(roomId, body.requestId, body.requestSecret)).json()
    assert.deepEqual(result, { status: 'denied' })

    // A decision is final.
    const again = await api(`/api/room/${roomId}/join-requests/${body.requestId}/admit`, {
      method: 'POST',
      headers: authHeaders(hostToken)
    })
    assert.equal(again.status, 409)
  })

  test('only the request secret can read a request', async () => {
    const { roomId } = await createRoom(HTTP_URL)
    const { body } = await requestToJoin(roomId)

    assert.equal((await poll(roomId, body.requestId, 'guess')).status, 403)
    assert.equal((await api(`/api/room/${roomId}/join-requests/${body.requestId}`)).status, 403)
  })

  test('a guest can withdraw their request', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL)
    const { body } = await requestToJoin(roomId, 'Bob')

    const cancelled = await api(`/api/room/${roomId}/join-requests/${body.requestId}`, {
      method: 'DELETE',
      headers: authHeaders(body.requestSecret)
    })
    assert.equal(cancelled.status, 204)
    assert.deepEqual((await (await listAccess(roomId, hostToken)).json()).pending, [])
  })

  test('only the host can see, admit, deny or remove', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL)
    const member = await admitGuest(HTTP_URL, roomId, hostToken, 'Bob')
    const { body } = await requestToJoin(roomId, 'Carol')

    for (const token of [member.token, null]) {
      const headers = token ? authHeaders(token) : {}
      const expected = token ? 403 : 401
      assert.equal((await api(`/api/room/${roomId}/access`, { headers })).status, expected)
      for (const action of ['admit', 'deny']) {
        const response = await api(`/api/room/${roomId}/join-requests/${body.requestId}/${action}`, {
          method: 'POST',
          headers
        })
        assert.equal(response.status, expected, `${action} with ${token ? 'member' : 'no'} token`)
      }
      const removal = await api(`/api/room/${roomId}/members/${member.memberId}`, {
        method: 'DELETE',
        headers
      })
      assert.equal(removal.status, expected)
    }

    // Another room's host has no say here either.
    const other = await createRoom(HTTP_URL)
    const foreign = await api(`/api/room/${roomId}/join-requests/${body.requestId}/admit`, {
      method: 'POST',
      headers: authHeaders(other.hostToken)
    })
    assert.equal(foreign.status, 403)
  })

  test('removing a member disconnects them and revokes their token', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL)
    const member = await admitGuest(HTTP_URL, roomId, hostToken, 'Bob')
    const guest = connect(WS_URL, roomId, member.token)

    try {
      await waitFor(() => guest.provider.synced, 'the guest to sync')

      const removed = await api(`/api/room/${roomId}/members/${member.memberId}`, {
        method: 'DELETE',
        headers: authHeaders(hostToken)
      })
      assert.equal(removed.status, 204)

      await waitFor(() => guest.closes.includes(4403), 'the guest to be disconnected')
    } finally {
      guest.destroy()
    }

    assert.equal((await closeCodeFor(WS_URL, `room-${roomId}?token=${member.token}`)).code, 4403)
    assert.equal(
      (await api(`/api/room/${roomId}/me`, { headers: authHeaders(member.token) })).status,
      403
    )
    const run = await api(`/api/room/${roomId}/run`, {
      method: 'POST',
      headers: authHeaders(member.token),
      body: JSON.stringify({ language: 'python' })
    })
    assert.equal(run.status, 403)
  })

  test('running code needs access, and runs are attributed by the server', async () => {
    const { roomId, hostToken } = await createRoom(HTTP_URL, 'Alice')
    const member = await admitGuest(HTTP_URL, roomId, hostToken, 'Bob')
    const host = connect(WS_URL, roomId, hostToken)

    try {
      await waitFor(() => host.provider.synced, 'the host to sync')
      host.text.insert(0, 'print(1)')

      const anonymous = await api(`/api/room/${roomId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'python' })
      })
      assert.equal(anonymous.status, 401)

      const response = await api(`/api/room/${roomId}/run`, {
        method: 'POST',
        headers: authHeaders(member.token),
        body: JSON.stringify({ language: 'python', startedBy: 'Alice' })
      })
      assert.equal(response.status, 200)
      await waitFor(() => host.execution.get('status') === 'done', 'the run to finish')
      assert.equal(host.execution.get('startedBy'), 'Bob', 'a claimed name is ignored')
    } finally {
      host.destroy()
    }
  })

  test('a room created before access control cannot be joined', async () => {
    const roomId = crypto.randomUUID()
    await storage.createRoom(`room-${roomId}`, {})

    const described = await (await api(`/api/room/${roomId}`)).json()
    assert.deepEqual(described, { roomId, exists: true, joinable: false })

    const { status, body } = await requestToJoin(roomId)
    assert.equal(status, 409)
    assert.match(body.error, /no host/)
  })

  test('join requests need a name and an existing room', async () => {
    const { roomId } = await createRoom(HTTP_URL)
    assert.equal((await requestToJoin(roomId, '   ')).status, 400)
    assert.equal((await requestToJoin(crypto.randomUUID())).status, 404)
    assert.equal((await requestToJoin('not-a-uuid')).status, 400)
  })

  test('join requests are rate limited per client', async () => {
    let limited = null
    for (let attempt = 0; attempt < 60 && !limited; attempt += 1) {
      const { roomId } = await createRoom(HTTP_URL)
      const response = await api(`/api/room/${roomId}/join-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Spammer' })
      })
      if (response.status === 429) limited = response
    }
    assert.ok(limited, 'expected a 429')
    assert.ok(limited.headers.get('retry-after'))
    assert.match((await limited.json()).error, /Too many join requests/)
  })
})

describe('join request lifecycle', () => {
  function setup(options = {}) {
    let clock = 1_000_000
    const storage = createMemoryStorage()
    const control = createAccessControl({ storage, now: () => clock, ...options })
    return { control, storage, advance: (ms) => (clock += ms) }
  }

  test('a request the guest stopped polling disappears', async () => {
    const { control, advance } = setup({ staleMs: 30_000 })
    const { roomId } = await control.createRoom({ hostName: 'Alice' })
    const { requestId, requestSecret } = await control.requestToJoin(roomId, { name: 'Bob' })

    advance(20_000)
    control.pollRequest(roomId, requestId, requestSecret)
    advance(20_000)
    assert.equal((await control.listAccess(roomId)).pending.length, 1, 'polling keeps it alive')

    advance(31_000)
    assert.equal((await control.listAccess(roomId)).pending.length, 0)
    assert.throws(() => control.pollRequest(roomId, requestId, requestSecret), (err) => err.status === 404)
  })

  test('an admitted token is only held until the guest could collect it', async () => {
    const { control, advance } = setup({ decidedTtlMs: 60_000 })
    const { roomId } = await control.createRoom({ hostName: 'Alice' })
    const { requestId, requestSecret } = await control.requestToJoin(roomId, { name: 'Bob' })
    await control.admit(roomId, requestId)

    assert.equal(control.pollRequest(roomId, requestId, requestSecret).status, 'admitted')
    advance(61_000)
    assert.throws(() => control.pollRequest(roomId, requestId, requestSecret), (err) => err.status === 404)
  })

  test('caps how many people can wait at once', async () => {
    const { control } = setup({ maxPendingPerRoom: 2 })
    const { roomId } = await control.createRoom({ hostName: 'Alice' })
    await control.requestToJoin(roomId, { name: 'A' })
    await control.requestToJoin(roomId, { name: 'B' })

    await assert.rejects(control.requestToJoin(roomId, { name: 'C' }), (err) => err.status === 429)
  })

  test('stores only hashes of member tokens', async () => {
    const { control, storage } = setup()
    const { roomId } = await control.createRoom({ hostName: 'Alice' })
    const { requestId, requestSecret } = await control.requestToJoin(roomId, { name: 'Bob' })
    await control.admit(roomId, requestId)
    const { token } = control.pollRequest(roomId, requestId, requestSecret)

    const stored = await storage.getAccess(`room-${roomId}`)
    assert.equal(stored.members[0].tokenHash, hashToken(token))
    assert.ok(!JSON.stringify(stored).includes(token))
  })

  test('names are cleaned before anyone sees them', async () => {
    const { control } = setup()
    const { roomId } = await control.createRoom({ hostName: 'Alice' })
    await control.requestToJoin(roomId, { name: '  Bob\u0000\u001b[31m  ', color: 'red;}' })

    const [pending] = (await control.listAccess(roomId)).pending
    assert.equal(pending.name, 'Bob[31m')
    assert.equal(pending.color, null, 'only #rrggbb colours are kept')
  })
})
