import { buildHint, isRunnable, runnableLanguages } from './languages.js'
import { RunnerError } from './errors.js'

/**
 * Keeps per-language runner containers warm while some room has that language
 * selected, and hands out a fresh container for every run.
 *
 * Lifecycle of one language:
 *
 *   demand 0→1      start one idle ("warm") container
 *   run             take the warm container, start its replacement, execute,
 *                   then destroy the used container
 *   demand →0       after `idleMs`, destroy the warm container
 *
 * No container ever serves two runs, so nothing leaks between rooms or users.
 */
export class RunnerPool {
  #driver
  #idleMs
  #maxContainers
  #imageCacheMs
  #log

  #images = new Set()
  #imagesAt = 0
  #imagesPromise = null
  #dockerReachable = null
  #dockerError = null

  /** Containers created and not yet destroyed, including ones still starting. */
  #live = 0

  /** @type {Map<string, { demand: number, warm: object|null, warming: Promise|null, idleTimer: NodeJS.Timeout|null, error: string|null }>} */
  #slots = new Map()

  constructor({ driver, idleMs = 5 * 60 * 1000, maxContainers = 6, imageCacheMs = 5000, log = console }) {
    this.#driver = driver
    this.#idleMs = idleMs
    this.#maxContainers = maxContainers
    this.#imageCacheMs = imageCacheMs
    this.#log = log
  }

  #slot(language) {
    let slot = this.#slots.get(language)
    if (!slot) {
      slot = { demand: 0, warm: null, warming: null, idleTimer: null, error: null }
      this.#slots.set(language, slot)
    }
    return slot
  }

  /**
   * Which runner images exist. Cached briefly, so a freshly built image is
   * picked up within seconds without restarting the backend.
   */
  async refreshImages({ force = false } = {}) {
    const fresh = Date.now() - this.#imagesAt < this.#imageCacheMs
    if (!force && this.#dockerReachable !== null && fresh) return this.#images
    if (this.#imagesPromise) return this.#imagesPromise

    this.#imagesPromise = (async () => {
      try {
        this.#images = await this.#driver.listImages()
        this.#dockerReachable = true
        this.#dockerError = null
      } catch (err) {
        this.#images = new Set()
        this.#dockerReachable = false
        this.#dockerError =
          err instanceof RunnerError ? err.message : "Docker isn't reachable from the backend"
      }
      this.#imagesAt = Date.now()

      // A language may be wanted but not warm because its image was missing,
      // Docker was down, or a start failed. Retry now that things may differ.
      if (this.#dockerReachable) {
        for (const [language, slot] of this.#slots) {
          if (slot.demand > 0 && this.#images.has(language)) this.#ensureWarm(language)
        }
      }
      return this.#images
    })().finally(() => {
      this.#imagesPromise = null
    })
    return this.#imagesPromise
  }

  #stateOf(language) {
    if (!this.#dockerReachable) return 'unavailable'
    if (!this.#images.has(language)) return 'missing'
    const slot = this.#slots.get(language)
    if (slot?.warm) return 'ready'
    if (slot?.warming) return 'starting'
    if (slot?.error) return 'error'
    return 'cold'
  }

  async status() {
    await this.refreshImages()
    const runtimes = {}
    for (const language of runnableLanguages) {
      const state = this.#stateOf(language)
      const slot = this.#slots.get(language)
      runtimes[language] = state === 'error' ? { state, message: slot.error } : { state }
    }
    return {
      dockerReachable: this.#dockerReachable,
      ...(this.#dockerReachable ? {} : { message: this.#dockerError }),
      available: runnableLanguages.filter((language) => this.#images.has(language)),
      runtimes
    }
  }

  demandFor(language) {
    return this.#slots.get(language)?.demand ?? 0
  }

  get liveContainers() {
    return this.#live
  }

  /** A room started using `language`. */
  addDemand(language) {
    if (!isRunnable(language)) return
    const slot = this.#slot(language)
    slot.demand += 1
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer)
      slot.idleTimer = null
    }
    this.#ensureWarm(language)
  }

  /** A room stopped using `language` (switched away, or everyone left). */
  removeDemand(language) {
    if (!isRunnable(language)) return
    const slot = this.#slot(language)
    slot.demand = Math.max(0, slot.demand - 1)
    if (slot.demand === 0) this.#scheduleIdle(language)
  }

  #scheduleIdle(language) {
    const slot = this.#slot(language)
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null
      if (slot.demand > 0) return
      const handle = slot.warm
      slot.warm = null
      slot.error = null
      if (handle) {
        this.#log.log?.(`💤 Stopped idle ${language} runner`)
        this.#destroy(handle)
      }
    }, this.#idleMs)
    slot.idleTimer.unref?.()
  }

  #ensureWarm(language) {
    const slot = this.#slot(language)
    if (slot.warm || slot.warming || slot.demand === 0) return
    // At capacity: a replacement is warmed when a running container is freed.
    if (!this.#hasRoom({ evict: false })) return

    slot.warming = (async () => {
      let images = await this.refreshImages()
      if (!images.has(language)) images = await this.refreshImages({ force: true })
      if (!images.has(language)) return null

      const handle = await this.#start(language)

      // Demand vanished and its idle period already elapsed while starting.
      if (slot.demand === 0 && slot.idleTimer === null) {
        this.#destroy(handle)
        return null
      }
      slot.warm = handle
      slot.error = null
      this.#log.log?.(`🔥 Warmed ${language} runner`)
      return handle
    })()
      .catch((err) => {
        slot.error = err.message
        this.#log.error?.(`Failed to warm ${language} runner:`, err.message)
        return null
      })
      .finally(() => {
        slot.warming = null
      })
  }

  /**
   * Whether another container may be created. A warm container for a language
   * nobody currently uses (it is only waiting out its idle period) is given up
   * to make room, so idle leftovers never block a real run.
   */
  #hasRoom({ evict = true } = {}) {
    if (this.#live < this.#maxContainers) return true

    for (const [language, slot] of this.#slots) {
      if (slot.demand === 0 && slot.warm) {
        if (!evict) return true
        const handle = slot.warm
        slot.warm = null
        if (slot.idleTimer) {
          clearTimeout(slot.idleTimer)
          slot.idleTimer = null
        }
        this.#log.log?.(`♻️  Evicted idle ${language} runner to make room`)
        this.#destroy(handle)
        return true
      }
    }
    return false
  }

  async #start(language) {
    if (!this.#hasRoom()) {
      throw new RunnerError('All code runners are busy. Try again in a moment.', 503)
    }
    this.#live += 1
    try {
      return await this.#driver.start(language)
    } catch (err) {
      this.#live -= 1
      // Often the image was removed since it was last listed; re-check it.
      this.#imagesAt = 0
      throw new RunnerError(`Could not start the ${language} runner: ${err.message}`, 503)
    }
  }

  async #destroy(handle) {
    // Counted out immediately so the capacity it frees is usable right away.
    this.#live -= 1
    try {
      await this.#driver.destroy(handle)
    } catch (err) {
      this.#log.error?.(`Failed to remove ${handle.language} runner ${handle.id}:`, err.message)
    }
  }

  /** Hands out a container for one run; the caller must `release` it. */
  async acquire(language) {
    if (!isRunnable(language)) {
      throw new RunnerError(`Language "${language}" cannot be executed`, 400)
    }

    let images = await this.refreshImages()
    if (!this.#dockerReachable) throw new RunnerError(this.#dockerError, 503)
    if (!images.has(language)) images = await this.refreshImages({ force: true })
    if (!images.has(language)) {
      throw new RunnerError(
        `The ${language} runner image isn't built yet. Run \`${buildHint(language)}\`.`,
        409
      )
    }

    const slot = this.#slot(language)
    if (!slot.warm && slot.warming) await slot.warming

    let handle = slot.warm
    if (handle) {
      slot.warm = null
    } else {
      handle = await this.#start(language)
    }

    // Warm the replacement while this run executes, so the next one is instant.
    this.#ensureWarm(language)
    return handle
  }

  /** Destroys a used container and, if still wanted, warms another. */
  async release(handle) {
    await this.#destroy(handle)
    this.#ensureWarm(handle.language)
  }

  async run(language, options) {
    const handle = await this.acquire(language)
    try {
      return await this.#driver.execute(handle, options)
    } finally {
      // Not awaited: removing the container should not delay the result.
      this.release(handle)
    }
  }

  removeOrphans() {
    return this.#driver.removeOrphans()
  }

  /** Stops every timer and removes every container this instance created. */
  async shutdown() {
    for (const slot of this.#slots.values()) {
      if (slot.idleTimer) clearTimeout(slot.idleTimer)
      slot.idleTimer = null
      slot.demand = 0
    }
    await Promise.allSettled(
      Array.from(this.#slots.values(), (slot) => slot.warming).filter(Boolean)
    )
    await this.#driver.removeOrphans()
  }
}
