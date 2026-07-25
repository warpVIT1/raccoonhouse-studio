import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import type { WsMessage } from '../types'

export function useWebSocket() {
  const backendPort = useAppStore((s) => s.backendPort)
  const handleWsMessage = useAppStore((s) => s.handleWsMessage)
  const setBackendReady = useAppStore((s) => s.setBackendReady)
  const reconcileActiveJobs = useAppStore((s) => s.reconcileActiveJobs)
  const ws = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return

    try {
      const socket = new WebSocket(`ws://localhost:${backendPort}/ws`)
      ws.current = socket

      socket.onopen = () => {
        setBackendReady(true)
        console.log('[ws] Connected to backend')
        // Drop any "running" job the frontend remembers that the backend
        // itself no longer knows about — see reconcileActiveJobs for why.
        fetch(`http://localhost:${backendPort}/api/jobs`)
          .then((r) => r.json())
          .then((jobs: Array<{ id: string }>) => reconcileActiveJobs(jobs.map((j) => j.id)))
          .catch((err) => console.error('[ws] Failed to reconcile active jobs on connect:', err))
      }

      socket.onmessage = (event) => {
        try {
          const msg: WsMessage = JSON.parse(event.data)
          // electron.log forwards console-message via Chromium's API, which
          // stringifies non-string args with a bare toString() — an object
          // arg here always came out as the useless literal "[object
          // Object]" in the log file (confirmed live), even though DevTools
          // itself renders it fine. Logging the original JSON string sidesteps
          // that entirely.
          console.log('[ws] message:', event.data)
          handleWsMessage(msg)
        } catch (err) {
          console.error('[ws] Received malformed message, ignoring:', event.data, err)
        }
      }

      socket.onclose = () => {
        console.log('[ws] Disconnected from backend — reconnecting in 2s')
        setBackendReady(false)
        ws.current = null
        // Reconnect after 2s
        reconnectTimer.current = setTimeout(connect, 2000)
      }

      socket.onerror = (event) => {
        console.error('[ws] Socket error:', event)
        socket.close()
      }
    } catch (err) {
      console.error('[ws] Failed to open socket, reconnecting in 2s:', err)
      reconnectTimer.current = setTimeout(connect, 2000)
    }
  }, [backendPort, handleWsMessage, setBackendReady, reconcileActiveJobs])

  useEffect(() => {
    // Wait a bit for backend to start
    reconnectTimer.current = setTimeout(connect, 1500)
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      ws.current?.close()
    }
  }, [connect])

  const send = useCallback((msg: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg))
    }
  }, [])

  return { send }
}
