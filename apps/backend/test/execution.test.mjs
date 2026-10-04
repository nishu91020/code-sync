import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { setRunnerDriver } from '../lib/runner/index.js'
import { createFakeDriver } from './helpers/fakeRunnerDriver.mjs'
import { authHeaders, connect as connectToRoom, createRoom } from './helpers/rooms.mjs'

const PORT = 45993
const HTTP_URL = `http://localhost:${PORT}`
const WS_URL = `ws://localhost:${PORT}`
const IDLE_MS = 300

// Every language except rust has a "built" image, so the missing-image path
// can be exercised too.
const fake = createFakeDriver({
  images: ['javascript', 'typescript', 'python', 'java', 'cpp', 'csharp', 'php', 'ruby', 'go']
})

process.env.PORT = String(PORT)
process.env.CORS_ORIGIN = '*'
process.env.RUN_RATE_LIMIT = '3'
process.env.RUN_RATE_WINDOW_MS = '60000'
process.env.RUNNER_IDLE_MS = String(IDLE_MS)
delete process.env.DATABASE_URL

let server

before(async () => {
  setRunnerDriver(fake.driver)
  const mod = await import('../index.js')
  server = mod.server
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve))
  }
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
})

// Every room here is joined as its host; remember each one's token.
const hostTokens = new Map()

function connect(room) {
  const roomId = room.replace(/^room-/, '')
  return connectToRoom(WS_URL, roomId, hostTokens.get(roomId))
}

async function waitFor(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function newRoom() {
  const { roomId, hostToken } = await createRoom(HTTP_URL, 'Alice')
  hostTokens.set(roomId, hostToken)
  return roomId
}

function run(roomId, body) {
  return fetch(`${HTTP_URL}/api/room/${roomId}/run`, {
    method: 'POST',
    headers: authHeaders(hostTokens.get(roomId)),
    body: JSON.stringify(body)
  })
}

async function languages() {
  return (await fetch(`${HTTP_URL}/api/languages`)).json()
}

/** Opens a room with `source` already typed in it. */
async function roomWithSource(source) {
  const roomId = await newRoom()
  const client = connect(`room-${roomId}`)
  await waitFor(() => client.provider.synced, 'client synced')
  client.text.insert(0, source)
  return { roomId, client }
}

describe('shared language', () => {
  test('a language change by one collaborator reaches the others', async () => {
    const roomId = await newRoom()
    const docName = `room-${roomId}`
    const alice = connect(docName)
    const bob = connect(docName)

    try {
      await waitFor(() => alice.provider.synced && bob.provider.synced, 'both synced')

      alice.meta.set('language', 'python')

      await waitFor(() => bob.meta.get('language') === 'python', 'Bob to see python')
      assert.equal(bob.meta.get('language'), 'python')

      // And back the other way.
      bob.meta.set('language', 'rust')
      await waitFor(() => alice.meta.get('language') === 'rust', 'Alice to see rust')
      assert.equal(alice.meta.get('language'), 'rust')
    } finally {
      alice.destroy()
      bob.destroy()
    }
  })
})

describe('runtime availability', () => {
  test('GET /api/languages reports which runner images exist', async () => {
    const response = await fetch(`${HTTP_URL}/api/languages`)
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.dockerReachable, true)
    assert.ok(body.runnable.includes('rust'))
    assert.ok(body.available.includes('python'))
    assert.ok(body.available.includes('cpp'))
    // No image was built for rust.
    assert.ok(!body.available.includes('rust'))
    assert.equal(body.runtimes.rust.state, 'missing')
    // The Piston-era fields are gone.
    assert.equal(body.installs, undefined)
    assert.equal(body.runner, undefined)
  })

  test('selecting a language in a connected room warms its container', async () => {
    const roomId = await newRoom()
    const client = connect(`room-${roomId}`)

    try {
      await waitFor(() => client.provider.synced, 'client synced')
      const before = fake.state.started.filter((handle) => handle.language === 'go').length

      client.meta.set('language', 'go')

      await waitFor(
        () => fake.state.started.filter((handle) => handle.language === 'go').length > before,
        'a go container to start'
      )
      await waitFor(async () => (await languages()).runtimes.go.state === 'ready', 'go ready')
    } finally {
      client.destroy()
    }
  })

  test('the container is stopped once nobody is using the language', async () => {
    const roomId = await newRoom()
    const client = connect(`room-${roomId}`)
    await waitFor(() => client.provider.synced, 'client synced')

    client.meta.set('language', 'php')
    await waitFor(async () => (await languages()).runtimes.php.state === 'ready', 'php ready')
    const warm = fake.state.started.filter((handle) => handle.language === 'php').at(-1)

    // The last collaborator leaving ends the demand; the idle period follows.
    client.destroy()

    await waitFor(
      () => fake.state.destroyed.some((handle) => handle.id === warm.id),
      'idle php container to be removed',
      IDLE_MS * 10
    )
    assert.equal((await languages()).runtimes.php.state, 'cold')
  })

  test('markup languages never start a container', async () => {
    const roomId = await newRoom()
    const client = connect(`room-${roomId}`)

    try {
      await waitFor(() => client.provider.synced, 'client synced')
      const startedBefore = fake.state.started.length

      client.meta.set('language', 'yaml')
      await new Promise((resolve) => setTimeout(resolve, 100))

      const yamlStarts = fake.state.started.slice(startedBefore).filter((h) => h.language === 'yaml')
      assert.equal(yamlStarts.length, 0)
    } finally {
      client.destroy()
    }
  })
})

describe('code execution', () => {
  test('rejects languages that cannot be executed', async () => {
    const roomId = await newRoom()
    const response = await run(roomId, { language: 'yaml' })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /cannot be executed/)
  })

  test('runs the room source and shares the output with every collaborator', async () => {
    const roomId = await newRoom()
    const docName = `room-${roomId}`
    const runner = connect(docName)
    const watcher = connect(docName)

    try {
      await waitFor(() => runner.provider.synced && watcher.provider.synced, 'both synced')

      runner.text.insert(0, 'print("hello")')
      await waitFor(() => watcher.text.toString() === 'print("hello")', 'text to replicate')

      const response = await run(roomId, { language: 'python', startedBy: 'Alice' })

      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.exitCode, 0)
      assert.match(result.stdout, /ran python: print\("hello"\)/)

      // The container received the room's source, not anything client-supplied.
      const lastRun = fake.state.executed.at(-1)
      assert.equal(lastRun.source, 'print("hello")')
      assert.equal(lastRun.handle.language, 'python')

      // Crucially, the *other* collaborator sees the same result.
      await waitFor(() => watcher.execution.get('status') === 'done', 'watcher to see result')
      assert.match(watcher.execution.get('stdout'), /ran python: print\("hello"\)/)
      assert.equal(watcher.execution.get('exitCode'), 0)
      assert.equal(watcher.execution.get('startedBy'), 'Alice')
    } finally {
      runner.destroy()
      watcher.destroy()
    }
  })

  test('each run gets a fresh container that is removed afterwards', async () => {
    const { roomId, client } = await roomWithSource('print(1)')

    try {
      const first = await run(roomId, { language: 'python' })
      assert.equal(first.status, 200)
      const firstHandle = fake.state.executed.at(-1).handle

      const second = await run(roomId, { language: 'python' })
      assert.equal(second.status, 200)
      const secondHandle = fake.state.executed.at(-1).handle

      assert.notEqual(firstHandle.id, secondHandle.id)
      await waitFor(
        () =>
          [firstHandle, secondHandle].every((handle) =>
            fake.state.destroyed.some((destroyed) => destroyed.id === handle.id)
          ),
        'both used containers removed'
      )
    } finally {
      client.destroy()
    }
  })

  test('passes stdin through to the program', async () => {
    const { roomId, client } = await roomWithSource('read lines')

    try {
      const response = await run(roomId, { language: 'python', stdin: 'first\nsecond' })
      const result = await response.json()

      assert.equal(fake.state.executed.at(-1).stdin, 'first\nsecond')
      assert.match(result.stdout, /stdin: first\nsecond/)
    } finally {
      client.destroy()
    }
  })

  test('refuses a language whose runner image is not built', async () => {
    const { roomId, client } = await roomWithSource('fn main() {}')

    try {
      const response = await run(roomId, { language: 'rust' })

      assert.equal(response.status, 409)
      assert.match((await response.json()).error, /npm run runners:build -- rust/)
      // Everyone in the room sees why the run did not happen.
      await waitFor(() => client.execution.get('status') === 'error', 'error to be shared')
      assert.match(client.execution.get('message'), /isn't built/)
    } finally {
      client.destroy()
    }
  })

  test('surfaces compile errors', async () => {
    const { roomId, client } = await roomWithSource('int main() { COMPILE_ERROR }')

    try {
      const response = await run(roomId, { language: 'cpp' })

      assert.equal(response.status, 200)
      const result = await response.json()
      assert.match(result.stderr, /error: boom/)
      assert.equal(result.exitCode, 1)
      assert.equal(result.stdout, '')
    } finally {
      client.destroy()
    }
  })

  test('reports a non-zero exit code with partial output', async () => {
    const { roomId, client } = await roomWithSource('EXIT_NONZERO')

    try {
      const result = await (await run(roomId, { language: 'python' })).json()
      assert.equal(result.exitCode, 3)
      assert.equal(result.stdout, 'partial\n')
      assert.match(result.stderr, /bad things/)
    } finally {
      client.destroy()
    }
  })

  test('reports a run that hit the time limit', async () => {
    const { roomId, client } = await roomWithSource('while True: TIMEOUT')

    try {
      const result = await (await run(roomId, { language: 'python' })).json()
      assert.equal(result.exitCode, 137)
      assert.equal(result.stdout, 'started\n')
      assert.match(result.stderr, /Time limit exceeded \(\d+s\)/)
    } finally {
      client.destroy()
    }
  })

  test('reports a run stopped for flooding output', async () => {
    const { roomId, client } = await roomWithSource('FLOOD')

    try {
      const result = await (await run(roomId, { language: 'python' })).json()
      assert.equal(result.exitCode, 137)
      assert.match(result.stdout, /output truncated/)
      assert.match(result.stderr, /too much output/)
    } finally {
      client.destroy()
    }
  })

  test('truncates very large output', async () => {
    const { roomId, client } = await roomWithSource('HUGE_OUTPUT')

    try {
      const result = await (await run(roomId, { language: 'python' })).json()
      assert.ok(result.stdout.length < 50000, 'output should be truncated')
      assert.match(result.stdout, /output truncated/)
    } finally {
      client.destroy()
    }
  })

  test('refuses to run an empty document', async () => {
    const roomId = await newRoom()
    const response = await run(roomId, { language: 'python' })

    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /empty/)
  })

  test('rate limits repeated runs in the same room', async () => {
    const { roomId, client } = await roomWithSource('print(1)')

    try {
      // RUN_RATE_LIMIT is 3 for this suite.
      for (let i = 0; i < 3; i += 1) {
        const ok = await run(roomId, { language: 'python' })
        assert.equal(ok.status, 200, `run ${i + 1} should succeed`)
      }

      const limited = await run(roomId, { language: 'python' })
      assert.equal(limited.status, 429)
      assert.ok(limited.headers.get('retry-after'))
    } finally {
      client.destroy()
    }
  })
})
