import React, { useState, useEffect, useRef } from 'react'
import { Spinner } from '../ui/Spinner'
import type { SubtitleLine, Character, TeamActor } from '../../types'

// Duplicated per this codebase's existing convention (see e.g.
// ProfileModal.tsx's identical helper) — useApi's thrown Error carries the
// backend's JSON {"detail": "..."} body appended to its message.
function extractApiError(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  const match = e.message.match(/\{.*\}$/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (typeof parsed.detail === 'string') return parsed.detail
    } catch {
      /* not JSON — fall through to the raw message */
    }
  }
  return e.message
}

function msToTimecode(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function timecodeToMs(value: string): number | null {
  const parts = value.split(/[:.]/)
  if (parts.length < 4) return null
  const h = parseInt(parts[0]) || 0
  const m = parseInt(parts[1]) || 0
  const s = parseInt(parts[2]) || 0
  const cs = parseInt(parts[3]) || 0
  return (h * 3600 + m * 60 + s) * 1000 + cs * 10
}

// Aegisub toggles a tag for the whole selection; a plain <textarea> here has
// no per-run tag model to select against, so this toggles the tag for the
// WHOLE line instead — simpler, and still the common case for dubbing work
// (a line is rarely half-bold). Detected/inserted right at the start of the
// text, same place Aegisub's own {\b1} etc. end up for a line-wide toggle.
function hasTag(text: string, tag: string): boolean {
  const match = text.match(/^\{([^}]*)\}/)
  return !!match && new RegExp(`\\\\${tag}1`).test(match[1])
}
function toggleTag(text: string, tag: string): string {
  const match = text.match(/^\{([^}]*)\}/)
  const removeRe = new RegExp(`\\\\${tag}1`)
  if (match && removeRe.test(match[1])) {
    const inner = match[1].replace(removeRe, '')
    const rest = text.slice(match[0].length)
    return inner ? `{${inner}}${rest}` : rest
  }
  if (match) return `{${match[1]}\\${tag}1}` + text.slice(match[0].length)
  return `{\\${tag}1}` + text
}

// ASS override colors are `\c&HBBGGRR&` — byte order reversed from the usual
// #RRGGBB, and a plain hex swap of pairs, not a real color-space conversion.
const COLOR_TAG_RE = /\\c&H([0-9A-Fa-f]{6})&/
function getColorTag(text: string): string | null {
  const match = text.match(/^\{([^}]*)\}/)
  if (!match) return null
  const m = match[1].match(COLOR_TAG_RE)
  if (!m) return null
  const bgr = m[1]
  return `#${bgr.slice(4, 6)}${bgr.slice(2, 4)}${bgr.slice(0, 2)}`.toLowerCase()
}
function setColorTag(text: string, hexRgb: string): string {
  const rr = hexRgb.slice(1, 3), gg = hexRgb.slice(3, 5), bb = hexRgb.slice(5, 7)
  const assColor = `\\c&H${bb}${gg}${rr}&`.toUpperCase().replace('\\C', '\\c')
  const match = text.match(/^\{([^}]*)\}/)
  if (match) {
    const inner = COLOR_TAG_RE.test(match[1]) ? match[1].replace(COLOR_TAG_RE, assColor) : match[1] + assColor
    return `{${inner}}` + text.slice(match[0].length)
  }
  return `{${assColor}}` + text
}
function clearColorTag(text: string): string {
  const match = text.match(/^\{([^}]*)\}/)
  if (!match) return text
  const inner = match[1].replace(COLOR_TAG_RE, '')
  const rest = text.slice(match[0].length)
  return inner ? `{${inner}}${rest}` : rest
}

// "Number of characters in the longest line of this subtitle" — Aegisub's
// own char_count tooltip. Splits on \N (ASS's literal line-break escape,
// not a real newline) since a wrapped multi-line subtitle's CPS/readability
// limit is per displayed line, not the sum across all of them.
function longestLineLength(text: string): number {
  const clean = text.replace(/\{[^}]*\}/g, '')
  return Math.max(0, ...clean.split(/\\N/i).map((l) => l.length))
}

interface SubtitleEditBoxProps {
  line: SubtitleLine | null
  characters: Character[]
  teamActors: TeamActor[]
  styleOptions: string[]
  onCommitText: (id: number, text: string) => void
  onFieldChange: (id: number, changes: Partial<SubtitleLine>) => void
  onCreateCharacter: (name: string) => Promise<Character | null>
  onPickTeamActor: (deviceId: string, displayName: string) => Promise<Character | null>
  onAdvance: () => void
  // Alt+Up navigates to the previous line — bare Up/Down stay reserved for
  // normal cursor movement inside multi-line (\N-containing) text, so this
  // needs a modifier rather than overriding them outright. Alt+Down reuses
  // onAdvance (identical "commit and move forward" behavior to Enter).
  onNavigatePrev?: () => void
  // App-level undo (same handler SubtitleGrid uses) — the grid's own
  // Ctrl+Z listener explicitly ignores keydowns while any input/textarea is
  // focused (so it doesn't fight normal text-field editing), but now that
  // typing happens here rather than inline in the grid, that guard meant
  // Ctrl+Z silently did nothing for most of a translator's session
  // (confirmed live 2026-08-16). Handled here instead, only while this box
  // itself has focus.
  onUndo?: () => void
  onRedo?: () => void
  // Optional and only rendered when passed — the natural per-caller opt-in
  // that keeps the Translate buttons out of EpisodeWorkspace (which won't
  // pass this prop) with no role-check branching needed inside this shared
  // component. Returns the translated text (or null/throws on failure) —
  // this component owns applying it to `draft` as an editable suggestion,
  // never auto-committing it (see handleTranslate below).
  onTranslate?: (id: number, provider: 'deepl' | 'gpt' | 'gemini' | 'mymemory') => Promise<string | null>
}

// Aegisub's actual day-to-day workflow: one persistent, always-visible text
// box bound to the current line — type, hit Enter, land on the next line
// already selected, keep typing — plus the toolbar rows above it. Layout
// mirrors Aegisub's own SubsEditBox sizer structure (src/subs_edit_box.cpp):
// top row (style/actor/char count), middle-left row (layer/timing/margins),
// middle-right row (style-toggle buttons) — trimmed to what a dubbing studio
// actually uses: no Comment/Effect fields, no font picker, no secondary/
// outline/shadow colors, no karaoke split buttons, no Automation. Standalone
// component (not folded into SubtitleGrid, which already owns its own
// independent multi-select/undo/copy-paste keydown handling) so the two
// never fight over which one is "the" text editor for a row.
export function SubtitleEditBox({
  line,
  characters,
  teamActors,
  styleOptions,
  onCommitText,
  onFieldChange,
  onCreateCharacter,
  onPickTeamActor,
  onAdvance,
  onNavigatePrev,
  onUndo,
  onRedo,
  onTranslate,
}: SubtitleEditBoxProps) {
  const [draft, setDraft] = useState('')
  const [actorDraft, setActorDraft] = useState('')
  // Team-actor <select> vs. free-text "Свій варіант…" entry — see the
  // Актор field below. Reset whenever the active line changes so switching
  // lines doesn't stay stuck showing the text input for a line that
  // already has a team actor assigned.
  const [customMode, setCustomMode] = useState(false)
  const [translating, setTranslating] = useState<'deepl' | 'gpt' | 'gemini' | 'mymemory' | null>(null)
  const [translateError, setTranslateError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Keyed on the line's id AND text — id alone would miss an external
  // revert (Ctrl+Z, or a waveform drag-retime committing elsewhere) that
  // changes the SAME line's content without switching which line is
  // active; re-running on every text change is safe here because a normal
  // commit already sets the parent's state to match `draft` synchronously
  // (see handleSubLineChange's optimistic update in both workspaces), so
  // this only ever "resets" the box to what it already showed.
  useEffect(() => {
    setDraft(line?.text ?? '')
    setActorDraft(characters.find((c) => c.id === line?.character_id)?.name ?? '')
    setTranslateError(null)
    setCustomMode(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line?.id, line?.text])

  function commit() {
    if (line) onCommitText(line.id, draft)
  }

  // Fills `draft` with the result as an editable suggestion — deliberately
  // does NOT call onCommitText itself, so a bad/partial machine translation
  // never lands in the DB without the translator reviewing it first (Enter
  // commits normally afterward, same as any hand-typed edit).
  async function handleTranslate(provider: 'deepl' | 'gpt' | 'gemini' | 'mymemory') {
    if (!line || !onTranslate) return
    setTranslating(provider)
    setTranslateError(null)
    try {
      const result = await onTranslate(line.id, provider)
      if (result != null) setDraft(result)
    } catch (e) {
      setTranslateError(extractApiError(e, 'Не вдалося перекласти'))
    } finally {
      setTranslating(null)
    }
  }

  async function commitActor() {
    if (!line) return
    const name = actorDraft.trim()
    if (!name) {
      onFieldChange(line.id, { character_id: null })
      return
    }
    const existing = characters.find((c) => c.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      onFieldChange(line.id, { character_id: existing.id })
      return
    }
    const created = await onCreateCharacter(name)
    if (created) onFieldChange(line.id, { character_id: created.id })
  }

  async function pickTeamActor(deviceId: string) {
    if (!line) return
    if (!deviceId) {
      onFieldChange(line.id, { character_id: null })
      return
    }
    const existing = characters.find((c) => c.team_device_id === deviceId)
    if (existing) {
      onFieldChange(line.id, { character_id: existing.id })
      return
    }
    const actor = teamActors.find((a) => a.device_id === deviceId)
    if (!actor) return
    const created = await onPickTeamActor(actor.device_id, actor.display_name)
    if (created) onFieldChange(line.id, { character_id: created.id })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commit()
      onAdvance()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(line?.text ?? '')
      textareaRef.current?.blur()
      return
    }
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault()
      commit()
      onAdvance()
      return
    }
    if (e.altKey && e.key === 'ArrowUp' && onNavigatePrev) {
      e.preventDefault()
      commit()
      onNavigatePrev()
      return
    }
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key.toLowerCase() === 'z' && e.shiftKey && onRedo) {
      e.preventDefault()
      onRedo()
      return
    }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z' && onUndo) {
      e.preventDefault()
      onUndo()
      return
    }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      setDraft((d) => toggleTag(d, 'b'))
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      setDraft((d) => toggleTag(d, 'i'))
    } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'u') {
      e.preventDefault()
      setDraft((d) => toggleTag(d, 'u'))
    }
  }

  function numberField(label: string, value: number, onSet: (v: number) => void) {
    return (
      <label className="flex items-center gap-1 text-[10px] text-rh-muted">
        {label}
        <input
          type="number"
          className="rh-input w-12 text-xs py-0.5 px-1"
          value={value}
          disabled={!line}
          onChange={(e) => onSet(parseInt(e.target.value) || 0)}
        />
      </label>
    )
  }

  const duration = line ? line.end_ms - line.start_ms : 0
  const currentColor = getColorTag(draft)

  return (
    <div className="flex-shrink-0 border-b border-rh-border bg-rh-card2 px-2 py-1.5 flex flex-col gap-1">
      {/* Top row — style, actor, character count (Aegisub: style_box/actor_box/char_count in top_sizer) */}
      <div className="flex items-center gap-x-2">
        <label className="flex items-center gap-1 text-[10px] text-rh-muted">
          Стиль
          <select
            className="rh-input text-xs py-0.5 px-1"
            value={line?.ass_style ?? 'Default'}
            disabled={!line}
            onChange={(e) => line && onFieldChange(line.id, { ass_style: e.target.value })}
          >
            {styleOptions.length === 0 && <option value="Default">Default</option>}
            {styleOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-[10px] text-rh-muted flex-1 min-w-0">
          Актор
          {teamActors.length > 0 && !customMode ? (
            <select
              className="rh-input flex-1 min-w-0 text-xs py-0.5 px-1"
              value={(() => {
                const cur = characters.find((c) => c.id === line?.character_id)
                if (!cur) return ''
                return cur.team_device_id ?? `__char_${cur.id}__`
              })()}
              disabled={!line}
              onChange={(e) => {
                const v = e.target.value
                if (v === '__custom__') { setCustomMode(true); return }
                if (v.startsWith('__char_')) {
                  onFieldChange(line!.id, { character_id: Number(v.slice(7, -2)) })
                  return
                }
                pickTeamActor(v)
              }}
            >
              <option value="">— Без актора</option>
              {teamActors.map((a) => (
                <option key={a.device_id} value={a.device_id}>{a.display_name}</option>
              ))}
              {/* Non-team entries (on-screen signs/text, narrator, "GM"…)
                  that were never going to be real team members — the
                  team-actor list alone can't cover those. */}
              {characters.filter((c) => !c.team_device_id).map((c) => (
                <option key={c.id} value={`__char_${c.id}__`}>{c.name} (не з команди)</option>
              ))}
              <option value="__custom__">— Свій варіант…</option>
            </select>
          ) : (
            <div className="flex-1 min-w-0 flex items-center gap-1">
              <input
                autoFocus={customMode}
                className="rh-input flex-1 min-w-0 text-xs py-0.5 px-1"
                value={actorDraft}
                disabled={!line}
                onChange={(e) => setActorDraft(e.target.value)}
                onBlur={commitActor}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitActor() }
                  if (e.key === 'Escape' && teamActors.length > 0) { e.preventDefault(); setCustomMode(false) }
                }}
              />
              {teamActors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCustomMode(false)}
                  className="text-rh-muted hover:text-rh-text text-xs flex-shrink-0"
                  title="Повернутись до списку акторів команди"
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </label>

        <span
          className="text-[10px] text-rh-muted font-mono flex-shrink-0"
          title="Кількість символів у найдовшому рядку репліки"
        >
          {longestLineLength(draft)} симв.
        </span>

        {onTranslate && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              title="Перекласти цю репліку через DeepL"
              disabled={!line || translating != null}
              onClick={() => handleTranslate('deepl')}
              className="rh-btn-outline text-[10px] py-0.5 px-1.5 flex items-center gap-1"
            >
              {translating === 'deepl' ? <Spinner size={9} /> : null}
              DeepL
            </button>
            <button
              type="button"
              title="Перекласти цю репліку через GPT"
              disabled={!line || translating != null}
              onClick={() => handleTranslate('gpt')}
              className="rh-btn-outline text-[10px] py-0.5 px-1.5 flex items-center gap-1"
            >
              {translating === 'gpt' ? <Spinner size={9} /> : null}
              GPT
            </button>
            <button
              type="button"
              title="Перекласти цю репліку через Gemini — сильний саме для української серед LLM за бенчмарками 2026"
              disabled={!line || translating != null}
              onClick={() => handleTranslate('gemini')}
              className="rh-btn-outline text-[10px] py-0.5 px-1.5 flex items-center gap-1"
            >
              {translating === 'gemini' ? <Spinner size={9} /> : null}
              Gemini
            </button>
            <button
              type="button"
              title="Перекласти цю репліку через MyMemory — безкоштовно, без ключа, але без контексту сусідніх реплік і якість нижча за DeepL/GPT/Gemini"
              disabled={!line || translating != null}
              onClick={() => handleTranslate('mymemory')}
              className="rh-btn-outline text-[10px] py-0.5 px-1.5 flex items-center gap-1"
            >
              {translating === 'mymemory' ? <Spinner size={9} /> : null}
              MyMemory
            </button>
          </div>
        )}
      </div>

      {translateError && (
        <div className="text-[11px] text-[#FF6B70] flex items-center gap-1.5">
          <span className="flex-1">{translateError}</span>
          <button onClick={() => setTranslateError(null)} className="text-rh-muted hover:text-white flex-shrink-0">✕</button>
        </div>
      )}

      {/* Middle-left row — layer, timing, margins (Aegisub: middle_left_sizer) */}
      <div className="flex items-center gap-x-2 flex-wrap">
        {numberField('Layer', line?.layer ?? 0, (v) => line && onFieldChange(line.id, { layer: v }))}
        <label className="flex items-center gap-1 text-[10px] text-rh-muted">
          Початок
          <input
            className="rh-input w-24 text-xs font-mono py-0.5 px-1"
            defaultValue={line ? msToTimecode(line.start_ms) : ''}
            key={`start-${line?.id}`}
            disabled={!line}
            onBlur={(e) => {
              const ms = timecodeToMs(e.target.value)
              if (line && ms != null) onFieldChange(line.id, { start_ms: ms })
            }}
          />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-rh-muted">
          Кінець
          <input
            className="rh-input w-24 text-xs font-mono py-0.5 px-1"
            defaultValue={line ? msToTimecode(line.end_ms) : ''}
            key={`end-${line?.id}`}
            disabled={!line}
            onBlur={(e) => {
              const ms = timecodeToMs(e.target.value)
              if (line && ms != null) onFieldChange(line.id, { end_ms: ms })
            }}
          />
        </label>
        <span className="text-[10px] text-rh-muted font-mono">{(duration / 1000).toFixed(2)}с</span>
        {numberField('ML', line?.margin_l ?? 0, (v) => line && onFieldChange(line.id, { margin_l: v }))}
        {numberField('MR', line?.margin_r ?? 0, (v) => line && onFieldChange(line.id, { margin_r: v }))}
        {numberField('MV', line?.margin_v ?? 0, (v) => line && onFieldChange(line.id, { margin_v: v }))}
      </div>

      {/* Middle-right row — style-toggle buttons (Aegisub: middle_right_sizer, trimmed to non-fansub subset) */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          title="Жирний (Ctrl+B)"
          disabled={!line}
          onClick={() => setDraft((d) => toggleTag(d, 'b'))}
          className={`w-6 h-6 flex items-center justify-center rounded text-xs font-bold ${line && hasTag(draft, 'b') ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-rh-text'}`}
        >
          B
        </button>
        <button
          type="button"
          title="Курсив (Ctrl+I)"
          disabled={!line}
          onClick={() => setDraft((d) => toggleTag(d, 'i'))}
          className={`w-6 h-6 flex items-center justify-center rounded text-xs italic ${line && hasTag(draft, 'i') ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-rh-text'}`}
        >
          I
        </button>
        <button
          type="button"
          title="Підкреслення (Ctrl+U)"
          disabled={!line}
          onClick={() => setDraft((d) => toggleTag(d, 'u'))}
          className={`w-6 h-6 flex items-center justify-center rounded text-xs underline ${line && hasTag(draft, 'u') ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-rh-text'}`}
        >
          U
        </button>
        <button
          type="button"
          title="Закреслення"
          disabled={!line}
          onClick={() => setDraft((d) => toggleTag(d, 's'))}
          className={`w-6 h-6 flex items-center justify-center rounded text-xs line-through ${line && hasTag(draft, 's') ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-rh-text'}`}
        >
          S
        </button>

        <div className="w-px h-4 bg-rh-border mx-1" />

        <label
          className="w-6 h-6 rounded flex items-center justify-center cursor-pointer border border-rh-border overflow-hidden flex-shrink-0"
          title="Колір тексту цієї репліки"
          style={{ background: currentColor ?? 'transparent' }}
        >
          {!currentColor && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-rh-muted">
              <circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/>
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 011.688-1.688h1.996c3.051 0 5.555-2.503 5.555-5.554C22 6.012 17.461 2 12 2z"/>
            </svg>
          )}
          <input
            type="color"
            className="opacity-0 w-0 h-0"
            disabled={!line}
            value={currentColor ?? '#ffffff'}
            onChange={(e) => setDraft((d) => setColorTag(d, e.target.value))}
          />
        </label>
        {currentColor && (
          <button
            type="button"
            title="Прибрати колір (повернутись до стилю)"
            disabled={!line}
            onClick={() => setDraft((d) => clearColorTag(d))}
            className="w-4 h-4 flex items-center justify-center text-rh-muted hover:text-red-400 text-[10px] leading-none"
          >
            ✕
          </button>
        )}
      </div>

      <textarea
        ref={textareaRef}
        className="rh-input w-full text-sm resize-none font-sans"
        rows={2}
        placeholder={line ? 'Текст репліки…' : 'Оберіть репліку'}
        value={draft}
        disabled={!line}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
      />
    </div>
  )
}
