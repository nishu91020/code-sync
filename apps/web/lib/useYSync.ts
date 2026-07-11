import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'

export function useYSync(room: string) {
  const [isConnected, setIsConnected] = useState(false)
  const ydocRef = useRef<Y.Doc | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)

  // Initialize Yjs and WebSocket
  useEffect(() => {
    const ydoc = new Y.Doc()
    ydocRef.current = ydoc

    const wsUrl = `ws://localhost:1234?room=${encodeURIComponent(room)}`
    console.log('[useYSync] Connecting to:', wsUrl)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[useYSync] WebSocket connected')
      // Send join message
      ws.send(
        JSON.stringify({
          type: 'join',
          room: room
        })
      )
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        console.log('[useYSync] Received message:', { type: message.type, clientId: message.clientId })

        if (message.type === 'sync') {
          // Initial state sync from server
          console.log('[useYSync] Syncing initial state...')
          const state = new Uint8Array(message.state)
          Y.applyUpdate(ydoc, state)
          setIsConnected(true)
          console.log('[useYSync] Document synced!')
        } else if (message.type === 'update') {
          // Remote update from another client
          console.log('[useYSync] Applying remote update of size:', message.update.length)
          const update = new Uint8Array(message.update)
          Y.applyUpdate(ydoc, update)
          console.log('[useYSync] Remote update applied')
        }
      } catch (error) {
        console.error('[useYSync] Message parse error:', error, 'Data:', event.data)
      }
    }

    ws.onerror = (error) => {
      console.error('[useYSync] WebSocket error:', error)
      setIsConnected(false)
    }

    ws.onclose = () => {
      console.log('[useYSync] WebSocket disconnected')
      setIsConnected(false)
    }

    // Subscribe to local changes
    const updateHandler = (update: Uint8Array, origin: any) => {
      console.log('[useYSync] Update event:', { origin, updateSize: update.length })
      
      // Send all updates to server (server broadcasts to other clients only)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'update',
            update: Array.from(update)
          })
        )
        console.log('[useYSync] Sent update to server')
      } else {
        console.warn('[useYSync] WebSocket not ready, update not sent')
      }
    }

    ydoc.on('update', updateHandler)

    return () => {
      console.log('[useYSync] Cleanup: removing update handler and closing WebSocket')
      ydoc.off('update', updateHandler)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    }
  }, [room])

  const createBinding = (editor: any) => {
    if (!ydocRef.current) {
      console.error('[useYSync] Ydoc not initialized')
      return
    }

    if (!editor || !editor.getModel) {
      console.error('[useYSync] Editor not ready')
      return
    }

    try {
      const model = editor.getModel()
      if (!model) {
        console.error('[useYSync] Editor model not available')
        return
      }

      const ytext = ydocRef.current.getText('monaco')
      console.log('[useYSync] Creating MonacoBinding...', { hasModel: !!model, hasYtext: !!ytext })
      
      const binding = new MonacoBinding(
        ytext,
        model,
        new Set([editor]),
        undefined // awareness not needed for basic sync
      )
      bindingRef.current = binding
      console.log('[useYSync] MonacoBinding created successfully')
    } catch (error) {
      console.error('[useYSync] Failed to create binding:', error)
    }
  }

  const destroyBinding = () => {
    if (bindingRef.current) {
      bindingRef.current.destroy()
      bindingRef.current = null
    }
  }

  return { isConnected, createBinding, destroyBinding, ydoc: ydocRef.current }
}
