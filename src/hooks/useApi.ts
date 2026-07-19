import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'

export function useApi() {
  const backendPort = useAppStore((s) => s.backendPort)
  const base = `http://localhost:${backendPort}/api`

  const get = useCallback(async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GET ${path} failed: ${res.status} ${text}`)
    }
    return res.json()
  }, [base])

  const post = useCallback(async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`POST ${path} failed: ${res.status} ${text}`)
    }
    return res.json()
  }, [base])

  const put = useCallback(async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`PUT ${path} failed: ${res.status} ${text}`)
    }
    return res.json()
  }, [base])

  const del = useCallback(async (path: string): Promise<void> => {
    const res = await fetch(`${base}${path}`, { method: 'DELETE' })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`DELETE ${path} failed: ${res.status} ${text}`)
    }
  }, [base])

  const postForm = useCallback(async <T>(path: string, formData: FormData): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`POST ${path} failed: ${res.status} ${text}`)
    }
    return res.json()
  }, [base])

  return { get, post, put, del, postForm, base }
}
