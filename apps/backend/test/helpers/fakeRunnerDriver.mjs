import { runnableLanguages } from '../../lib/runner/languages.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * In-memory stand-in for the Docker driver. It records every container it
 * "starts" and "destroys", and answers runs from a script keyed on the source,
 * so the pool and API can be exercised without Docker.
 */
export function createFakeDriver({ images = runnableLanguages, startDelayMs = 0 } = {}) {
  const state = {
    images: new Set(images),
    reachable: true,
    started: [],
    destroyed: [],
    executed: [],
    live: new Map(),
    nextId: 1
  }

  const driver = {
    async ping() {
      return state.reachable
    },

    async listImages() {
      if (!state.reachable) throw new Error('connect ENOENT //./pipe/docker_engine')
      return new Set(state.images)
    },

    async start(language) {
      if (startDelayMs) await sleep(startDelayMs)
      // Like Docker: creating a container from a missing image fails.
      if (!state.images.has(language)) {
        throw new Error(`No such image: codesync-runner-${language}:latest`)
      }
      const handle = { id: `fake-${state.nextId++}`, language }
      state.started.push(handle)
      state.live.set(handle.id, handle)
      return handle
    },

    async execute(handle, { source, stdin }) {
      state.executed.push({ handle, source, stdin })
      const base = { stdoutTruncated: false, stderrTruncated: false, timedOut: false, flooded: false }

      if (source.includes('COMPILE_ERROR')) {
        return { ...base, stdout: '', stderr: 'main.cpp:1:1: error: boom', exitCode: 1 }
      }
      if (source.includes('EXIT_NONZERO')) {
        return { ...base, stdout: 'partial\n', stderr: 'Traceback: bad things\n', exitCode: 3 }
      }
      if (source.includes('HUGE_OUTPUT')) {
        return { ...base, stdout: 'x'.repeat(50000), stderr: '', exitCode: 0 }
      }
      if (source.includes('TIMEOUT')) {
        return { ...base, stdout: 'started\n', stderr: '', exitCode: null, timedOut: true }
      }
      if (source.includes('FLOOD')) {
        return { ...base, stdout: 'y'.repeat(100), stdoutTruncated: true, stderr: '', exitCode: null, flooded: true }
      }

      const echoed = stdin ? `stdin: ${stdin}` : ''
      return {
        ...base,
        stdout: `ran ${handle.language}: ${source.trim()}\n${echoed}`,
        stderr: '',
        exitCode: 0
      }
    },

    async destroy(handle) {
      state.destroyed.push(handle)
      state.live.delete(handle.id)
    },

    async removeOrphans() {
      const count = state.live.size
      for (const handle of state.live.values()) state.destroyed.push(handle)
      state.live.clear()
      return count
    }
  }

  return { driver, state }
}

export async function waitFor(fn, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export const silentLog = { log() {}, error() {} }
