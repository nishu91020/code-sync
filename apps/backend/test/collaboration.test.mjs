import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { connect as connectToRoom, createRoom } from './helpers/rooms.mjs'

const PORT = 45991
const HTTP_URL = `http://localhost:${PORT}`
const WS_URL = `ws://localhost:${PORT}`

process.env.PORT = String(PORT)
process.env.CORS_ORIGIN = '*'
// Connecting clients would otherwise warm real runner containers.
process.env.RUNNER_DRIVER = 'none'

/** @type {import('http').Server} */
let server

before(async () => {
  const mod = await import('../index.js')
  server = mod.server
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve))
  }
})

after(async () => {
  // Lingering websocket/keep-alive sockets would otherwise hold `close` open.
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
})

async function waitFor(predicate, { timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** A room created through the API, and a way to join it as its host. */
async function newRoom() {
  const { roomId, hostToken } = await createRoom(HTTP_URL)
  return () => connectToRoom(WS_URL, roomId, hostToken)
}

function disconnectAll(clients) {
  clients.forEach((client) => client.destroy())
}

describe('HTTP API', () => {
  test('GET /health reports status and room stats', async () => {
    const response = await fetch(`${HTTP_URL}/health`)
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.status, 'ok')
    assert.equal(typeof body.rooms, 'number')
    assert.equal(typeof body.connections, 'number')
  })

  test('POST /api/room creates a room that is then reported as existing', async () => {
    const created = await fetch(`${HTTP_URL}/api/room`, { method: 'POST' })
    assert.equal(created.status, 201)

    const { roomId, hostToken } = await created.json()
    assert.match(roomId, /^[0-9a-f-]{36}$/)
    assert.ok(hostToken)

    const lookup = await fetch(`${HTTP_URL}/api/room/${roomId}`)
    const body = await lookup.json()
    assert.equal(body.exists, true)
  })

  test('unknown routes return 404', async () => {
    const response = await fetch(`${HTTP_URL}/does-not-exist`)
    assert.equal(response.status, 404)
  })
})

describe('collaborative editing', () => {
  test('three clients converge on identical content after concurrent edits', async () => {
    const connect = await newRoom()
    const clients = [connect(), connect(), connect()]

    try {
      await waitFor(() => clients.every((client) => client.provider.synced), {
        label: 'all clients to sync'
      })

      // Concurrent inserts at position 0 from every client.
      clients[0].text.insert(0, 'alpha\n')
      clients[1].text.insert(0, 'beta\n')
      clients[2].text.insert(0, 'gamma\n')

      await waitFor(
        () => {
          const values = clients.map((client) => client.text.toString())
          return (
            values[0].length === 'alpha\nbeta\ngamma\n'.length &&
            values.every((value) => value === values[0])
          )
        },
        { label: 'documents to converge' }
      )

      const converged = clients[0].text.toString()
      for (const fragment of ['alpha', 'beta', 'gamma']) {
        assert.ok(converged.includes(fragment), `expected "${fragment}" in "${converged}"`)
      }
      for (const client of clients) {
        assert.equal(client.text.toString(), converged)
      }
    } finally {
      disconnectAll(clients)
    }
  })

  test('a late joiner receives the existing document state', async () => {
    const connect = await newRoom()
    const first = connect()

    try {
      await waitFor(() => first.provider.synced, { label: 'first client to sync' })
      first.text.insert(0, 'const answer = 42')

      const late = connect()
      try {
        await waitFor(() => late.text.toString() === 'const answer = 42', {
          label: 'late joiner to receive state'
        })
        assert.equal(late.text.toString(), 'const answer = 42')
      } finally {
        disconnectAll([late])
      }
    } finally {
      disconnectAll([first])
    }
  })

  test('awareness state propagates between clients and is cleared on disconnect', async () => {
    const connect = await newRoom()
    const alice = connect()
    const bob = connect()

    try {
      await waitFor(() => alice.provider.synced && bob.provider.synced, {
        label: 'both clients to sync'
      })

      alice.provider.awareness.setLocalStateField('user', {
        name: 'Alice',
        color: '#30bced'
      })

      await waitFor(
        () =>
          Array.from(bob.provider.awareness.getStates().values()).some(
            (state) => state?.user?.name === 'Alice'
          ),
        { label: 'Bob to observe Alice' }
      )

      const aliceClientId = alice.provider.awareness.clientID
      alice.destroy()

      await waitFor(() => !bob.provider.awareness.getStates().has(aliceClientId), {
        label: "Alice's awareness state to be removed"
      })
    } finally {
      disconnectAll([bob])
    }
  })
})
