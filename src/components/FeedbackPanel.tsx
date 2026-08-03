import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { Spinner } from './ui/Spinner'
import { Toggle } from './ui/Toggle'
import type { FeedbackItem } from '../types'

interface FeedbackPanelProps {
  showInbox: boolean
  onToggleInbox: (v: boolean) => void
  isAdmin: boolean
}

// Sends through the same Cloudflare Worker Power Share already uses (see
// cloudflare-signaling/src/index.ts's /feedback routes) — every install can
// submit, but the incoming list (and the toggle to show it) is only
// available once this install has unlocked admin (see ProfileModal's
// "type admin as your role" flow), so a teammate's install doesn't even see
// the option to pull in and display everyone else's messages.
export function FeedbackPanel({ showInbox, onToggleInbox, isAdmin }: FeedbackPanelProps) {
  const { get, post, del } = useApi()
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const [items, setItems] = useState<FeedbackItem[] | null>(null)
  const [inboxError, setInboxError] = useState<string | null>(null)

  useEffect(() => {
    if (!showInbox || !isAdmin) return
    let cancelled = false
    async function poll() {
      try {
        const data = await get<FeedbackItem[]>('/feedback')
        if (!cancelled) { setItems(data); setInboxError(null) }
      } catch (e) {
        if (!cancelled) setInboxError(e instanceof Error ? e.message : 'Не вдалося отримати список')
      }
    }
    poll()
    const interval = setInterval(poll, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [showInbox, isAdmin, get])

  async function submit() {
    const trimmed = message.trim()
    if (!trimmed) return
    setSending(true)
    setSendError(null)
    setSent(false)
    try {
      await post('/feedback', { message: trimmed })
      setMessage('')
      setSent(true)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Не вдалося надіслати')
    } finally {
      setSending(false)
    }
  }

  async function dismiss(id: string) {
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? null)
    try {
      await del(`/feedback/${id}`)
    } catch {
      /* the next poll will bring it back if the delete didn't actually land */
    }
  }

  // Plain-text export rather than JSON — this is for a human to actually
  // read later (archive, forward, review offline), not for re-importing
  // anywhere. A regular browser-style Blob download; Electron saves it to
  // the user's Downloads folder like any other download.
  function exportFeedback() {
    if (!items || items.length === 0) return
    const text = items
      .map((i) => `[${new Date(i.created_at).toLocaleString()}] ${i.nickname}\n${i.message}\n`)
      .join('\n---\n\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `feedback_${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden mt-5">
      <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">Пропозиції та скарги</div>
          <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
            Надсилається розробнику через сервер сигналізації Power Share
          </div>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-2 border-b border-rh-border/70">
        <textarea
          value={message}
          onChange={(e) => { setMessage(e.target.value); setSent(false) }}
          placeholder="Опишіть проблему або ідею…"
          rows={3}
          className="rh-input resize-none"
        />
        <div className="flex items-center justify-end gap-2">
          {sent && <span className="text-[11px] text-emerald-400 mr-auto">Надіслано, дякуємо!</span>}
          {sendError && <span className="text-[11px] text-[#FF6B70] mr-auto">{sendError}</span>}
          <button onClick={submit} disabled={sending || !message.trim()} className="rh-btn-primary text-xs">
            {sending ? <Spinner size={12} /> : null}
            Надіслати
          </button>
        </div>
      </div>

      {isAdmin && (
        <div className="flex items-center gap-3 py-3.5 px-4">
          <div className="flex-1">
            <div className="text-[12.5px] font-bold">Показувати вхідні (тільки для розробника)</div>
            <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
              Список того, що надіслали інші учасники групи
            </div>
          </div>
          <Toggle checked={showInbox} onChange={onToggleInbox} className="flex-shrink-0" />
        </div>
      )}

      {isAdmin && showInbox && (
        <div className="px-4 pb-4 flex flex-col gap-2">
          {items && items.length > 0 && (
            <button
              onClick={exportFeedback}
              className="rh-btn-outline text-[11px] self-end px-3 py-1.5"
            >
              Завантажити все
            </button>
          )}
          {inboxError && <div className="text-[11px] text-[#FF6B70]">{inboxError}</div>}
          {items === null && !inboxError && (
            <div className="flex justify-center py-4"><Spinner size={16} className="text-rh-accent" /></div>
          )}
          {items?.length === 0 && <div className="text-xs text-rh-muted">Поки що нічого немає.</div>}
          {items?.map((i) => (
            <div key={i.id} className="flex items-start gap-2.5 rounded-lg border border-rh-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{i.nickname}</div>
                <div className="text-[11.5px] text-rh-text mt-0.5 whitespace-pre-wrap break-words">{i.message}</div>
                <div className="font-mono text-[10px] text-rh-muted mt-1">{new Date(i.created_at).toLocaleString()}</div>
              </div>
              <button
                onClick={() => dismiss(i.id)}
                className="text-rh-muted hover:text-emerald-400 text-sm leading-none px-1 flex-shrink-0"
                title="Прочитано"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
