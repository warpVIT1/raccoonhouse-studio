import React, { useState, useRef, useCallback, useEffect } from 'react'
import type { SubtitleLine, Character } from '../../types'

function msToTimecode(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`
}

function calcCps(text: string, startMs: number, endMs: number): number {
  const durationS = (endMs - startMs) / 1000
  if (durationS <= 0) return 0
  const cleanText = text.replace(/\{[^}]+\}/g, '').replace(/\\N/gi, '')
  return Math.round(cleanText.length / durationS)
}

function cpsColor(cps: number): string {
  return cps > 20 ? 'text-red-400' : 'text-rh-text-dim'
}

// Small button next to the actor name — opens a plain list of already-used
// characters so a repeated actor can be assigned in one click instead of
// retyping the name every single line.
function QuickPickButton({ characters, onPick }: { characters: Character[]; onPick: (id: number) => void }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onDocClick = () => setOpen(false)
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [open])

  if (characters.length === 0) return null

  return (
    <div className="relative flex-shrink-0" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}>
      <button className="w-4 h-4 flex items-center justify-center text-rh-muted hover:text-rh-text" title="Обрати з наявних">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div
          className="absolute z-20 top-5 right-0 w-40 max-h-56 overflow-y-auto rh-card border border-rh-border shadow-2xl py-1"
          onClick={(e) => e.stopPropagation()}
        >
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => { onPick(c.id); setOpen(false) }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-rh-text-dim truncate hover:bg-white/5 hover:text-rh-text"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


interface SubtitleGridProps {
  lines: SubtitleLine[]
  characters: Character[]
  activeIndex: number | null
  currentTimeMs: number
  onLineClick: (index: number) => void
  onLineChange: (index: number, changes: Partial<SubtitleLine>) => void
  onAddLine: () => void
  onDeleteLine: (index: number) => void
  onCreateCharacter: (name: string) => Promise<Character | null>
}

export function SubtitleGrid({
  lines,
  characters,
  activeIndex,
  currentTimeMs,
  onLineClick,
  onLineChange,
  onAddLine,
  onDeleteLine,
  onCreateCharacter,
}: SubtitleGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null)
  // Ctrl/Cmd+wheel zooms row text size (like the waveform's own zoom) —
  // plain wheel keeps scrolling normally.
  const [fontScale, setFontScale] = useState(1)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setFontScale((s) => Math.min(2, Math.max(0.7, s * (e.deltaY < 0 ? 1.08 : 1 / 1.08))))
  }, [])
  // Ctrl+click toggles individual rows into the selection, Shift+click
  // selects a whole range from the last-clicked row — so an actor can be
  // assigned to many lines at once instead of one at a time.
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const lastClickedRowRef = useRef<number | null>(null)

  const handleRowClick = useCallback((i: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedRows((prev) => {
        const next = new Set(prev)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      })
      lastClickedRowRef.current = i
      return
    }
    if (e.shiftKey && lastClickedRowRef.current != null) {
      const from = Math.min(lastClickedRowRef.current, i)
      const to = Math.max(lastClickedRowRef.current, i)
      const range = new Set<number>()
      for (let r = from; r <= to; r++) range.add(r)
      setSelectedRows(range)
      return
    }
    setSelectedRows(new Set())
    lastClickedRowRef.current = i
    onLineClick(i)
  }, [onLineClick])

  // Auto-scroll to active line
  useEffect(() => {
    if (activeIndex == null) return
    const row = containerRef.current?.querySelector(`[data-row="${activeIndex}"]`)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIndex])

  const handleCellClick = useCallback(
    (rowIdx: number, col: string, e: React.MouseEvent) => {
      e.stopPropagation()
      // A plain click into a cell (to edit/navigate) always clears any
      // multi-row selection first — otherwise the stale selection from an
      // earlier Ctrl/Shift click lingers, and assigning an actor here
      // silently applies to that whole old selection instead of just this
      // line, which looks like "it picks the wrong lines".
      setSelectedRows(new Set())
      lastClickedRowRef.current = rowIdx
      onLineClick(rowIdx)
      if (col === 'text' || col === 'start' || col === 'end' || col === 'actor') {
        setEditingCell({ row: rowIdx, col })
      }
    },
    [onLineClick]
  )

  const commitEdit = useCallback(
    (rowIdx: number, col: string, value: string) => {
      setEditingCell(null)
      const line = lines[rowIdx]
      if (!line) return

      if (col === 'text') {
        onLineChange(rowIdx, { text: value })
      } else if (col === 'start') {
        const parts = value.split(/[:.]/)
        if (parts.length >= 4) {
          const h = parseInt(parts[0]) || 0
          const m = parseInt(parts[1]) || 0
          const s = parseInt(parts[2]) || 0
          const cs = parseInt(parts[3]) || 0
          onLineChange(rowIdx, { start_ms: (h * 3600 + m * 60 + s) * 1000 + cs * 10 })
        }
      } else if (col === 'end') {
        const parts = value.split(/[:.]/)
        if (parts.length >= 4) {
          const h = parseInt(parts[0]) || 0
          const m = parseInt(parts[1]) || 0
          const s = parseInt(parts[2]) || 0
          const cs = parseInt(parts[3]) || 0
          onLineChange(rowIdx, { end_ms: (h * 3600 + m * 60 + s) * 1000 + cs * 10 })
        }
      }
    },
    [lines, onLineChange]
  )

  // If the row being edited is part of a multi-row selection (Ctrl/Shift
  // click), apply the same actor to every selected row at once instead of
  // just this one.
  const applyActorId = useCallback(
    (rowIdx: number, characterId: number | null) => {
      const targets = selectedRows.size > 1 && selectedRows.has(rowIdx) ? selectedRows : new Set([rowIdx])
      for (const r of targets) onLineChange(r, { character_id: characterId })
    },
    [selectedRows, onLineChange]
  )

  // Actor is plain text just like the "Текст" column — type a name and it
  // either matches an existing character (case-insensitive) or creates a
  // brand new one on the fly, instead of forcing a pick-from-list-only menu.
  const commitActor = useCallback(
    async (rowIdx: number, value: string) => {
      setEditingCell(null)
      const name = value.trim()
      if (!name) {
        applyActorId(rowIdx, null)
        return
      }
      const existing = characters.find((c) => c.name.toLowerCase() === name.toLowerCase())
      if (existing) {
        applyActorId(rowIdx, existing.id)
        return
      }
      const created = await onCreateCharacter(name)
      if (created) applyActorId(rowIdx, created.id)
    },
    [characters, onCreateCharacter, applyActorId]
  )


  const COLS = [
    { key: '#', width: 'w-10', label: '#' },
    { key: 'start', width: 'w-28', label: 'Початок' },
    { key: 'end', width: 'w-28', label: 'Кінець' },
    { key: 'cps', width: 'w-14', label: 'CPS' },
    { key: 'style', width: 'w-24', label: 'Стиль' },
    { key: 'actor', width: 'w-28', label: 'Актор' },
    { key: 'text', width: 'flex-1 min-w-0', label: 'Текст' },
  ]

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      // `zoom` (not standard CSS, but Chromium-only is fine — this app only
      // ever runs inside Electron) actually rescales layout+text together;
      // Tailwind's text-xs etc. are fixed rem values, so plain `fontSize`
      // here wouldn't touch any of the row cells' own text sizing at all.
      style={{ zoom: fontScale }}
      onWheel={handleWheel}
    >
      {/* Column headers */}
      <div className="flex items-center border-b border-rh-border bg-rh-card2 px-2 flex-shrink-0">
        {COLS.map((col) => (
          <div
            key={col.key}
            className={`${col.width} py-1.5 px-1 text-xs font-medium text-rh-muted uppercase tracking-wide select-none`}
          >
            {col.label}
          </div>
        ))}
        {/* Actions col */}
        <div className="w-8 flex-shrink-0" />
      </div>

      {/* Rows */}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-rh-muted text-sm">
            Субтитри відсутні. Імпортуйте .ass файл.
          </div>
        ) : (
          lines.map((line, i) => {
            const isActive = i === activeIndex
            const isCurrent =
              currentTimeMs >= line.start_ms && currentTimeMs <= line.end_ms
            const isSelected = selectedRows.has(i)

            return (
              <div
                key={line.id}
                data-row={i}
                onClick={(e) => handleRowClick(i, e)}
                className={`flex items-center border-b border-rh-border/50 px-2 cursor-pointer sub-row
                  ${isActive ? 'active' : ''}
                  ${isCurrent && !isActive ? 'bg-white/[0.02]' : ''}
                  ${line.is_overlap ? 'border-l-2 border-l-violet-500' : ''}
                  ${isSelected ? 'bg-rh-accent/10 ring-1 ring-inset ring-rh-accent/40' : ''}
                `}
              >
                {/* # */}
                <div className="w-10 px-1 py-1 text-xs text-rh-muted font-mono">{i + 1}</div>

                {/* Start */}
                <div
                  className="w-28 px-1 py-1"
                  onClick={(e) => handleCellClick(i, 'start', e)}
                >
                  {editingCell?.row === i && editingCell.col === 'start' ? (
                    <input
                      autoFocus
                      className="rh-input w-full text-xs font-mono py-0"
                      defaultValue={msToTimecode(line.start_ms)}
                      onBlur={(e) => commitEdit(i, 'start', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Tab') commitEdit(i, 'start', (e.target as HTMLInputElement).value) }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="text-xs font-mono text-rh-text-dim">{msToTimecode(line.start_ms)}</span>
                  )}
                </div>

                {/* End */}
                <div
                  className="w-28 px-1 py-1"
                  onClick={(e) => handleCellClick(i, 'end', e)}
                >
                  {editingCell?.row === i && editingCell.col === 'end' ? (
                    <input
                      autoFocus
                      className="rh-input w-full text-xs font-mono py-0"
                      defaultValue={msToTimecode(line.end_ms)}
                      onBlur={(e) => commitEdit(i, 'end', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Tab') commitEdit(i, 'end', (e.target as HTMLInputElement).value) }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="text-xs font-mono text-rh-text-dim">{msToTimecode(line.end_ms)}</span>
                  )}
                </div>

                {/* CPS */}
                <div className="w-14 px-1 py-1">
                  <span className={`text-xs font-mono ${cpsColor(calcCps(line.text, line.start_ms, line.end_ms))}`}>
                    {calcCps(line.text, line.start_ms, line.end_ms)}
                  </span>
                </div>

                {/* Style */}
                <div className="w-24 px-1 py-1">
                  <span className="text-xs text-rh-muted truncate block">{line.ass_style}</span>
                </div>

                {/* Actor */}
                <div
                  className="w-28 px-1 py-1 flex items-center gap-1"
                  onClick={(e) => handleCellClick(i, 'actor', e)}
                >
                  {editingCell?.row === i && editingCell.col === 'actor' ? (
                    <input
                      autoFocus
                      className="rh-input w-full text-xs py-0"
                      defaultValue={characters.find((c) => c.id === line.character_id)?.name ?? ''}
                      onBlur={(e) => commitActor(i, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Tab') commitActor(i, (e.target as HTMLInputElement).value) }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      <span className="text-xs text-rh-text-dim truncate flex-1">
                        {characters.find((c) => c.id === line.character_id)?.name ?? '—'}
                      </span>
                      <QuickPickButton characters={characters} onPick={(id) => applyActorId(i, id)} />
                    </>
                  )}
                </div>

                {/* Text */}
                <div
                  className="flex-1 min-w-0 px-1 py-1"
                  onClick={(e) => handleCellClick(i, 'text', e)}
                >
                  {editingCell?.row === i && editingCell.col === 'text' ? (
                    <textarea
                      autoFocus
                      className="rh-input w-full text-xs resize-none py-0.5 font-sans"
                      rows={2}
                      defaultValue={line.text}
                      onBlur={(e) => commitEdit(i, 'text', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingCell(null) }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className={`text-xs truncate block leading-relaxed ${line.is_overlap ? 'text-violet-300' : 'text-rh-text'}`}>
                      {line.text.replace(/\{[^}]+\}/g, '').replace(/\\N/gi, ' ↵ ')}
                    </span>
                  )}
                </div>

                {/* Delete */}
                <div className="w-8 flex-shrink-0 flex justify-center" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => onDeleteLine(i)}
                    className="w-6 h-6 flex items-center justify-center rounded text-rh-muted hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                    title="Видалити"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Footer toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-rh-border bg-rh-card2 flex-shrink-0">
        <button onClick={onAddLine} className="rh-btn-ghost text-xs px-2 py-1">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Додати рядок
        </button>
        <span className="text-xs text-rh-muted">{lines.length} реплік</span>
        <span className="text-xs text-rh-muted">Оригінальний бітрейт та формат збережено</span>
        <span className="text-xs text-rh-muted ml-auto">автозбереження ✓</span>
      </div>
    </div>
  )
}
