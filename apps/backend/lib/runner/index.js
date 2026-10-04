import os from 'node:os'

import { RUNNER_LANGUAGES, isRunnable, runnableLanguages } from './languages.js'
import { RunnerError } from './errors.js'
import { RunnerPool } from './pool.js'
import { createDisabledDriver, createDockerDriver } from './dockerDriver.js'

export { RunnerError, isRunnable, runnableLanguages, RUNNER_LANGUAGES }
export { trackLanguageDemand } from './demand.js'

const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 15000)
const MAX_SOURCE_BYTES = Number(process.env.MAX_SOURCE_BYTES || 128 * 1024)
const MAX_OUTPUT_CHARS = Number(process.env.MAX_OUTPUT_CHARS || 20000)

let driverOverride = null
let pool = null

/**
 * Replaces the container driver. Must be called before the pool is first used;
 * tests use it to run without Docker, mirroring `setStorage`.
 */
export function setRunnerDriver(driver) {
  driverOverride = driver
  pool = null
}

function createDefaultDriver() {
  if (process.env.RUNNER_DRIVER === 'none') return createDisabledDriver()
  return createDockerDriver({
    // Scopes orphan cleanup to this instance, so a second backend (or the test
    // suite) on the same Docker host never removes another's containers.
    owner: `${os.hostname()}:${process.env.PORT || 3001}`,
    // Two CPUs: compilers (rustc, dotnet, javac) are multithreaded and stall
    // badly under a one-CPU CFS quota.
    cpus: Number(process.env.RUNNER_CPUS || 2),
    runtime: process.env.RUNNER_RUNTIME || undefined
  })
}

/** @returns {RunnerPool} */
export function getRunnerPool() {
  if (!pool) {
    pool = new RunnerPool({
      driver: driverOverride ?? createDefaultDriver(),
      idleMs: Number(process.env.RUNNER_IDLE_MS || 5 * 60 * 1000),
      maxContainers: Number(process.env.RUNNER_MAX_CONTAINERS || 6)
    })
  }
  return pool
}

function truncate(text, alreadyCut = false) {
  const value = typeof text === 'string' ? text : ''
  return alreadyCut || value.length > MAX_OUTPUT_CHARS
    ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n…output truncated…`
    : value
}

function appendLine(text, line) {
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`
}

/**
 * Runs `source` in a fresh container and resolves with `{ stdout, stderr, exitCode }`.
 *
 * @param {{ language: string, source: string, stdin?: string }} request
 */
export async function runCode({ language, source, stdin = '' }) {
  if (!isRunnable(language)) {
    throw new RunnerError(`Language "${language}" cannot be executed`, 400)
  }
  if (typeof source !== 'string' || source.trim() === '') {
    throw new RunnerError('Nothing to run: the editor is empty', 400)
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new RunnerError('Source is too large to run', 413)
  }

  const result = await getRunnerPool().run(language, {
    source,
    stdin,
    timeoutMs: RUN_TIMEOUT_MS,
    // UTF-8 can take up to 4 bytes per character.
    maxOutputBytes: MAX_OUTPUT_CHARS * 4
  })

  let stderr = result.stderr ?? ''
  let exitCode = result.exitCode

  if (result.timedOut) {
    stderr = appendLine(stderr, `Time limit exceeded (${RUN_TIMEOUT_MS / 1000}s)`)
    exitCode = 137
  } else if (result.flooded) {
    stderr = appendLine(stderr, 'Stopped: the program produced too much output')
    exitCode = 137
  }

  return {
    stdout: truncate(result.stdout, result.stdoutTruncated),
    stderr: truncate(stderr, result.stderrTruncated),
    exitCode: typeof exitCode === 'number' ? exitCode : 1
  }
}
