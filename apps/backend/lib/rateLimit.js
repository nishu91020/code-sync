/**
 * Fixed-window rate limiting.
 *
 * With a single instance the counters live in process memory. When Redis is
 * configured the same counters are kept there instead, so a limit means the
 * same thing however many instances are running — otherwise N instances would
 * allow N times the configured rate.
 *
 * `check` is asynchronous in both modes so callers do not have to care which
 * one is in use.
 */

function createMemoryBackend() {
  const hits = new Map()

  function sweep(now) {
    hits.forEach((entry, key) => {
      if (entry.resetAt <= now) hits.delete(key)
    })
  }

  return {
    async hit(key, windowMs) {
      const now = Date.now()
      if (hits.size > 1000) sweep(now)

      const entry = hits.get(key)
      if (entry === undefined || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs })
        return { count: 1, retryAfterMs: windowMs }
      }

      entry.count += 1
      return { count: entry.count, retryAfterMs: entry.resetAt - now }
    },
    async reset() {
      hits.clear()
    }
  }
}

/**
 * INCR creates the key at 1, so the expiry is set only on that first hit and
 * the window then runs from it. PTTL reports what is left of it.
 */
function createRedisBackend(redis, prefix) {
  return {
    async hit(key, windowMs) {
      const namespaced = `${prefix}:${key}`
      const count = await redis.incr(namespaced)
      if (count === 1) await redis.pExpire(namespaced, windowMs)
      const ttl = await redis.pTTL(namespaced)
      return { count, retryAfterMs: ttl > 0 ? ttl : windowMs }
    },
    async reset() {
      const keys = await redis.keys(`${prefix}:*`)
      if (keys.length > 0) await redis.del(keys)
    }
  }
}

/**
 * @param {object} options
 * @param {number} options.limit      hits allowed per window
 * @param {number} options.windowMs
 * @param {object} [options.redis]    a connected node-redis client; omit for in-process counting
 * @param {string} [options.prefix]   Redis key namespace
 */
export function createRateLimiter({ limit, windowMs, redis = null, prefix = 'codesync:rl' }) {
  const backend = redis ? createRedisBackend(redis, prefix) : createMemoryBackend()

  return {
    name: redis ? 'redis' : 'memory',

    /**
     * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>}
     */
    async check(key) {
      let result
      try {
        result = await backend.hit(key, windowMs)
      } catch (err) {
        // A broker problem must not lock everybody out of running code.
        console.error('Rate limiter unavailable, allowing the request:', err.message)
        return { allowed: true, remaining: limit - 1, retryAfterMs: 0 }
      }

      if (result.count > limit) {
        return { allowed: false, remaining: 0, retryAfterMs: result.retryAfterMs }
      }
      return { allowed: true, remaining: limit - result.count, retryAfterMs: 0 }
    },

    reset() {
      return backend.reset()
    }
  }
}
