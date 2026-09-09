import { useAppStore } from '../stores/appStore'

// Fire-and-forget POST to the backend's /errors proxy (see
// backend/routers/errors.py -> discovery_service.submit_error_report ->
// the Worker's /errors) — feeds the admin "База даних" tab's per-user
// "Помилки" sub-tab. Standalone (not the useApi() hook) because this needs
// to be callable from ErrorBoundary's componentDidCatch and from a plain
// top-level window listener in main.tsx, neither of which is a React
// component body — reads backendPort directly off the zustand store
// instead of the hook.
export function reportError(message: string, stack?: string | null, context: string = 'renderer') {
  try {
    const backendPort = useAppStore.getState().backendPort
    if (!backendPort) return
    fetch(`http://localhost:${backendPort}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message.slice(0, 2000), stack: stack ?? null, context }),
    }).catch(() => {})
  } catch {
    /* never let error reporting itself throw */
  }
}
