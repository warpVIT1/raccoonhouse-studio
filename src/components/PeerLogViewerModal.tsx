import React, { useEffect, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { Spinner } from './ui/Spinner'

const LOG_FILES = ['app.log', 'power_share.log', 'electron.log'] as const

interface PeerLogViewerModalProps {
  peerId: string
  peerName: string
  onClose: () => void
}

// Admin-only, read-only viewer for a PEER's own log files — fetched over the
// existing power-share relay (never a direct connection between PCs, same as
// every other cross-machine feature). Polls while open to feel live without
// building a whole separate streaming channel just for this. View/download/
// copy only: there is no save/edit path anywhere in this component or the
// backend route it calls.
export function PeerLogViewerModal({ peerId, peerName, onClose }: PeerLogViewerModalProps) {
  const backdrop = useBackdropClose(onClose)
  const { get } = useApi()
  const [file, setFile] = useState<(typeof LOG_FILES)[number]>('app.log')
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    async function poll() {
      try {
        const r = await get<{ content: string }>(
          `/power-share/peers/${encodeURIComponent(peerId)}/log?filename=${encodeURIComponent(file)}`
        )
        if (!cancelled) {
          setContent(r.content)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не вдалося отримати журнал')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    poll()
    const interval = setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [get, peerId, file])

  // Follow the tail as fresh content arrives, unless the admin has scrolled
  // up to read something older — a forced scroll-to-bottom on every 4s poll
  // would yank the view out from under anyone reading history.
  useEffect(() => {
    const el = preRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [content])

  function download() {
    if (content == null) return
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${peerName}_${file}`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function copy() {
    if (content == null) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" {...backdrop}>
      <div className="rh-card w-[720px] max-w-full h-[70vh] p-5 flex flex-col gap-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold truncate">Журнали — {peerName}</h2>
            <div className="text-[10.5px] text-rh-muted">Лише перегляд — без можливості редагувати</div>
          </div>
          <button onClick={onClose} className="rh-btn-ghost text-[11px] px-2 py-1">Закрити</button>
        </div>

        <div className="flex gap-1.5 flex-shrink-0">
          {LOG_FILES.map((f) => (
            <button
              key={f}
              onClick={() => { setContent(null); setFile(f) }}
              className={`px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors ${
                file === f
                  ? 'bg-rh-accent/15 border-rh-accent/50 text-white'
                  : 'border-rh-border text-rh-text-dim hover:border-rh-accent/40 hover:text-white'
              }`}
            >
              {f}
            </button>
          ))}
          <div className="flex-1" />
          <button onClick={copy} disabled={content == null} className="rh-btn-outline text-[11px] px-2.5 py-1">
            {copied ? 'Скопійовано!' : 'Копіювати'}
          </button>
          <button onClick={download} disabled={content == null} className="rh-btn-outline text-[11px] px-2.5 py-1">
            Завантажити
          </button>
        </div>

        {error ? (
          <div className="flex-1 flex items-center justify-center text-xs text-[#FF6B70] text-center px-6">{error}</div>
        ) : loading && content == null ? (
          <div className="flex-1 flex items-center justify-center"><Spinner size={20} className="text-rh-accent" /></div>
        ) : (
          <pre
            ref={preRef}
            className="flex-1 overflow-auto bg-black/30 rounded-lg p-3 text-[10.5px] font-mono leading-relaxed whitespace-pre-wrap select-text"
          >
            {content || '(порожньо)'}
          </pre>
        )}
      </div>
    </div>
  )
}
