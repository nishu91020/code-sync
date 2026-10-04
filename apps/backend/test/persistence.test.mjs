import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

import { createPrismaClient } from '../lib/storage.js'

const DATABASE_URL = process.env.TEST_DATABASE_URL
const PORT = 45992
const WS_URL = `ws://localhost:${PORT}`
const BACKEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function startServer() {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      CORS_ORIGIN: '*',
      SAVE_DEBOUNCE_MS: '300',
      // This suite is about persistence; it must not start runner containers.
      RUNNER_DRIVER: 'none',
      DATABASE_URL
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 20000)
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on port')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited early with code ${code}`))
    })
  })

  return { child, ready }
}

async function stopServer({ child }) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
}

function connect(roomId, token) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(WS_URL, `room-${roomId}`, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { token }
  })
  return { doc, provider, text: doc.getText('monaco') }
}

async function createRoom() {
  const response = await fetch(`http://localhost:${PORT}/api/room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice' })
  })
  return response.json()
}

async function waitFor(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('restart persistence', { skip: !DATABASE_URL && 'TEST_DATABASE_URL not set' }, () => {
  test('room content and host access survive a full server restart', async (t) => {
    const prisma = await createPrismaClient(DATABASE_URL)

    const source = 'function survives() { return true }'

    let serverA
    let serverB
    let slug

    t.after(async () => {
      if (serverA) await stopServer(serverA)
      if (serverB) await stopServer(serverB)
      if (slug) await prisma.room.deleteMany({ where: { slug } })
      await prisma.$disconnect()
    })

    // --- First server: write some code, then disconnect. ---
    serverA = startServer()
    await serverA.ready

    const { roomId, hostToken } = await createRoom()
    slug = roomId

    const first = connect(roomId, hostToken)
    await waitFor(() => first.provider.synced, 'first client to sync')
    first.text.insert(0, source)

    // Disconnecting the last client triggers an immediate snapshot.
    first.provider.destroy()
    first.doc.destroy()

    await waitFor(
      async () => {
        const room = await prisma.room.findUnique({
          where: { slug },
          select: { docState: { select: { update: true } } }
        })
        if (!room?.docState?.update) return false
        const probe = new Y.Doc()
        Y.applyUpdate(probe, new Uint8Array(room.docState.update))
        return probe.getText('monaco').toString() === source
      },
      'snapshot to reach Postgres'
    )

    await stopServer(serverA)
    serverA = null

    // --- Second server: same database, fresh memory. The host token issued by
    // the first server must still work, because only its hash was stored. ---
    serverB = startServer()
    await serverB.ready

    const second = connect(roomId, hostToken)
    await waitFor(() => second.provider.synced, 'second client to sync')
    await waitFor(() => second.text.toString() === source, 'content to be restored')

    assert.equal(
      second.text.toString(),
      source,
      'document content must be restored from Postgres after restart'
    )

    second.provider.destroy()
    second.doc.destroy()
  })

  test('edits are snapshotted while the client stays connected', async (t) => {
    const prisma = await createPrismaClient(DATABASE_URL)

    let server
    let slug

    t.after(async () => {
      if (server) await stopServer(server)
      if (slug) await prisma.room.deleteMany({ where: { slug } })
      await prisma.$disconnect()
    })

    server = startServer()
    await server.ready

    const { roomId, hostToken } = await createRoom()
    slug = roomId

    const client = connect(roomId, hostToken)
    await waitFor(() => client.provider.synced, 'client to sync')
    client.text.insert(0, 'still typing')

    // No disconnect here: the debounced timer alone must persist the edit.
    await waitFor(
      async () => {
        const room = await prisma.room.findUnique({
          where: { slug },
          select: { docState: { select: { update: true } } }
        })
        if (!room?.docState?.update) return false
        const probe = new Y.Doc()
        Y.applyUpdate(probe, new Uint8Array(room.docState.update))
        return probe.getText('monaco').toString() === 'still typing'
      },
      'debounced snapshot to reach Postgres'
    )

    assert.equal(client.provider.wsconnected, true, 'client should still be connected')

    client.provider.destroy()
    client.doc.destroy()
  })
})
