import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test, { describe } from 'node:test'
import * as Y from 'yjs'

import { RunnerPool } from '../lib/runner/pool.js'
import { trackLanguageDemand } from '../lib/runner/demand.js'
import { createFakeDriver, silentLog, waitFor } from './helpers/fakeRunnerDriver.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const RUN = { source: 'print(1)', stdin: '', timeoutMs: 1000, maxOutputBytes: 1000 }

function createPool(options = {}, driverOptions = {}) {
  const fake = createFakeDriver(driverOptions)
  const pool = new RunnerPool({ driver: fake.driver, idleMs: 60, log: silentLog, ...options })
  return { pool, ...fake }
}

async function stateOf(pool, language) {
  return (await pool.status()).runtimes[language].state
}

describe('runner pool', () => {
  test('starts nothing until a language is wanted', async () => {
    const { pool, state } = createPool()

    const status = await pool.status()
    assert.equal(status.dockerReachable, true)
    assert.ok(Object.values(status.runtimes).every((runtime) => runtime.state === 'cold'))
    assert.equal(state.started.length, 0)
  })

  test('warms exactly one container when a language gains demand', async () => {
    const { pool, state } = createPool()

    pool.addDemand('go')
    pool.addDemand('go')
    await waitFor(async () => (await stateOf(pool, 'go')) === 'ready', 'go to be ready')

    assert.deepEqual(state.started.map((handle) => handle.language), ['go'])
    assert.equal(await stateOf(pool, 'python'), 'cold')
  })

  test('a run takes the warm container, then destroys it and warms a fresh one', async () => {
    const { pool, state } = createPool()

    pool.addDemand('python')
    await waitFor(async () => (await stateOf(pool, 'python')) === 'ready', 'python ready')
    const warmed = state.started[0]

    const result = await pool.run('python', RUN)
    assert.equal(result.exitCode, 0)
    assert.equal(state.executed[0].handle.id, warmed.id, 'the run used the warm container')

    await waitFor(() => state.destroyed.some((handle) => handle.id === warmed.id), 'used container removed')
    await waitFor(async () => (await stateOf(pool, 'python')) === 'ready', 'replacement warmed')
    assert.equal(state.started.length, 2)
    assert.equal(pool.liveContainers, 1)
  })

  test('never reuses a container for a second run', async () => {
    const { pool, state } = createPool()
    pool.addDemand('python')
    await waitFor(async () => (await stateOf(pool, 'python')) === 'ready', 'python ready')

    await pool.run('python', RUN)
    await waitFor(async () => (await stateOf(pool, 'python')) === 'ready', 'replacement warmed')
    await pool.run('python', RUN)

    const [first, second] = state.executed.map((entry) => entry.handle.id)
    assert.notEqual(first, second)
  })

  test('runs a language nobody pre-selected by cold-starting a container', async () => {
    const { pool, state } = createPool()

    const result = await pool.run('ruby', RUN)

    assert.equal(result.exitCode, 0)
    assert.equal(state.started[0].language, 'ruby')
    await waitFor(() => state.destroyed.length === 1, 'cold container removed')
    // Without demand no replacement is kept around.
    assert.equal(await stateOf(pool, 'ruby'), 'cold')
    assert.equal(pool.liveContainers, 0)
  })

  test('stops the warm container once the idle period passes', async () => {
    const { pool, state } = createPool({ idleMs: 50 })

    pool.addDemand('java')
    await waitFor(async () => (await stateOf(pool, 'java')) === 'ready', 'java ready')
    pool.removeDemand('java')

    // Still there during the idle period…
    await sleep(20)
    assert.equal(await stateOf(pool, 'java'), 'ready')

    // …and gone after it.
    await waitFor(() => state.destroyed.length === 1, 'idle container removed')
    assert.equal(await stateOf(pool, 'java'), 'cold')
    assert.equal(pool.liveContainers, 0)
  })

  test('keeps the container when demand returns within the idle period', async () => {
    const { pool, state } = createPool({ idleMs: 80 })

    pool.addDemand('php')
    await waitFor(async () => (await stateOf(pool, 'php')) === 'ready', 'php ready')
    pool.removeDemand('php')
    await sleep(30)
    pool.addDemand('php')
    await sleep(120)

    assert.equal(state.destroyed.length, 0)
    assert.equal(await stateOf(pool, 'php'), 'ready')
  })

  test('discards a warm-up that finishes after demand is gone', async () => {
    const { pool, state } = createPool({ idleMs: 10 }, { startDelayMs: 80 })

    pool.addDemand('rust')
    pool.removeDemand('rust')

    await waitFor(() => state.started.length === 1, 'warm-up to finish')
    await waitFor(() => state.destroyed.length === 1, 'late container removed')
    assert.equal(pool.liveContainers, 0)
  })

  test('notices an image removed after it was listed', async () => {
    const { pool, state } = createPool({ imageCacheMs: 60_000 })
    assert.equal(await stateOf(pool, 'ruby'), 'cold')

    // Removed from Docker while the cached listing still claims it exists.
    state.images.delete('ruby')

    await assert.rejects(pool.acquire('ruby'), (err) => err.status === 503)
    assert.equal(await stateOf(pool, 'ruby'), 'missing')
  })

  test('reports a missing image with the command that builds it', async () => {
    const { pool, state } = createPool({}, { images: ['python'] })

    pool.addDemand('rust')
    await sleep(20)
    assert.equal(state.started.length, 0, 'nothing is started for a missing image')
    assert.equal(await stateOf(pool, 'rust'), 'missing')

    await assert.rejects(pool.acquire('rust'), (err) => {
      assert.equal(err.status, 409)
      assert.match(err.message, /npm run runners:build -- rust/)
      return true
    })
  })

  test('picks up an image built while the server is running', async () => {
    const { pool, state } = createPool({ imageCacheMs: 60_000 }, { images: ['python'] })
    assert.equal(await stateOf(pool, 'go'), 'missing')

    state.images.add('go')
    const result = await pool.run('go', RUN)

    assert.equal(result.exitCode, 0)
  })

  test('warms a wanted language as soon as its image appears', async () => {
    const { pool, state } = createPool({ imageCacheMs: 0 }, { images: ['python'] })

    pool.addDemand('go')
    await sleep(20)
    assert.equal(await stateOf(pool, 'go'), 'missing')

    // Built while a room has it selected: the next status check warms it.
    state.images.add('go')
    await pool.status()
    await waitFor(async () => (await stateOf(pool, 'go')) === 'ready', 'go to be warmed')
    assert.equal(state.started.filter((handle) => handle.language === 'go').length, 1)
  })

  test('retries a failed warm-up once Docker is back', async () => {
    const { pool, state } = createPool({ imageCacheMs: 0 })
    state.reachable = false

    pool.addDemand('ruby')
    await sleep(20)
    assert.equal(await stateOf(pool, 'ruby'), 'unavailable')

    state.reachable = true
    await pool.status()
    await waitFor(async () => (await stateOf(pool, 'ruby')) === 'ready', 'ruby to be warmed')
  })

  test('reports Docker being unreachable', async () => {
    const { pool, state } = createPool()
    state.reachable = false

    const status = await pool.status()
    assert.equal(status.dockerReachable, false)
    assert.match(status.message, /Docker isn't reachable/)
    assert.equal(status.runtimes.python.state, 'unavailable')

    await assert.rejects(pool.acquire('python'), (err) => err.status === 503)
  })

  test('refuses to start more containers than the cap allows', async () => {
    const { pool, state } = createPool({ maxContainers: 2 })

    pool.addDemand('python')
    pool.addDemand('go')
    await waitFor(() => pool.liveContainers === 2, 'two warm containers')

    // A third language would need a third container.
    pool.addDemand('rust')
    await sleep(20)
    assert.equal(state.started.length, 2)

    await assert.rejects(pool.acquire('ruby'), (err) => {
      assert.equal(err.status, 503)
      assert.match(err.message, /busy/)
      return true
    })
  })

  test('gives up an idle language\'s container when capacity is needed', async () => {
    const { pool, state } = createPool({ maxContainers: 2, idleMs: 60_000 })

    pool.addDemand('python')
    pool.addDemand('go')
    await waitFor(() => pool.liveContainers === 2, 'two warm containers')
    const goHandle = state.started.find((handle) => handle.language === 'go')

    // Nobody uses go any more, but its idle period has not elapsed yet.
    pool.removeDemand('go')
    const result = await pool.run('ruby', RUN)

    assert.equal(result.exitCode, 0)
    assert.ok(state.destroyed.some((handle) => handle.id === goHandle.id), 'idle go was evicted')
    assert.equal(await stateOf(pool, 'python'), 'ready', 'a language in use is never evicted')
  })

  test('shutdown removes every container it created', async () => {
    const { pool, state } = createPool()
    pool.addDemand('python')
    pool.addDemand('go')
    await waitFor(() => pool.liveContainers === 2, 'two warm containers')

    await pool.shutdown()

    assert.equal(state.live.size, 0)
  })
})

describe('language demand', () => {
  function setup() {
    const events = new EventEmitter()
    const calls = []
    const pool = {
      demand: new Map(),
      addDemand(language) {
        calls.push(['+', language])
        this.demand.set(language, (this.demand.get(language) ?? 0) + 1)
      },
      removeDemand(language) {
        calls.push(['-', language])
        this.demand.set(language, (this.demand.get(language) ?? 0) - 1)
      }
    }
    const stop = trackLanguageDemand(events, pool)
    return { events, pool, calls, stop }
  }

  test('an active room without a chosen language wants the editor default', () => {
    const { events, pool } = setup()
    events.emit('active', new Y.Doc())
    assert.equal(pool.demand.get('javascript'), 1)
  })

  test('an active room wants the language stored in its document', () => {
    const { events, pool } = setup()
    const doc = new Y.Doc()
    doc.getMap('meta').set('language', 'python')

    events.emit('active', doc)

    assert.equal(pool.demand.get('python'), 1)
    assert.equal(pool.demand.get('javascript'), undefined)
  })

  test('changing the language moves the demand', () => {
    const { events, pool } = setup()
    const doc = new Y.Doc()
    events.emit('active', doc)

    doc.getMap('meta').set('language', 'go')

    assert.equal(pool.demand.get('javascript'), 0)
    assert.equal(pool.demand.get('go'), 1)
  })

  test('languages without a runtime create no demand', () => {
    const { events, pool, calls } = setup()
    const doc = new Y.Doc()
    events.emit('active', doc)

    doc.getMap('meta').set('language', 'yaml')

    assert.equal(pool.demand.get('javascript'), 0)
    assert.deepEqual(calls, [['+', 'javascript'], ['-', 'javascript']])
  })

  test('an inactive room releases its demand and stops being observed', () => {
    const { events, pool, calls } = setup()
    const doc = new Y.Doc()
    events.emit('active', doc)
    events.emit('inactive', doc)

    doc.getMap('meta').set('language', 'rust')

    assert.equal(pool.demand.get('javascript'), 0)
    assert.equal(pool.demand.get('rust'), undefined)
    assert.equal(calls.length, 2)
  })

  test('a room that becomes active twice is only counted once', () => {
    const { events, pool } = setup()
    const doc = new Y.Doc()
    events.emit('active', doc)
    events.emit('active', doc)
    assert.equal(pool.demand.get('javascript'), 1)
  })
})
