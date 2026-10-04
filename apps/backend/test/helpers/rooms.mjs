import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

export async function waitFor(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** Creates a room through the API, as the app does. */
export async function createRoom(httpUrl, name = 'Host') {
  const response = await fetch(`${httpUrl}/api/room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  if (response.status !== 201) throw new Error(`createRoom failed: HTTP ${response.status}`)
  return response.json()
}

/**
 * A collaboration client speaking the browser's protocol. BroadcastChannel is
 * off so clients in one process must sync through the server.
 */
export function connect(wsUrl, roomId, token) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(wsUrl, `room-${roomId}`, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: token ? { token } : {}
  })
  const closes = []
  provider.on('connection-close', (event) => {
    if (event) closes.push(event.code)
  })
  return {
    doc,
    provider,
    closes,
    text: doc.getText('monaco'),
    meta: doc.getMap('meta'),
    execution: doc.getMap('execution'),
    destroy() {
      provider.destroy()
      doc.destroy()
    }
  }
}

/** Opens a raw WebSocket to `path` and resolves with how the server closed it. */
export function closeCodeFor(wsUrl, path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/${path}`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`no close for ${path}`))
    }, 5000)
    ws.addEventListener('close', (event) => {
      clearTimeout(timer)
      resolve({ code: event.code, reason: event.reason })
    })
  })
}

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

/** Runs the whole guest flow: ask, get admitted by the host, collect a token. */
export async function admitGuest(httpUrl, roomId, hostToken, name = 'Guest') {
  const requested = await fetch(`${httpUrl}/api/room/${roomId}/join-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  const { requestId, requestSecret } = await requested.json()

  const admitted = await fetch(`${httpUrl}/api/room/${roomId}/join-requests/${requestId}/admit`, {
    method: 'POST',
    headers: authHeaders(hostToken)
  })
  if (!admitted.ok) throw new Error(`admit failed: HTTP ${admitted.status}`)

  const poll = await fetch(`${httpUrl}/api/room/${roomId}/join-requests/${requestId}`, {
    headers: authHeaders(requestSecret)
  })
  const { token, memberId } = await poll.json()
  return { token, memberId }
}
