import React, { useRef, useState } from 'react'
import { Spinner } from '../ui/Spinner'
import { useAppStore } from '../../stores/appStore'
import { imageBlobToDataUrl, isHttpsUrl, resolveCharacterImage } from '../../lib/characterImage'
import type { Character, CharacterImageCandidate, TeamActor } from '../../types'

interface RoleCardProps {
  character: Character
  candidates: CharacterImageCandidate[]
  teamActors: TeamActor[]
  sending: boolean
  onRename: (name: string) => void
  onAssignActor: (deviceId: string | null) => void
  onSendToActor: () => void
  onRemove: () => void
  onPickImage: (url: string | null) => void
  onUploadImage: (dataUrl: string) => Promise<void>
}

const SOURCE_LABEL: Record<string, string> = { hikka: 'Hikka', anilist: 'AniList', jikan: 'MAL' }

// One role as a poster-style card (same look as the title cards): portrait on
// top, name, actor picker, and the actions. The portrait can be set by hand:
// click for the menu (upload / paste / link / candidates), or just drop a file
// on it, or focus the card and press Ctrl+V with an image or link in the clipboard.
export function RoleCard({
  character, candidates, teamActors, sending,
  onRename, onAssignActor, onSendToActor, onRemove, onPickImage, onUploadImage,
}: RoleCardProps) {
  const backendPort = useAppStore((s) => s.backendPort)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [linkMode, setLinkMode] = useState(false)
  const [linkDraft, setLinkDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const imageSrc = resolveCharacterImage(character.image_url, backendPort)
  const orig = character.source_name && character.source_name !== character.name ? character.source_name : null
  const everyone = character.team_device_id === 'everyone'

  async function uploadBlob(blob: Blob) {
    setBusy(true)
    setError(null)
    try {
      await onUploadImage(await imageBlobToDataUrl(blob))
      setMenuOpen(false)
    } catch {
      setError('Не вдалося обробити зображення')
    } finally {
      setBusy(false)
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (file && file.type.startsWith('image/')) void uploadBlob(file)
    else if (file) setError('Це не зображення')
  }

  async function pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (type) {
          await uploadBlob(await item.getType(type))
          return
        }
      }
      const text = await navigator.clipboard.readText()
      if (isHttpsUrl(text)) {
        onPickImage(text.trim())
        setMenuOpen(false)
        return
      }
      setError('У буфері немає зображення чи посилання')
    } catch {
      setError('Немає доступу до буфера — натисніть Ctrl+V на картці')
    }
  }

  function onCardPaste(e: React.ClipboardEvent) {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return // normal text paste
    const imageItem = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))
    if (imageItem) {
      const file = imageItem.getAsFile()
      if (file) {
        e.preventDefault()
        void uploadBlob(file)
      }
      return
    }
    const text = e.clipboardData.getData('text')
    if (isHttpsUrl(text)) {
      e.preventDefault()
      onPickImage(text.trim())
    }
  }

  function commitName() {
    const next = nameDraft.trim()
    setEditing(false)
    if (next && next !== character.name) onRename(next)
  }

  return (
    <div
      tabIndex={0}
      onPaste={onCardPaste}
      className="relative flex flex-col rounded-2xl border border-rh-border bg-rh-card p-3 gap-2.5 outline-none focus-within:border-rh-accent/60 focus:border-rh-accent/60"
    >
      {/* Portrait */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
          title="Клік — вибрати картинку; можна перетягнути файл сюди"
          className={`group relative block w-full aspect-[3/4] rounded-xl overflow-hidden border bg-rh-bg ${
            dragOver ? 'border-rh-accent' : 'border-rh-border'
          }`}
        >
          {imageSrc ? (
            <img src={imageSrc} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-rh-muted">
              <span className="text-4xl font-bold">{character.name.slice(0, 1).toUpperCase()}</span>
              <span className="text-[11px]">Додати фото</span>
            </div>
          )}
          <span className="absolute inset-x-0 bottom-0 bg-black/60 text-[11px] text-white py-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {busy ? 'Завантаження…' : 'Змінити фото'}
          </span>
          {!imageSrc && candidates.length > 0 && (
            <span className="absolute top-1.5 right-1.5 rounded-full bg-amber-400 text-black text-[10px] font-bold px-1.5 py-0.5">
              {candidates.length} варіанти
            </span>
          )}
          {busy && (
            <span className="absolute inset-0 bg-black/50 flex items-center justify-center"><Spinner size={18} /></span>
          )}
        </button>

        {menuOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 w-[260px] max-w-[90vw] bg-rh-card border border-rh-border rounded-xl shadow-xl p-2 flex flex-col gap-1">
            <button type="button" onClick={() => fileInputRef.current?.click()} className="text-left text-[12px] rounded-lg px-2 py-1.5 hover:bg-rh-bg">
              📁 Завантажити файл…
            </button>
            <button type="button" onClick={pasteFromClipboard} className="text-left text-[12px] rounded-lg px-2 py-1.5 hover:bg-rh-bg">
              📋 Вставити з буфера (Ctrl+V)
            </button>
            {linkMode ? (
              <div className="flex gap-1 px-1">
                <input
                  autoFocus
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  placeholder="https://…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isHttpsUrl(linkDraft)) { onPickImage(linkDraft.trim()); setMenuOpen(false); setLinkMode(false); setLinkDraft('') }
                    if (e.key === 'Escape') setLinkMode(false)
                  }}
                  className="flex-1 min-w-0 bg-rh-bg border border-rh-border rounded px-1.5 py-1 text-[11px]"
                />
                <button
                  type="button"
                  disabled={!isHttpsUrl(linkDraft)}
                  onClick={() => { onPickImage(linkDraft.trim()); setMenuOpen(false); setLinkMode(false); setLinkDraft('') }}
                  className="rh-btn-primary text-[11px] px-2 disabled:opacity-40"
                >
                  OK
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setLinkMode(true)} className="text-left text-[12px] rounded-lg px-2 py-1.5 hover:bg-rh-bg">
                🔗 Вставити посилання…
              </button>
            )}

            {candidates.length > 0 && (
              <>
                <div className="text-[10.5px] text-rh-muted px-2 pt-1">Знайдені варіанти</div>
                {candidates.map((c) => (
                  <button
                    key={`${c.source}-${c.slug ?? c.image}`}
                    type="button"
                    onClick={() => { onPickImage(c.image); setMenuOpen(false) }}
                    className={`flex items-center gap-2 text-left rounded-lg px-2 py-1.5 hover:bg-rh-bg ${
                      character.image_url === c.image ? 'ring-1 ring-rh-accent' : ''
                    }`}
                  >
                    <img src={c.image} alt="" className="w-9 h-12 object-cover rounded flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-semibold truncate">{c.name_ua || c.name_en}</div>
                      <div className="text-[10.5px] text-rh-muted truncate">
                        {[c.name_en, c.name_ja].filter((x) => x && x !== (c.name_ua || c.name_en)).join(' · ')}
                      </div>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <div className="text-[10.5px] text-rh-muted">{Math.round(c.score * 100)}%</div>
                      <div className="text-[9.5px] text-rh-muted">{SOURCE_LABEL[c.source] ?? c.source}</div>
                    </div>
                  </button>
                ))}
              </>
            )}

            {character.image_url && (
              <button type="button" onClick={() => { onPickImage(null); setMenuOpen(false) }} className="text-left text-[12px] text-red-400 hover:text-red-300 rounded-lg px-2 py-1.5 hover:bg-rh-bg">
                ✕ Прибрати картинку
              </button>
            )}
            {error && <div className="text-[11px] text-red-400 px-2">{error}</div>}
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }} />
      </div>

      {/* Name */}
      <div className="min-w-0">
        {editing ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-full bg-rh-bg border border-rh-accent rounded px-1.5 py-0.5 text-[13px] font-bold"
          />
        ) : (
          <div className="flex items-start gap-1">
            <div
              className="flex-1 min-w-0 text-[13.5px] font-bold break-words select-text cursor-text"
              onDoubleClick={() => { setEditing(true); setNameDraft(character.name) }}
              title="Подвійний клік — перейменувати"
            >
              {character.name}
              {character.code && <span className="ml-1.5 text-[10.5px] font-mono text-rh-muted font-normal">{character.code}</span>}
            </div>
            <button type="button" onClick={() => { setEditing(true); setNameDraft(character.name) }} title="Перейменувати (наприклад, українською)" className="text-[11px] text-rh-muted hover:text-white">✎</button>
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(character.source_name || character.name) }}
              title="Скопіювати ім'я (щоб вставити в перекладач)"
              className="text-[11px] text-rh-muted hover:text-white"
            >
              📋
            </button>
          </div>
        )}
        <div className="text-[11px] text-rh-muted select-text truncate">
          {orig ? `${orig} · ` : ''}{(character.line_count ?? 0)} реплік
        </div>
      </div>

      {/* Actor */}
      <select
        value={character.team_device_id ?? ''}
        onChange={(e) => onAssignActor(e.target.value || null)}
        className="w-full bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[12px]"
      >
        <option value="">— без актора —</option>
        {teamActors.map((a) => (
          <option key={a.device_id} value={a.device_id}>{a.display_name}</option>
        ))}
      </select>

      <button
        type="button"
        onClick={onSendToActor}
        disabled={!character.team_device_id || everyone || sending}
        title="Надіслати відео та субтитри тільки цьому актору"
        className="rh-btn-outline w-full text-[12px] py-1.5 disabled:opacity-30 flex items-center justify-center gap-1.5"
      >
        {sending ? <Spinner size={11} /> : '📨'} Надіслати актору
      </button>

      <button type="button" onClick={onRemove} className="text-[11px] text-rh-muted hover:text-red-400 text-center">
        Видалити роль
      </button>
    </div>
  )
}
