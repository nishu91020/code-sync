import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import { createMemoryStorage } from './storage.js'
import {
  PUBSUB_AWARENESS,
  PUBSUB_SYNC_REQUEST,
  PUBSUB_SYNC_RESPONSE,
  PUBSUB_UPDATE,
  channelFor,
  createLocalPubSub
} from './pubsub.js'

// Message types defined by the y-websocket wire protocol. These must stay in
// sync with the `y-websocket` client package.
export const messageSync = 0
export const messageAwareness = 1
export const messageQueryAwareness = 3

const PING_INTERVAL = 30000

// How long an empty room is kept in memory before it is evicted. Keeping the
// document around lets a user reload the page without losing the room content.
const EMPTY_ROOM_TTL = 30 * 60 * 1000

// Snapshots are debounced so that a burst of keystrokes results in one write.
const SAVE_DEBOUNCE = Number(process.env.SAVE_DEBOUNCE_MS || 5000)

// Marks updates that came from storage so they are not written straight back.
const PERSISTENCE_ORIGIN = Symbol('persistence')

// Marks updates that arrived from another backend instance, so they are not
// published again (which would bounce between instances forever).
const REMOTE_ORIGIN = Symbol('remote')

const WS_CONNECTING = 0
const WS_OPEN = 1

/** @type {Map<string, WSSharedDoc>} */
const docs = new Map()

/**
 * Room lifecycle notifications, kept generic so other subsystems can react to
 * rooms without this module knowing about them:
 *
 * - `active`   (doc) the first client connected and the room is hydrated
 * - `inactive` (doc) the last client disconnected
 */
export const roomEvents = new EventEmitter()

let storage = createMemoryStorage()

let pubsub = createLocalPubSub()

/** Swaps in the storage adapter used for every subsequently loaded room. */
export function setStorage(nextStorage) {
  storage = nextStorage
}

/** Swaps in the fan-out adapter used for every subsequently loaded room. */
export function setPubSub(nextPubSub) {
  pubsub = nextPubSub
}

export class WSSharedDoc extends Y.Doc {
  /** @param {string} name */
  constructor(name) {
    super({ gc: true })
    this.name = name

    /**
     * Maps every connection to the set of awareness client ids it controls, so
     * that those ids can be cleared when the connection drops.
     * @type {Map<import('ws').WebSocket, Set<number>>}
     */
    this.conns = new Map()

    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)

    this.evictionTimer = null
    this.saveTimer = null
    this.isDirty = false
    this.isActive = false
    this.storage = storage
    this.pubsub = pubsub
    this.channel = channelFor(name)

    this.whenLoaded = this.#hydrate()
    this.whenSubscribed = this.#subscribe()

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated, removed)
      const controlledIds = this.conns.get(origin)
      if (controlledIds !== undefined) {
        added.forEach((clientId) => controlledIds.add(clientId))
        removed.forEach((clientId) => controlledIds.delete(clientId))
      }

      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)

      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, update)
      this.broadcast(encoding.toUint8Array(encoder))

      // Presence must reach clients served by other instances too.
      if (origin !== REMOTE_ORIGIN) this.#publish(PUBSUB_AWARENESS, update)
    })

    this.on('update', (update, origin) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      this.broadcast(encoding.toUint8Array(encoder))

      if (origin !== PERSISTENCE_ORIGIN) {
        this.#markDirty()
      }
      // Hydration is local to this instance, and a remote update must not be
      // echoed back to the instance it came from.
      if (origin !== PERSISTENCE_ORIGIN && origin !== REMOTE_ORIGIN) {
        this.#publish(PUBSUB_UPDATE, update)
      }
    })
  }

  /** Fire-and-forget: a broker hiccup must never break local editing. */
  #publish(kind, payload) {
    if (!this.pubsub.isClustered) return
    this.pubsub
      .publish(this.channel, kind, payload)
      .catch((err) => console.error(`Failed to publish ${this.name}:`, err.message))
  }

  /** Applies what other instances publish for this room. */
  async #subscribe() {
    if (!this.pubsub.isClustered) return
    try {
      await this.pubsub.subscribe(this.channel, (kind, payload) => {
        switch (kind) {
          case PUBSUB_UPDATE:
          case PUBSUB_SYNC_RESPONSE:
            Y.applyUpdate(this, payload, REMOTE_ORIGIN)
            break

          case PUBSUB_AWARENESS:
            awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, REMOTE_ORIGIN)
            break

          case PUBSUB_SYNC_REQUEST: {
            // Answer with only what the asking instance is missing. Everyone
            // on the channel applies it, which is harmless: Yjs updates are
            // idempotent, so peers that already have it are unaffected.
            const diff = Y.encodeStateAsUpdate(this, payload)
            if (diff.byteLength > 0) this.#publish(PUBSUB_SYNC_RESPONSE, diff)
            break
          }

          default:
            break
        }
      })
    } catch (err) {
      console.error(`Failed to subscribe to ${this.channel}:`, err.message)
      return
    }

    // The snapshot may lag a peer that is still inside its save debounce, so
    // ask for the difference rather than trusting storage alone.
    await this.whenLoaded
    this.#publish(PUBSUB_SYNC_REQUEST, Y.encodeStateVector(this))
  }

  async #hydrate() {
    try {
      const stored = await this.storage.load(this.name)
      if (stored && stored.byteLength > 0) {
        Y.applyUpdate(this, stored, PERSISTENCE_ORIGIN)
      }
    } catch (err) {
      console.error(`Failed to load room ${this.name}:`, err)
    }
  }

  #markDirty() {
    this.isDirty = true
    if (this.saveTimer !== null) return

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush().catch((err) => console.error(`Failed to save room ${this.name}:`, err))
    }, SAVE_DEBOUNCE)
    this.saveTimer.unref?.()
  }

  /** Writes the current document state to storage if anything changed. */
  async flush() {
    if (!this.isDirty) return

    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    // Cleared before the await so concurrent edits re-mark the document.
    this.isDirty = false
    try {
      await this.storage.save(this.name, Y.encodeStateAsUpdate(this), {
        // With several instances the same room is flushed from more than one
        // of them. Merging makes those writes commutative, so a slower
        // instance cannot overwrite a newer snapshot with its own.
        merge: this.pubsub.isClustered
      })
    } catch (err) {
      this.isDirty = true
      throw err
    }
  }

  /** @param {Uint8Array} message */
  broadcast(message) {
    this.conns.forEach((_ids, conn) => send(this, conn, message))
  }
}


/**
 * @param {string} name
 * @returns {WSSharedDoc}
 */
export function getYDoc(name) {
  let doc = docs.get(name)
  if (doc === undefined) {
    doc = new WSSharedDoc(name)
    docs.set(name, doc)
  }
  return doc
}

export function hasYDoc(name) {
  return docs.has(name)
}

export function roomStats() {
  return {
    rooms: docs.size,
    connections: Array.from(docs.values()).reduce((total, doc) => total + doc.conns.size, 0)
  }
}

function scheduleEviction(doc) {
  cancelEviction(doc)
  doc.evictionTimer = setTimeout(async () => {
    if (doc.conns.size !== 0 || docs.get(doc.name) !== doc) return

    try {
      await doc.flush()
    } catch (err) {
      console.error(`Failed to save room ${doc.name} before eviction:`, err)
    }

    // Re-check: a client may have joined while the snapshot was being written.
    if (doc.conns.size === 0 && docs.get(doc.name) === doc) {
      docs.delete(doc.name)
      await doc.pubsub.unsubscribe(doc.channel).catch(() => {})
      doc.destroy()
      console.log(`🧹 Evicted idle room: ${doc.name}`)
    }
  }, EMPTY_ROOM_TTL)
  // Do not hold the event loop open just to evict an empty room.
  doc.evictionTimer.unref?.()
}

function cancelEviction(doc) {
  if (doc.evictionTimer !== null) {
    clearTimeout(doc.evictionTimer)
    doc.evictionTimer = null
  }
}

/** A misbehaving listener must never break the connection handling. */
function emitRoomEvent(event, doc) {
  try {
    roomEvents.emit(event, doc)
  } catch (err) {
    console.error(`Room ${event} listener failed for ${doc.name}:`, err)
  }
}

/**
 * @param {WSSharedDoc} doc
 * @param {import('ws').WebSocket} conn
 * @param {Uint8Array} message
 */
function send(doc, conn, message) {
  if (conn.readyState !== WS_CONNECTING && conn.readyState !== WS_OPEN) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(message, (err) => {
      if (err != null) {
        closeConn(doc, conn)
      }
    })
  } catch (err) {
    closeConn(doc, conn)
  }
}

/**
 * @param {WSSharedDoc} doc
 * @param {import('ws').WebSocket} conn
 */
function closeConn(doc, conn) {
  const controlledIds = doc.conns.get(conn)
  if (controlledIds !== undefined) {
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
    if (doc.conns.size === 0) {
      // Snapshot immediately so an empty room survives a restart.
      doc.flush().catch((err) => console.error(`Failed to save room ${doc.name}:`, err))
      scheduleEviction(doc)
      if (doc.isActive) {
        doc.isActive = false
        emitRoomEvent('inactive', doc)
      }
    }
  }
  conn.close()
}

/**
 * @param {import('ws').WebSocket} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
function messageListener(conn, doc, message) {
  const encoder = encoding.createEncoder()
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)

  switch (messageType) {
    case messageSync:
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
      // An encoder holding only the message type carries no payload to send.
      if (encoding.length(encoder) > 1) {
        send(doc, conn, encoding.toUint8Array(encoder))
      }
      break

    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(
        doc.awareness,
        decoding.readVarUint8Array(decoder),
        conn
      )
      break

    case messageQueryAwareness: {
      const states = Array.from(doc.awareness.getStates().keys())
      if (states.length === 0) break
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, states)
      )
      send(doc, conn, encoding.toUint8Array(encoder))
      break
    }

    default:
      console.warn(`Unknown message type ${messageType} in room ${doc.name}`)
  }
}

/**
 * Wires a freshly upgraded WebSocket into the shared document for `docName`.
 *
 * @param {import('ws').WebSocket} conn
 * @param {string} docName
 */
export function setupWSConnection(conn, docName) {
  conn.binaryType = 'arraybuffer'

  const doc = getYDoc(docName)
  cancelEviction(doc)
  doc.conns.set(conn, new Set())

  return startConnection(conn, doc, docName)
}

async function startConnection(conn, doc, docName) {
  let pongReceived = true
  const pingTimer = setInterval(() => {
    if (!doc.conns.has(conn)) {
      clearInterval(pingTimer)
      return
    }
    if (!pongReceived) {
      clearInterval(pingTimer)
      closeConn(doc, conn)
      return
    }
    pongReceived = false
    try {
      conn.ping()
    } catch (err) {
      clearInterval(pingTimer)
      closeConn(doc, conn)
    }
  }, PING_INTERVAL)
  pingTimer.unref?.()

  conn.on('pong', () => {
    pongReceived = true
  })

  conn.on('message', (data) => {
    try {
      messageListener(conn, doc, new Uint8Array(data))
    } catch (err) {
      console.error(`Message error in room ${docName}:`, err)
    }
  })

  conn.on('close', () => {
    clearInterval(pingTimer)
    closeConn(doc, conn)
  })

  conn.on('error', (err) => {
    console.error(`WebSocket error in room ${docName}:`, err)
  })

  // Wait for any persisted snapshot so the client is not briefly shown an
  // empty document. Incoming client updates are already being applied and will
  // merge with the loaded state. The peer sync request goes out with it, so a
  // room another instance already holds arrives up to date.
  await doc.whenLoaded
  await doc.whenSubscribed

  if (!doc.conns.has(conn)) return

  // Announced only after hydration, so listeners see the stored room state.
  if (!doc.isActive) {
    doc.isActive = true
    emitRoomEvent('active', doc)
  }

  // Step 1 of the sync handshake: advertise our state vector.
  const syncEncoder = encoding.createEncoder()
  encoding.writeVarUint(syncEncoder, messageSync)
  syncProtocol.writeSyncStep1(syncEncoder, doc)
  send(doc, conn, encoding.toUint8Array(syncEncoder))

  // Hand the newcomer the presence state of everyone already in the room.
  const awarenessStates = doc.awareness.getStates()
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys()))
    )
    send(doc, conn, encoding.toUint8Array(awarenessEncoder))
  }
}

/** Applies a patch to one of a room's shared metadata maps. */
export async function updateRoomState(docName, mapKey, patch) {
  const doc = getYDoc(docName)
  await doc.whenLoaded
  await doc.whenSubscribed
  const map = doc.getMap(mapKey)
  doc.transact(() => {
    Object.entries(patch).forEach(([key, value]) => map.set(key, value))
  })
}

/** Reads a room's shared text, hydrating the room first if necessary. */
export async function getRoomSource(docName, textKey = 'monaco') {
  const doc = getYDoc(docName)
  await doc.whenLoaded
  await doc.whenSubscribed
  return doc.getText(textKey).toString()
}

/** Reads a single value from one of a room's shared metadata maps. */
export async function getRoomState(docName, mapKey, key) {
  const doc = getYDoc(docName)
  await doc.whenLoaded
  await doc.whenSubscribed
  return doc.getMap(mapKey).get(key)
}

/**
 * Closes every live connection to `docName` matching `predicate`, e.g. when the
 * host removes someone. Returns how many were closed.
 *
 * @param {string} docName
 * @param {(conn: import('ws').WebSocket) => boolean} predicate
 * @param {number} code WebSocket close code
 * @param {string} reason
 */
export function closeConnections(docName, predicate, code, reason) {
  const doc = docs.get(docName)
  if (!doc) return 0
  let closed = 0
  for (const conn of Array.from(doc.conns.keys())) {
    if (predicate(conn)) {
      conn.close(code, reason)
      closed += 1
    }
  }
  return closed
}

/** Persists every dirty room. Used on graceful shutdown. */
export async function flushAll() {
  const results = await Promise.allSettled(
    Array.from(docs.values()).map((doc) => doc.flush())
  )
  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.error('Failed to save room during shutdown:', result.reason)
    }
  })
}
