import 'dotenv/config'
import http from 'http'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'

import {
  roomStats,
  roomEvents,
  setupWSConnection,
  setStorage,
  flushAll,
  updateRoomState,
  getRoomSource,
  getRoomState,
  closeConnections
} from './lib/yjsWebsocket.js'
import { createStorage } from './lib/storage.js'
import {
  AccessError,
  CLOSE_CODES,
  createAccessControl,
  docNameFor,
  roomIdFromDocName
} from './lib/access.js'
import {
  runCode,
  isRunnable,
  runnableLanguages,
  getRunnerPool,
  trackLanguageDemand
} from './lib/runner/index.js'
import { createRateLimiter } from './lib/rateLimit.js'

const PORT = Number(process.env.PORT || 3001)
const MAX_WS_PAYLOAD = 10 * 1024 * 1024

const runLimiter = createRateLimiter({
  limit: Number(process.env.RUN_RATE_LIMIT || 10),
  windowMs: Number(process.env.RUN_RATE_WINDOW_MS || 60000)
})

// Stops one client from flooding a host with join requests.
const joinLimiter = createRateLimiter({
  limit: Number(process.env.JOIN_RATE_LIMIT || 10),
  windowMs: 60000
})

const storage = await createStorage()
setStorage(storage)
const access = createAccessControl({ storage })

// Each language's runner container exists only while some active room has
// that language selected.
const runnerPool = getRunnerPool()
trackLanguageDemand(roomEvents, runnerPool)
runnerPool
  .removeOrphans()
  .then((count) => {
    if (count > 0) console.log(`🧹 Removed ${count} leftover runner container(s)`)
  })
  .catch(() => {
    // Docker being unavailable is reported through /api/languages instead.
  })

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const allowAllOrigins = allowedOrigins.includes('*')

const app = express()
const server = http.createServer(app)

app.use(helmet())
app.use(morgan('tiny'))
app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, server-to-server) are allowed.
      if (!origin || allowAllOrigins || allowedOrigins.includes(origin)) {
        callback(null, true)
        return
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`))
    }
  })
)
app.use(express.json())

const roomName = docNameFor

function bearerToken(req) {
  const header = req.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match ? match[1] : null
}

/** Express wrapper that forwards async errors to the error handler. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)

/**
 * Requires a valid host or member token for `:roomId`, and attaches who the
 * caller is as `req.principal`. With `role: 'host'`, members are refused.
 */
function requireRoomAccess({ role } = {}) {
  return route(async (req, res, next) => {
    const principal = await access.authenticate(req.params.roomId, bearerToken(req))
    if (role && principal.role !== role) {
      throw new AccessError('Only the host can do that', 403, CLOSE_CODES.forbidden)
    }
    req.principal = principal
    next()
  })
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), ...roomStats() })
})

/** Creates a room. The caller becomes its host and gets the host token once. */
app.post(
  '/api/room',
  route(async (req, res) => {
    const { roomId, hostToken } = await access.createRoom({
      hostName: req.body?.name,
      // Persisted immediately so the room resolves after a restart even if
      // nobody has typed in it yet.
      update: Y.encodeStateAsUpdate(new Y.Doc())
    })
    console.log(`🆕 Room created: ${roomId}`)
    res.status(201).json({ roomId, hostToken })
  })
)

/** Public: whether a room exists and can be joined. Reveals nothing else. */
app.get(
  '/api/room/:roomId',
  route(async (req, res) => {
    const { roomId } = req.params
    res.json({ roomId, ...(await access.describeRoom(roomId)) })
  })
)

/** Who the presented token belongs to, so the app can check before connecting. */
app.get(
  '/api/room/:roomId/me',
  requireRoomAccess(),
  (req, res) => {
    const { role, name, memberId } = req.principal
    res.json({ role, name, memberId })
  }
)

/** A guest asks the host to let them in. */
app.post(
  '/api/room/:roomId/join-requests',
  route(async (req, res) => {
    const { allowed, retryAfterMs } = joinLimiter.check(`join:${req.ip}`)
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
      res.status(429).json({ error: 'Too many join requests. Try again shortly.' })
      return
    }
    const request = await access.requestToJoin(req.params.roomId, {
      name: req.body?.name,
      color: req.body?.color
    })
    res.status(202).json(request)
  })
)

/** The waiting guest polls this with their request secret. */
app.get(
  '/api/room/:roomId/join-requests/:requestId',
  route(async (req, res) => {
    const { roomId, requestId } = req.params
    res.set('Cache-Control', 'no-store')
    res.json(access.pollRequest(roomId, requestId, bearerToken(req)))
  })
)

app.delete(
  '/api/room/:roomId/join-requests/:requestId',
  route(async (req, res) => {
    const { roomId, requestId } = req.params
    access.cancelRequest(roomId, requestId, bearerToken(req))
    res.status(204).end()
  })
)

/** Host only: pending requests and admitted members. */
app.get(
  '/api/room/:roomId/access',
  requireRoomAccess({ role: 'host' }),
  route(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await access.listAccess(req.params.roomId))
  })
)

app.post(
  '/api/room/:roomId/join-requests/:requestId/admit',
  requireRoomAccess({ role: 'host' }),
  route(async (req, res) => {
    const { roomId, requestId } = req.params
    const member = await access.admit(roomId, requestId)
    console.log(`✅ Admitted ${member.name} to room ${roomId}`)
    res.json(member)
  })
)

app.post(
  '/api/room/:roomId/join-requests/:requestId/deny',
  requireRoomAccess({ role: 'host' }),
  route(async (req, res) => {
    const { roomId, requestId } = req.params
    access.deny(roomId, requestId)
    res.status(204).end()
  })
)

/** Host only: revokes a member and disconnects them immediately. */
app.delete(
  '/api/room/:roomId/members/:memberId',
  requireRoomAccess({ role: 'host' }),
  route(async (req, res) => {
    const { roomId, memberId } = req.params
    await access.removeMember(roomId, memberId)
    closeConnections(
      roomName(roomId),
      (conn) => conn.principal?.memberId === memberId,
      CLOSE_CODES.forbidden,
      'Removed by the host'
    )
    console.log(`🚪 Removed member ${memberId} from room ${roomId}`)
    res.status(204).end()
  })
)

/**
 * Which languages can run, and the state of each one's runner container:
 * `missing` (image not built), `cold`, `starting`, `ready`, `error`, or
 * `unavailable` when Docker itself cannot be reached.
 */
app.get('/api/languages', async (req, res, next) => {
  try {
    const status = await runnerPool.status()
    res.json({ runnable: runnableLanguages, ...status })
  } catch (err) {
    next(err)
  }
})

/**
 * Runs the room's current code. The source is taken from the server's own copy
 * of the document so every collaborator runs exactly what is on screen, and the
 * result is written back into the shared document so everyone sees it.
 */
app.post('/api/room/:roomId/run', requireRoomAccess(), async (req, res, next) => {
  const { roomId } = req.params
  const docName = roomName(roomId)

  try {
    const language = String(req.body?.language ?? '')
    const stdin = typeof req.body?.stdin === 'string' ? req.body.stdin : ''
    // The server-known name, so nobody can attribute a run to someone else.
    const startedBy = req.principal.name

    if (!isRunnable(language)) {
      res.status(400).json({ error: `Language "${language}" cannot be executed` })
      return
    }

    const { allowed, retryAfterMs } = runLimiter.check(docName)
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
      res.status(429).json({ error: 'Too many runs for this room. Try again shortly.' })
      return
    }

    // Refuse to pile runs on top of each other in the same room.
    if ((await getRoomState(docName, 'execution', 'status')) === 'running') {
      res.status(409).json({ error: 'A run is already in progress for this room' })
      return
    }

    const source = await getRoomSource(docName)

    await updateRoomState(docName, 'execution', {
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
      language,
      startedBy,
      finishedAt: null,
      message: null
    })

    try {
      const result = await runCode({ language, source, stdin })
      await updateRoomState(docName, 'execution', {
        status: 'done',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        finishedAt: Date.now()
      })
      res.json(result)
    } catch (err) {
      const message = err?.message ?? 'Execution failed'
      await updateRoomState(docName, 'execution', {
        status: 'error',
        message,
        finishedAt: Date.now()
      })
      res.status(err?.status ?? 502).json({ error: message })
    }
  } catch (err) {
    next(err)
  }
})

app.use(function fourOhFourHandler(req, res) {
  res.status(404).json({ error: 'Not found' })
})

app.use(function fiveHundredHandler(err, req, res, next) {
  if (err instanceof AccessError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

function isOriginAllowed(origin) {
  return !origin || allowAllOrigins || allowedOrigins.includes(origin)
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })

/**
 * Accepts the WebSocket only to tell the client *why* it is refused. A close
 * code survives into the browser, whereas a rejected HTTP upgrade does not,
 * and the client uses it to stop reconnecting.
 */
function refuse(request, socket, head, code, reason) {
  wss.handleUpgrade(request, socket, head, (ws) => ws.close(code, reason))
}

server.on('upgrade', async (request, socket, head) => {
  if (!isOriginAllowed(request.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }

  let docName = ''
  let token = null
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
    docName = decodeURIComponent(url.pathname.slice(1))
    token = url.searchParams.get('token')
  } catch {
    docName = ''
  }

  // Only `room-<uuid>` names created through the API are accepted. Nothing is
  // loaded or created for anything else.
  const roomId = roomIdFromDocName(docName)
  if (!roomId) {
    refuse(request, socket, head, CLOSE_CODES.invalid, 'Invalid room')
    return
  }

  let principal
  try {
    principal = await access.authenticate(roomId, token)
  } catch (err) {
    if (err instanceof AccessError) {
      refuse(request, socket, head, err.closeCode, err.message.slice(0, 120))
    } else {
      console.error('WebSocket authentication failed:', err)
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
    return
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    // Remembered so the host can disconnect this person if they are removed.
    ws.principal = principal
    setupWSConnection(ws, docName)
    console.log(`🔗 ${principal.role === 'host' ? 'Host' : 'Member'} joined room: ${docName}`)
  })
})

server.listen(PORT, () => {
  console.log(`🚀 HTTP + WebSocket server listening on port ${PORT}`)
  console.log(`   HTTP      http://localhost:${PORT}`)
  console.log(`   WebSocket ws://localhost:${PORT}/<room>`)
  console.log(`   CORS      ${allowedOrigins.join(', ')}`)
})

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} received, saving rooms…`)

  server.closeAllConnections?.()
  server.close()

  try {
    await flushAll()
    await storage.close()
    console.log('✅ Rooms saved')
  } catch (err) {
    console.error('Shutdown error:', err)
  }

  try {
    await runnerPool.shutdown()
    console.log('✅ Runner containers removed')
  } catch (err) {
    console.error('Failed to remove runner containers:', err?.message ?? err)
  }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

export { app, server, storage, runnerPool, access }
