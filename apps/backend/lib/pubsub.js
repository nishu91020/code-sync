import { randomUUID } from 'node:crypto'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

/**
 * Cross-instance message fan-out.
 *
 * A room's `Y.Doc` lives in the memory of whichever backend instance a client
 * happened to connect to. With more than one instance, two collaborators can
 * land on different ones and would never see each other. Each instance
 * therefore publishes every local update on `codesync:room:<docName>` and
 * applies what the others publish, which is enough for the CRDT to converge:
 * Yjs updates are commutative and idempotent, so out-of-order or repeated
 * delivery is harmless and no ordering guarantee is required of the broker.
 *
 * A pub/sub adapter exposes:
 *   instanceId                              a unique id for this process
 *   isClustered                             whether other instances may exist
 *   publish(channel, kind, payload)  -> Promise<void>
 *   subscribe(channel, handler)      -> Promise<void>   handler(kind, payload)
 *   unsubscribe(channel)             -> Promise<void>
 *   close()                          -> Promise<void>
 *
 * Without REDIS_URL the local adapter is used: publishing is a no-op, because
 * a single instance already reaches every client it serves.
 */

export const CHANNEL_PREFIX = 'codesync:room:'

/** What a fan-out frame carries. */
export const PUBSUB_UPDATE = 0
export const PUBSUB_AWARENESS = 1
// A newly resident room asks peers for anything it is missing, because another
// instance may hold edits that are still inside their save debounce.
export const PUBSUB_SYNC_REQUEST = 2
export const PUBSUB_SYNC_RESPONSE = 3

export const channelFor = (docName) => `${CHANNEL_PREFIX}${docName}`

/**
 * Frames carry the sender's instance id, because Redis delivers a published
 * message to every subscriber including the one that sent it.
 */
export function encodeFrame(instanceId, kind, payload) {
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, instanceId)
  encoding.writeVarUint(encoder, kind)
  encoding.writeVarUint8Array(encoder, payload)
  return Buffer.from(encoding.toUint8Array(encoder))
}

export function decodeFrame(frame) {
  const decoder = decoding.createDecoder(new Uint8Array(frame))
  return {
    instanceId: decoding.readVarString(decoder),
    kind: decoding.readVarUint(decoder),
    payload: decoding.readVarUint8Array(decoder)
  }
}

/** Single-instance adapter: nothing to fan out to. */
export function createLocalPubSub({ instanceId = randomUUID() } = {}) {
  return {
    name: 'local',
    isClustered: false,
    instanceId,
    redis: null,
    async publish() {},
    async subscribe() {},
    async unsubscribe() {},
    async close() {}
  }
}

/**
 * Redis-backed adapter. Two connections are used because a Redis connection in
 * subscriber mode cannot issue ordinary commands such as PUBLISH.
 */
export function createRedisPubSub({ publisher, subscriber, instanceId = randomUUID(), log = console }) {
  /** @type {Map<string, (kind: number, payload: Uint8Array) => void>} */
  const handlers = new Map()

  return {
    name: 'redis',
    isClustered: true,
    instanceId,
    // Exposed so other subsystems (the rate limiter) can share the connection
    // rather than opening another one.
    redis: publisher,

    async publish(channel, kind, payload) {
      await publisher.publish(channel, encodeFrame(instanceId, kind, payload))
    },

    async subscribe(channel, handler) {
      if (handlers.has(channel)) return
      handlers.set(channel, handler)
      await subscriber.subscribe(
        channel,
        (message) => {
          let frame
          try {
            frame = decodeFrame(message)
          } catch (err) {
            log.error?.('Discarded malformed pub/sub frame:', err.message)
            return
          }
          if (frame.instanceId === instanceId) return
          try {
            handler(frame.kind, frame.payload)
          } catch (err) {
            log.error?.(`Pub/sub handler failed for ${channel}:`, err.message)
          }
        },
        // Deliver Buffers rather than UTF-8 strings; these frames are binary.
        true
      )
    },

    async unsubscribe(channel) {
      if (!handlers.delete(channel)) return
      await subscriber.unsubscribe(channel).catch(() => {})
    },

    async close() {
      handlers.clear()
      await Promise.allSettled([publisher.quit(), subscriber.quit()])
    }
  }
}

/**
 * Builds the adapter appropriate for the current environment. Falls back to
 * the local adapter when Redis is not configured or cannot be reached, so a
 * single-instance deployment keeps working exactly as before.
 */
export async function createPubSub({ redisUrl = process.env.REDIS_URL, instanceId } = {}) {
  if (!redisUrl) {
    console.log('📡 Fan-out: single instance (set REDIS_URL to run several)')
    return createLocalPubSub({ instanceId })
  }

  try {
    const { createClient } = await import('redis')
    const publisher = createClient({ url: redisUrl })
    publisher.on('error', (err) => console.error('Redis publisher error:', err.message))
    await publisher.connect()

    const subscriber = publisher.duplicate()
    subscriber.on('error', (err) => console.error('Redis subscriber error:', err.message))
    await subscriber.connect()

    console.log('📡 Fan-out: Redis pub/sub')
    return createRedisPubSub({ publisher, subscriber, instanceId })
  } catch (err) {
    console.error('⚠️  Falling back to single-instance fan-out:', err.message)
    return createLocalPubSub({ instanceId })
  }
}
