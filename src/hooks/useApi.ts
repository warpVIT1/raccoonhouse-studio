import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'

// Every request/response (and failure) is logged right here — a single
// choke point every API call passes through — rather than relying on each
// call site to log its own errors. Call sites are free to swallow a
// rejected promise for their own UI state (e.g. "just don't show a
// spinner"), but the fact that it failed, and why, is never lost: it's
// always in the console (and, via electron/main.ts's console-message
// forwarding, in electron.log on disk too).
function logRequest(method: string, path: string) {
  console.log(`[api] -> ${method} ${path}`)
}

function logResponse(method: string, path: string, status: number, elapsedMs: number) {
  const line = `[api] <- ${method} ${path} ${status} (${elapsedMs.toFixed(0)}ms)`
  if (status >= 400) console.error(line)
  else console.log(line)
}

function logFailure(method: string, path: string, err: unknown) {
  console.error(`[api] XX ${method} ${path} failed:`, err)
}

export function useApi() {
  const backendPort = useAppStore((s) => s.backendPort)
  const base = `http://localhost:${backendPort}/api`

  const get = useCallback(async <T>(path: string): Promise<T> => {
    const start = performance.now()
    logRequest('GET', path)
    try {
      const res = await fetch(`${base}${path}`)
      logResponse('GET', path, res.status, performance.now() - start)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`GET ${path} failed: ${res.status} ${text}`)
      }
      return res.json()
    } catch (err) {
      logFailure('GET', path, err)
      throw err
    }
  }, [base])

  const post = useCallback(async <T>(path: string, body?: unknown): Promise<T> => {
    const start = performance.now()
    logRequest('POST', path)
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      logResponse('POST', path, res.status, performance.now() - start)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`POST ${path} failed: ${res.status} ${text}`)
      }
      return res.json()
    } catch (err) {
      logFailure('POST', path, err)
      throw err
    }
  }, [base])

  const put = useCallback(async <T>(path: string, body?: unknown): Promise<T> => {
    const start = performance.now()
    logRequest('PUT', path)
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      logResponse('PUT', path, res.status, performance.now() - start)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`PUT ${path} failed: ${res.status} ${text}`)
      }
      return res.json()
    } catch (err) {
      logFailure('PUT', path, err)
      throw err
    }
  }, [base])

  const del = useCallback(async (path: string): Promise<void> => {
    const start = performance.now()
    logRequest('DELETE', path)
    try {
      const res = await fetch(`${base}${path}`, { method: 'DELETE' })
      logResponse('DELETE', path, res.status, performance.now() - start)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`DELETE ${path} failed: ${res.status} ${text}`)
      }
    } catch (err) {
      logFailure('DELETE', path, err)
      throw err
    }
  }, [base])

  const postForm = useCallback(async <T>(path: string, formData: FormData): Promise<T> => {
    const start = performance.now()
    logRequest('POST(form)', path)
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        body: formData,
      })
      logResponse('POST(form)', path, res.status, performance.now() - start)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`POST ${path} failed: ${res.status} ${text}`)
      }
      return res.json()
    } catch (err) {
      logFailure('POST(form)', path, err)
      throw err
    }
  }, [base])

  return { get, post, put, del, postForm, base }
}
