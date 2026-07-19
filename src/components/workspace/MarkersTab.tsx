import React, { useState } from 'react'
import type { Marker } from '../../types'

function formatTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(3)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${sec.padStart(6,'0')}`
}

interface MarkersTabProps {
  markers: Marker[]
  onConfirm: (id: number) => void
  onEdit: (id: number, changes: Partial<Marker>) => void
  onDelete: (id: number) => void
  onAdd: (positionSeconds: number, name: string) => void
  onSeek: (t: number) => void
}

export function MarkersTab({ markers, onConfirm, onEdit, onDelete, onAdd, onSeek }: MarkersTabProps) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editPos, setEditPos] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPos, setNewPos] = useState('')

  function startEdit(m: Marker) {
    setEditingId(m.id)
    setEditName(m.reaper_name)
    setEditPos(formatTime(m.position_seconds))
  }

  function commitEdit(id: number) {
    const parts = editPos.split(/[:.]/)
    let secs = 0
    if (parts.length >= 3) {
      const h = parseInt(parts[0]) || 0
      const m = parseInt(parts[1]) || 0
      const s = parseFloat(parts.slice(2).join('.')) || 0
      secs = h * 3600 + m * 60 + s
    }
    onEdit(id, { reaper_name: editName, position_seconds: secs })
    setEditingId(null)
  }

  function handleAdd() {
    const parts = newPos.split(/[:.]/)
    let secs = 0
    if (parts.length >= 3) {
      const h = parseInt(parts[0]) || 0
      const m = parseInt(parts[1]) || 0
      const s = parseFloat(parts.slice(2).join('.')) || 0
      secs = h * 3600 + m * 60 + s
    }
    onAdd(secs, newName || 'ЗВУК')
    setShowAdd(false)
    setNewName('')
    setNewPos('')
  }

  const sorted = [...markers].sort((a, b) => a.position_seconds - b.position_seconds)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-rh-border bg-rh-card2 flex-shrink-0">
        <span className="text-xs text-rh-muted">
          {markers.length} маркерів · {markers.filter((m) => m.confirmed).length} підтверджено
        </span>
        <button
          onClick={() => setShowAdd(true)}
          className="rh-btn-ghost text-xs px-2 py-1"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Додати
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="flex items-center gap-2 px-3 py-2 bg-rh-card2 border-b border-rh-border flex-shrink-0">
          <input
            className="rh-input text-xs flex-1"
            placeholder="Назва (напр. НВ - ЗВУК)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <input
            className="rh-input text-xs w-36 font-mono"
            placeholder="00:00:00.000"
            value={newPos}
            onChange={(e) => setNewPos(e.target.value)}
          />
          <button onClick={handleAdd} className="rh-btn-primary text-xs px-2 py-1">OK</button>
          <button onClick={() => setShowAdd(false)} className="rh-btn-ghost text-xs px-2 py-1">✕</button>
        </div>
      )}

      {/* Marker list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-24 gap-2 text-rh-muted">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            <span className="text-xs">Маркерів немає. Запустіть авто-виявлення.</span>
          </div>
        ) : (
          sorted.map((m) => (
            <div
              key={m.id}
              className={`flex items-center gap-2 px-3 py-2 border-b border-rh-border/50 hover:bg-white/[0.02] group
                ${m.confirmed ? '' : 'border-l-2 border-l-amber-500'}`}
            >
              {/* Position indicator */}
              <div
                className={`w-2 h-2 rounded-full flex-shrink-0 ${m.confirmed ? 'bg-emerald-400' : 'bg-amber-400'}`}
                title={m.confirmed ? 'Підтверджено' : 'Авто-маркер'}
              />

              {editingId === m.id ? (
                <>
                  <input
                    className="rh-input text-xs flex-1 py-0.5"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    autoFocus
                  />
                  <input
                    className="rh-input text-xs w-36 font-mono py-0.5"
                    value={editPos}
                    onChange={(e) => setEditPos(e.target.value)}
                  />
                  <button onClick={() => commitEdit(m.id)} className="text-xs text-emerald-400 hover:text-emerald-300">✓</button>
                  <button onClick={() => setEditingId(null)} className="text-xs text-rh-muted hover:text-rh-text">✕</button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => onSeek(m.position_seconds)}
                    className="flex-1 text-left"
                  >
                    <span className="text-xs text-rh-text">{m.reaper_name}</span>
                  </button>
                  <span className="text-xs font-mono text-rh-muted">{formatTime(m.position_seconds)}</span>

                  {/* Actions */}
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!m.confirmed && (
                      <button
                        onClick={() => onConfirm(m.id)}
                        className="w-6 h-6 flex items-center justify-center rounded text-emerald-400 hover:bg-emerald-400/10"
                        title="Підтвердити"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => startEdit(m)}
                      className="w-6 h-6 flex items-center justify-center rounded text-rh-muted hover:text-rh-text hover:bg-white/5"
                      title="Редагувати"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                    <button
                      onClick={() => onDelete(m.id)}
                      className="w-6 h-6 flex items-center justify-center rounded text-rh-muted hover:text-red-400 hover:bg-red-400/10"
                      title="Видалити"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
                      </svg>
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 px-3 py-1.5 border-t border-rh-border bg-rh-card2 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-xs text-rh-muted">Підтверджено</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-amber-400" />
          <span className="text-xs text-rh-muted">Авто-маркер</span>
        </div>
      </div>
    </div>
  )
}
