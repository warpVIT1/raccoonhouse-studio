import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { SubtitleLine, Character, TeamActor } from '../../types'

function msToTimecode(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`
}

// Matches Aegisub's GridColumnCPS::CPS (src/grid_column.cpp) exactly, not
// just approximately — confirmed live 2026-08-16 that a naive
// chars-including-spaces / rounded-seconds formula reads meaningfully higher
// than Aegisub's own number for the same line. Two differences accounted
// for here: Aegisub's default config (`Subtitle/Character Counter/Ignore
// Whitespace` and `.../Ignore Punctuation`, both `true` out of the box —
// libresrc/default_config.json) strips whitespace AND punctuation from the
// count, not just ASS tags/`\N`; and it's an INTEGER-truncating division
// (`count * 1000 / duration_ms` in C++), not a rounded one.
function calcCps(text: string, startMs: number, endMs: number): number {
  const durationMs = endMs - startMs
  if (durationMs <= 100) return -1
  // IGNORE_BLOCKS: strip {...} override tag blocks entirely.
  let clean = text.replace(/\{[^}]*\}/g, '')
  // \N/\n (line break) and \h (ASS hard space) are invisible once
  // whitespace is being ignored — same as libaegisub's ass_special_chars
  // handling in character_count.cpp, not just a plain "\N" strip.
  clean = clean.replace(/\\[nNh]/g, '')
  clean = clean.replace(/\s/g, '')
  clean = clean.replace(/[\p{P}]/gu, '')
  return Math.trunc((clean.length * 1000) / durationMs)
}

// Aegisub's own default thresholds (Subtitle/Character Counter/CPS
// {Warning,Error} Threshold, libresrc/default_config.json: 15 / 30) rather
// than a single made-up cutoff.
function cpsColor(cps: number): string {
  if (cps < 0) return 'text-rh-text-dim'
  if (cps > 30) return 'text-red-400'
  if (cps > 15) return 'text-amber-400'
  return 'text-rh-text-dim'
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

// Actor cell's picker when the title belongs to a team with at least one
// actor on it — lists real team actors (see routers/teams.py's
// /teams/{id}/actors) first, PLUS a free-text field at the bottom for
// non-actor entries (on-screen signs/text, narrator, "GM", etc.) that were
// never going to be real team members — the team-actor list alone can't
// cover those, and the old plain free-text flow (still used verbatim
// below) already handles them fine. Reuses QuickPickButton's dropdown
// shell, opened directly (not behind a chevron) since a team-linked title
// no longer opens the old bare text input by default.
function TeamActorDropdown({ teamActors, characters, onPick, onClear, onCreateCustom, onClose }: {
  teamActors: TeamActor[]
  characters: Character[]
  onPick: (actor: TeamActor) => void
  onClear: () => void
  onCreateCustom: (name: string) => void
  onClose: () => void
}) {
  const [customName, setCustomName] = useState('')
  useEffect(() => {
    const onDocClick = () => onClose()
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [onClose])

  // Non-team characters (no team_device_id) that already exist on this
  // title — e.g. "Текст"/"GM" typed by hand earlier — offered as quick
  // repeats, same convenience the old free-text QuickPickButton gave.
  const customCharacters = characters.filter((c) => !c.team_device_id)

  function submitCustom() {
    const name = customName.trim()
    if (!name) return
    onCreateCustom(name)
    setCustomName('')
    onClose()
  }

  return (
    <div
      className="absolute z-20 top-5 left-0 w-44 max-h-72 overflow-y-auto rh-card border border-rh-border shadow-2xl py-1"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => { onClear(); onClose() }}
        className="w-full text-left px-2.5 py-1.5 text-xs text-rh-muted truncate hover:bg-white/5 hover:text-rh-text"
      >
        — Без актора
      </button>
      {teamActors.map((a) => (
        <button
          key={a.device_id}
          onClick={() => { onPick(a); onClose() }}
          className="w-full text-left px-2.5 py-1.5 text-xs text-rh-text-dim truncate hover:bg-white/5 hover:text-rh-text"
        >
          {a.display_name}
        </button>
      ))}
      {customCharacters.length > 0 && (
        <div className="border-t border-rh-border mt-1 pt-1">
          {customCharacters.map((c) => (
            <button
              key={c.id}
              onClick={() => { onCreateCustom(c.name); onClose() }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-rh-muted truncate hover:bg-white/5 hover:text-rh-text"
              title="Не з команди — вписано вручну"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="border-t border-rh-border mt-1 pt-1 px-1.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus={teamActors.length === 0}
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitCustom() }}
          placeholder="Свій варіант…"
          className="rh-input flex-1 min-w-0 text-xs py-0.5 px-1.5"
        />
        <button
          onClick={submitCustom}
          disabled={!customName.trim()}
          className="text-xs text-rh-accent hover:text-rh-accent/80 disabled:opacity-40 flex-shrink-0 px-1"
        >
          OK
        </button>
      </div>
    </div>
  )
}


interface SubtitleGridProps {
  lines: SubtitleLine[]
  characters: Character[]
  teamActors: TeamActor[]
  activeIndex: number | null
  currentTimeMs: number
  onLineClick: (index: number) => void
  onLineChange: (index: number, changes: Partial<SubtitleLine>) => void
  onAddLine: () => void
  onDeleteLine: (id: number) => void
  onDeleteAll: () => void
  onUndo: () => void
  onRedo: () => void
  onPasteLines: (
    items: Array<Pick<SubtitleLine, 'start_ms' | 'end_ms' | 'text' | 'ass_style' | 'character_id' | 'is_overlap'>>,
    atMs: number
  ) => void
  onCreateCharacter: (name: string) => Promise<Character | null>
  onPickTeamActor: (deviceId: string, displayName: string) => Promise<Character | null>
}

export function SubtitleGrid({
  lines,
  characters,
  teamActors,
  activeIndex,
  currentTimeMs,
  onLineClick,
  onLineChange,
  onAddLine,
  onDeleteLine,
  onDeleteAll,
  onUndo,
  onRedo,
  onPasteLines,
  onCreateCharacter,
  onPickTeamActor,
}: SubtitleGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null)
  // Click "Актор" to sort by actor name, click "#" to go back to normal
  // (chronological/import) order — purely a display-order change, every
  // handler below still gets the line's ORIGINAL index into `lines` (see
  // displayItems), so selection/undo/paste keep working exactly as before.
  const [sortBy, setSortBy] = useState<'default' | 'actor'>('default')
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
  // Ctrl+C snapshots the selected (or last-clicked) rows' content here;
  // Ctrl+V re-creates them starting at the current playhead. Kept as a
  // plain ref (not state) since copying shouldn't trigger a re-render.
  const clipboardRef = useRef<Array<Pick<SubtitleLine, 'start_ms' | 'end_ms' | 'text' | 'ass_style' | 'character_id' | 'is_overlap'>>>([])

  // Shared by both the row's own onClick AND each cell's onClick (start/end/
  // actor/text) — Ctrl/Shift+click needs to toggle/range-select no matter
  // which part of the row was actually clicked, since the Text column alone
  // covers most of a row's width. Returns true when the click was consumed
  // as a selection modifier (so the caller shouldn't also open an editor).
  const handleSelectionClick = useCallback((i: number, e: React.MouseEvent): boolean => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedRows((prev) => {
        const next = new Set(prev)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      })
      lastClickedRowRef.current = i
      return true
    }
    if (e.shiftKey && lastClickedRowRef.current != null) {
      const from = Math.min(lastClickedRowRef.current, i)
      const to = Math.max(lastClickedRowRef.current, i)
      const range = new Set<number>()
      for (let r = from; r <= to; r++) range.add(r)
      setSelectedRows(range)
      return true
    }
    setSelectedRows(new Set())
    lastClickedRowRef.current = i
    onLineClick(i)
    return false
  }, [onLineClick])

  const handleRowClick = useCallback((i: number, e: React.MouseEvent) => {
    handleSelectionClick(i, e)
  }, [handleSelectionClick])

  // Delete key removes every multi-selected row without needing the per-row
  // trash button — ignored while typing (editing a cell, the actor
  // dropdown...) so it doesn't hijack normal text editing. Deletion is
  // dispatched by line id (resolved from the current `lines` snapshot),
  // not array index — index-based batched removal drifts as each earlier
  // deletion shifts everyone after it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable
      const ctrl = e.ctrlKey || e.metaKey

      if (ctrl && !isTyping && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) onRedo()
        else onUndo()
        return
      }

      if (ctrl && !isTyping && e.key.toLowerCase() === 'c') {
        const indices = selectedRows.size > 0
          ? [...selectedRows]
          : (lastClickedRowRef.current != null ? [lastClickedRowRef.current] : [])
        if (indices.length > 0) {
          e.preventDefault()
          clipboardRef.current = indices
            .map((i) => lines[i])
            .filter((l): l is SubtitleLine => !!l)
            .sort((a, b) => a.start_ms - b.start_ms)
            .map((l) => ({
              start_ms: l.start_ms,
              end_ms: l.end_ms,
              text: l.text,
              ass_style: l.ass_style,
              character_id: l.character_id,
              is_overlap: l.is_overlap,
            }))
        }
        return
      }

      if (ctrl && !isTyping && e.key.toLowerCase() === 'v') {
        if (clipboardRef.current.length > 0) {
          e.preventDefault()
          onPasteLines(clipboardRef.current, currentTimeMs)
        }
        return
      }

      if (e.key !== 'Delete') return
      if (isTyping) return
      if (selectedRows.size > 0) {
        e.preventDefault()
        // Delete by id, not index — deleting several rows in one batch must
        // not drift as earlier removals shift everyone after them.
        for (const idx of selectedRows) {
          const line = lines[idx]
          if (line) onDeleteLine(line.id)
        }
        setSelectedRows(new Set())
        return
      }
      // No multi-selection — fall back to whichever single row was last
      // clicked (a plain click, no Ctrl/Shift, needed), so Del works right
      // after just clicking a line instead of requiring Ctrl+click first.
      if (lastClickedRowRef.current != null) {
        const line = lines[lastClickedRowRef.current]
        if (line) {
          e.preventDefault()
          onDeleteLine(line.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedRows, onDeleteLine, onUndo, onRedo, onPasteLines, currentTimeMs, lines])

  // Auto-scroll to active line
  useEffect(() => {
    if (activeIndex == null) return
    const row = containerRef.current?.querySelector(`[data-row="${activeIndex}"]`)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeIndex])

  const handleCellClick = useCallback(
    (rowIdx: number, col: string, e: React.MouseEvent) => {
      e.stopPropagation()
      // Already editing this exact cell — bail out before touching selection/
      // seek/editing state at all. Without this, dragging a text selection
      // inside the textarea and releasing the mouse just outside its own
      // bounds but still inside this wrapper div fires a plain click here:
      // the textarea's native blur (which commits and closes the editor) has
      // already fired by the time this synthetic click runs, and this
      // handler would then also clear the row selection, seek the video, and
      // immediately reopen a fresh textarea from the (stale, pre-commit)
      // `line.text` prop — visible as the edit box flickering shut and
      // losing the in-progress selection/cursor rather than just letting the
      // native text selection continue uninterrupted.
      if (editingCell?.row === rowIdx && editingCell.col === col) return
      // A plain click on the actor cell of a row that's already part of a
      // multi-selection opens the picker WITHOUT clearing that selection —
      // picking an actor then applies to every selected row (see
      // applyActorId), which is the whole point of selecting several lines
      // at once before assigning a role. Any other cell, or a click outside
      // the current selection, falls through to the normal toggle/range/
      // clear-and-seek behavior below.
      if (col === 'actor' && selectedRows.size > 1 && selectedRows.has(rowIdx) && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        setEditingCell({ row: rowIdx, col })
        return
      }
      // Ctrl/Shift+click here must behave exactly like clicking the row's
      // background — toggle/range-select — instead of opening an editor.
      // A plain click still clears selection, seeks, and (for text/actor)
      // opens the editor right away.
      const wasModifierClick = handleSelectionClick(rowIdx, e)
      if (wasModifierClick) return
      // Actor edits right away on a single click. Start/end (timing) are
      // excluded here — a single click there just selects/seeks, so a quick
      // click doesn't risk nudging a line's timing by accident; editing
      // timing needs a deliberate double-click instead (see
      // onDoubleClick below). Text has no inline editor anymore — see
      // SubtitleEditBox, the persistent box above the grid; a click on the
      // Text column here is just row selection/seek like any other cell.
      if (col === 'actor') {
        setEditingCell({ row: rowIdx, col })
      }
    },
    [handleSelectionClick, editingCell, selectedRows]
  )

  const handleTimeDoubleClick = useCallback((rowIdx: number, col: 'start' | 'end', e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingCell({ row: rowIdx, col })
  }, [])

  const commitEdit = useCallback(
    (rowIdx: number, col: string, value: string) => {
      setEditingCell(null)
      const line = lines[rowIdx]
      if (!line) return

      if (col === 'start') {
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
  // just this one. Clears the selection afterward — without this, the
  // selection stayed active forever (confirmed live 2026-09-08: nothing
  // else in this file ever cleared it after a bulk assign), so the NEXT
  // actor edit on any of those same rows kept re-applying to the whole old
  // group no matter which single row was actually clicked.
  const applyActorId = useCallback(
    (rowIdx: number, characterId: number | null) => {
      const targets = selectedRows.size > 1 && selectedRows.has(rowIdx) ? selectedRows : new Set([rowIdx])
      for (const r of targets) onLineChange(r, { character_id: characterId })
      if (targets.size > 1) setSelectedRows(new Set())
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

  // Picking a team actor finds-or-creates the local Character tagged with
  // that actor's team_device_id (find happens here so a repeat pick across
  // many lines doesn't re-POST every time), then applies it the same way as
  // any other actor assignment.
  const commitTeamActor = useCallback(
    async (rowIdx: number, actor: TeamActor) => {
      const existing = characters.find((c) => c.team_device_id === actor.device_id)
      if (existing) {
        applyActorId(rowIdx, existing.id)
        return
      }
      const created = await onPickTeamActor(actor.device_id, actor.display_name)
      if (created) applyActorId(rowIdx, created.id)
    },
    [characters, onPickTeamActor, applyActorId]
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

  // Pairs each line with its ORIGINAL index into `lines` — every row
  // handler (click/select/edit/delete) keeps operating on that original
  // index regardless of display order, so sorting never disturbs
  // selection/undo/paste semantics, only which order rows are painted in.
  const displayItems = useMemo(() => {
    const withIndex = lines.map((line, i) => ({ line, i }))
    if (sortBy !== 'actor') return withIndex
    const nameOf = (l: SubtitleLine) => characters.find((c) => c.id === l.character_id)?.name ?? ''
    return [...withIndex].sort((a, b) => nameOf(a.line).localeCompare(nameOf(b.line)))
  }, [lines, sortBy, characters])

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
        {COLS.map((col) => {
          const sortable = col.key === '#' || col.key === 'actor'
          const sortKey = col.key === '#' ? 'default' : 'actor'
          const isActiveSort = sortable && sortBy === sortKey
          return (
            <div
              key={col.key}
              onClick={sortable ? () => setSortBy(sortKey as 'default' | 'actor') : undefined}
              title={sortable ? (col.key === '#' ? 'Сортувати за замовчуванням' : 'Сортувати за актором') : undefined}
              className={`${col.width} py-1 px-1 text-xs font-medium uppercase tracking-wide select-none
                ${sortable ? 'cursor-pointer hover:text-rh-text' : ''}
                ${isActiveSort ? 'text-rh-accent' : 'text-rh-muted'}`}
            >
              {col.label}{isActiveSort ? ' ▾' : ''}
            </div>
          )
        })}
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
          displayItems.map(({ line, i }) => {
            const isActive = i === activeIndex
            const isCurrent =
              currentTimeMs >= line.start_ms && currentTimeMs <= line.end_ms
            const isSelected = selectedRows.has(i)

            return (
              <div
                key={line.id}
                data-row={i}
                onClick={(e) => handleRowClick(i, e)}
                className={`group flex items-center border-b border-rh-border/50 px-2 cursor-pointer sub-row
                  ${isActive ? 'active' : ''}
                  ${isCurrent && !isActive ? 'bg-white/[0.02]' : ''}
                  ${line.is_overlap ? 'border-l-2 border-l-violet-500' : ''}
                  ${isSelected ? 'bg-rh-accent/10 ring-1 ring-inset ring-rh-accent/40' : ''}
                `}
              >
                {/* # */}
                <div className="w-10 px-1 py-0.5 text-xs text-rh-muted font-mono">{i + 1}</div>

                {/* Start */}
                <div
                  className="w-28 px-1 py-0.5"
                  onClick={(e) => handleCellClick(i, 'start', e)}
                  onDoubleClick={(e) => handleTimeDoubleClick(i, 'start', e)}
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
                  className="w-28 px-1 py-0.5"
                  onClick={(e) => handleCellClick(i, 'end', e)}
                  onDoubleClick={(e) => handleTimeDoubleClick(i, 'end', e)}
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
                <div className="w-14 px-1 py-0.5">
                  <span className={`text-xs font-mono ${cpsColor(calcCps(line.text, line.start_ms, line.end_ms))}`}>
                    {calcCps(line.text, line.start_ms, line.end_ms) < 0 ? '—' : calcCps(line.text, line.start_ms, line.end_ms)}
                  </span>
                </div>

                {/* Style */}
                <div className="w-24 px-1 py-0.5">
                  <span className="text-xs text-rh-muted truncate block">{line.ass_style}</span>
                </div>

                {/* Actor */}
                <div
                  className="w-28 px-1 py-0.5 flex items-center gap-1 relative"
                  onClick={(e) => handleCellClick(i, 'actor', e)}
                >
                  {editingCell?.row === i && editingCell.col === 'actor' ? (
                    teamActors.length > 0 ? (
                      <TeamActorDropdown
                        teamActors={teamActors}
                        characters={characters}
                        onPick={(a) => commitTeamActor(i, a)}
                        onClear={() => applyActorId(i, null)}
                        onCreateCustom={(name) => commitActor(i, name)}
                        onClose={() => setEditingCell(null)}
                      />
                    ) : (
                      <input
                        autoFocus
                        className="rh-input w-full text-xs py-0"
                        defaultValue={characters.find((c) => c.id === line.character_id)?.name ?? ''}
                        onBlur={(e) => commitActor(i, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Tab') commitActor(i, (e.target as HTMLInputElement).value) }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )
                  ) : (
                    <>
                      <span className="text-xs text-rh-text-dim truncate flex-1">
                        {characters.find((c) => c.id === line.character_id)?.name ?? '—'}
                      </span>
                      {teamActors.length === 0 && (
                        <QuickPickButton characters={characters} onPick={(id) => applyActorId(i, id)} />
                      )}
                    </>
                  )}
                </div>

                {/* Text — read-only here; edited via the persistent SubtitleEditBox above the grid */}
                <div
                  className="flex-1 min-w-0 px-1 py-0.5"
                  onClick={(e) => handleCellClick(i, 'text', e)}
                >
                  <span className={`text-xs truncate block leading-relaxed ${line.is_overlap ? 'text-violet-300' : 'text-rh-text'}`}>
                    {line.text.replace(/\{[^}]+\}/g, '').replace(/\\N/gi, ' ↵ ')}
                  </span>
                </div>

                {/* Delete */}
                <div className="w-8 flex-shrink-0 flex justify-center" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => onDeleteLine(line.id)}
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
        {lines.length > 0 && (
          <button onClick={onDeleteAll} className="rh-btn-ghost text-xs px-2 py-1 hover:text-red-400">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
            Видалити все
          </button>
        )}
        <span className="text-xs text-rh-muted">{lines.length} реплік</span>
        <span className="text-xs text-rh-muted">Оригінальний бітрейт та формат збережено</span>
        <span className="text-xs text-rh-muted ml-auto">автозбереження ✓</span>
      </div>
    </div>
  )
}
