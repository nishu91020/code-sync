import { PassThrough } from 'node:stream'
import Docker from 'dockerode'
import tar from 'tar-stream'

import { RUNNER_LANGUAGES, imageFor } from './languages.js'
import { RunnerError } from './errors.js'

const RUNNER_UID = 10001
const MANAGED_LABEL = 'codesync.managed'
const OWNER_LABEL = 'codesync.owner'
const LANGUAGE_LABEL = 'codesync.language'
const IMAGE_LABEL = 'codesync.runner'

// Caps any single file a program writes. overlay2 cannot enforce a disk quota
// on the container's writable layer, so this is what stops a run filling it.
const MAX_FILE_BYTES = 64 * 1024 * 1024

// Output beyond the collected limit is discarded; a program that keeps spewing
// this much more is killed rather than left to burn its whole time limit.
const FLOOD_BYTES = 4 * 1024 * 1024

/** Builds an in-memory tar of `files`, owned by the unprivileged runner user. */
function packFiles(files) {
  return new Promise((resolve, reject) => {
    const pack = tar.pack()
    const chunks = []
    pack.on('data', (chunk) => chunks.push(chunk))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)

    for (const [name, content] of Object.entries(files)) {
      pack.entry({ name, mode: 0o644, uid: RUNNER_UID, gid: RUNNER_UID }, content)
    }
    pack.finalize()
  })
}

function createCollector(limit) {
  const chunks = []
  let size = 0
  let dropped = 0

  return {
    push(chunk) {
      const room = limit - size
      if (room > 0) {
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        chunks.push(part)
        size += part.length
        dropped += chunk.length - part.length
      } else {
        dropped += chunk.length
      }
    },
    get dropped() {
      return dropped
    },
    text() {
      return Buffer.concat(chunks).toString('utf8')
    }
  }
}

function isGone(err) {
  // 404: already removed. 409: removal already in progress.
  return err?.statusCode === 404 || err?.statusCode === 409
}

/**
 * Runs code in per-language Docker containers. Every container is sandboxed:
 * no network, an unprivileged user, no capabilities, and hard memory, CPU,
 * process and file-size limits.
 *
 * @param {object} options
 * @param {string} options.owner Labels containers so orphan cleanup only ever
 *   touches containers created by this backend instance.
 * @param {number} [options.cpus]
 * @param {string} [options.runtime] Alternative OCI runtime, e.g. `runsc`.
 * @param {Docker} [options.docker]
 */
export function createDockerDriver({ owner, cpus = 2, runtime, docker = new Docker() }) {
  return {
    async ping() {
      try {
        await docker.ping()
        return true
      } catch {
        return false
      }
    },

    /** Languages whose runner image has been built. Throws if Docker is down. */
    async listImages() {
      const images = await docker.listImages({
        filters: JSON.stringify({ label: [IMAGE_LABEL] })
      })
      const built = new Set()
      for (const image of images) {
        const language = image.Labels?.[IMAGE_LABEL]
        if (language && (image.RepoTags ?? []).includes(imageFor(language))) {
          built.add(language)
        }
      }
      return built
    },

    async start(language) {
      const spec = RUNNER_LANGUAGES[language]
      const memory = spec.memoryMb * 1024 * 1024

      const container = await docker.createContainer({
        Image: imageFor(language),
        User: `${RUNNER_UID}:${RUNNER_UID}`,
        WorkingDir: '/workspace',
        NetworkDisabled: true,
        Labels: {
          [MANAGED_LABEL]: 'true',
          [OWNER_LABEL]: owner,
          [LANGUAGE_LABEL]: language
        },
        HostConfig: {
          NetworkMode: 'none',
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Init: true,
          Memory: memory,
          MemorySwap: memory,
          NanoCpus: Math.round(cpus * 1e9),
          PidsLimit: spec.pids,
          Ulimits: [
            { Name: 'nofile', Soft: 1024, Hard: 1024 },
            { Name: 'fsize', Soft: MAX_FILE_BYTES, Hard: MAX_FILE_BYTES }
          ],
          Tmpfs: { '/tmp': 'rw,exec,nosuid,size=128m' },
          ...(runtime ? { Runtime: runtime } : {})
        }
      })

      try {
        await container.start()
      } catch (err) {
        await container.remove({ force: true }).catch(() => {})
        throw err
      }

      return { id: container.id, language }
    },

    /**
     * Uploads the source and stdin, runs the image's `run` script and collects
     * its output. Stdin is delivered as a file rather than streamed, because
     * half-closing an attached stream is unreliable over Windows named pipes.
     */
    async execute(handle, { source, stdin = '', timeoutMs, maxOutputBytes }) {
      const spec = RUNNER_LANGUAGES[handle.language]
      const container = docker.getContainer(handle.id)

      const archive = await packFiles({ [spec.source]: source, 'input.txt': stdin })
      await container.putArchive(archive, { path: '/workspace' })

      const exec = await container.exec({
        Cmd: ['/usr/local/bin/run'],
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: `${RUNNER_UID}:${RUNNER_UID}`,
        WorkingDir: '/workspace'
      })
      const stream = await exec.start({ hijack: true, stdin: false })

      const stdout = createCollector(maxOutputBytes)
      const stderr = createCollector(maxOutputBytes)
      let timedOut = false
      let flooded = false

      const kill = () => container.kill().catch(() => {})

      const stdoutSink = new PassThrough()
      const stderrSink = new PassThrough()
      const onChunk = (collector) => (chunk) => {
        collector.push(chunk)
        if (!flooded && stdout.dropped + stderr.dropped > FLOOD_BYTES) {
          flooded = true
          kill()
        }
      }
      stdoutSink.on('data', onChunk(stdout))
      stderrSink.on('data', onChunk(stderr))
      docker.modem.demuxStream(stream, stdoutSink, stderrSink)

      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true
          kill()
        }, timeoutMs)
        // Last resort if the stream never ends even after the kill.
        const backstop = setTimeout(() => {
          stream.destroy()
          resolve()
        }, timeoutMs + 5000)

        const done = () => {
          clearTimeout(timer)
          clearTimeout(backstop)
          resolve()
        }
        stream.once('end', done)
        stream.once('close', done)
        stream.once('error', done)
      })

      // The stream can end a moment before Docker records the exit code.
      let exitCode = null
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const info = await exec.inspect().catch(() => null)
        if (!info || !info.Running) {
          exitCode = info?.ExitCode ?? null
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      return {
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.dropped > 0,
        stderrTruncated: stderr.dropped > 0,
        exitCode,
        timedOut,
        flooded
      }
    },

    async destroy(handle) {
      try {
        await docker.getContainer(handle.id).remove({ force: true })
      } catch (err) {
        if (!isGone(err)) throw err
      }
    },

    /** Removes containers this backend instance left behind, e.g. after a crash. */
    async removeOrphans() {
      const containers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`, `${OWNER_LABEL}=${owner}`] })
      })
      await Promise.all(
        containers.map((info) =>
          docker
            .getContainer(info.Id)
            .remove({ force: true })
            .catch((err) => {
              if (!isGone(err)) throw err
            })
        )
      )
      return containers.length
    }
  }
}

/** Used when `RUNNER_DRIVER=none`, e.g. for tests or hosts without Docker. */
export function createDisabledDriver() {
  const disabled = async () => {
    throw new RunnerError('Code execution is disabled on this server (RUNNER_DRIVER=none)', 503)
  }
  return {
    ping: async () => false,
    listImages: disabled,
    start: disabled,
    execute: disabled,
    destroy: async () => {},
    removeOrphans: async () => 0
  }
}
