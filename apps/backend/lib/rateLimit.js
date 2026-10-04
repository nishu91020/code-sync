/**
 * Minimal fixed-window rate limiter kept in process memory.
 *
 * Good enough for a single backend instance; a multi-instance deployment
 * should move this into Redis alongside the pub/sub fan-out.
 */
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map()

  function sweep(now) {
    hits.forEach((entry, key) => {
      if (entry.resetAt <= now) hits.delete(key)
    })
  }

  return {
    /**
     * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
     */
    check(key) {
      const now = Date.now()
      if (hits.size > 1000) sweep(now)

      const entry = hits.get(key)
      if (entry === undefined || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs })
        return { allowed: true, remaining: limit - 1, retryAfterMs: 0 }
      }

      if (entry.count >= limit) {
        return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now }
      }

      entry.count += 1
      return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0 }
    },

    reset() {
      hits.clear()
    }
  }
}
