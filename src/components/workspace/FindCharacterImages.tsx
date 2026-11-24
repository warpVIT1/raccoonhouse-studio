import React, { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { Spinner } from '../ui/Spinner'
import type { CharacterImageSuggestion, HikkaAnimeResult, Title } from '../../types'

interface FindCharacterImagesProps {
  titleId: number
  titleName: string
  onResult: (suggestions: CharacterImageSuggestion[]) => void
  onError: (message: string) => void
}

function errorText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : ''
  return msg || fallback
}

// "Знайти картинки": looks up this title's characters on Hikka. The title must
// first be tied to a specific Hikka anime (that is what makes the match exact
// rather than a guess by name) — if it isn't yet, the director picks it here
// once and it is remembered on the title.
export function FindCharacterImages({ titleId, titleName, onResult, onError }: FindCharacterImagesProps) {
  const { get, post, put } = useApi()
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState(titleName)
  const [results, setResults] = useState<HikkaAnimeResult[]>([])
  const [searching, setSearching] = useState(false)

  async function run() {
    setBusy(true)
    try {
      const title = await get<Title>(`/titles/${titleId}`)
      if (!title.hikka_slug) {
        setPicking(true)
        return
      }
      onResult(await post<CharacterImageSuggestion[]>(`/titles/${titleId}/find-character-images`, {}))
    } catch (e) {
      onError(errorText(e, 'Не вдалося знайти картинки персонажів'))
    } finally {
      setBusy(false)
    }
  }

  async function search() {
    if (!query.trim()) return
    setSearching(true)
    try {
      setResults(await get<HikkaAnimeResult[]>(`/hikka/search?query=${encodeURIComponent(query.trim())}`))
    } catch {
      onError('Не вдалося виконати пошук — перевірте з’єднання з інтернетом.')
    } finally {
      setSearching(false)
    }
  }

  async function choose(anime: HikkaAnimeResult) {
    if (!anime.slug) return
    setPicking(false)
    setBusy(true)
    try {
      await put(`/titles/${titleId}/hikka-slug`, { slug: anime.slug })
      onResult(await post<CharacterImageSuggestion[]>(`/titles/${titleId}/find-character-images`, {}))
    } catch (e) {
      onError(errorText(e, 'Не вдалося знайти картинки персонажів'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-1.5">
        {/* Re-pick lets the director fix a wrongly matched anime. */}
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          title="Вибрати інше аніме на Hikka"
          className="text-[10.5px] text-rh-muted hover:text-white"
        >
          змінити аніме
        </button>
        <button type="button" onClick={run} disabled={busy} className="rh-btn-outline text-[11px] px-2.5 py-1 flex items-center gap-1">
          {busy ? <Spinner size={10} /> : '🖼'} Знайти картинки
        </button>
      </div>

      {picking && (
        <div className="w-[420px] max-w-full bg-rh-bg border border-rh-border rounded-xl p-2.5 flex flex-col gap-2">
          <div className="text-[11px] text-rh-muted">Виберіть аніме на Hikka — з нього візьмемо портрети персонажів.</div>
          <div className="flex gap-2">
            <input
              className="rh-input flex-1"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search() } }}
            />
            <button type="button" onClick={search} disabled={searching || !query.trim()} className="rh-btn-outline flex-shrink-0">
              {searching ? <Spinner size={14} /> : 'Шукати'}
            </button>
          </div>
          <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
            {results.map((r) => (
              <button
                key={r.slug ?? r.title_en ?? ''}
                type="button"
                onClick={() => choose(r)}
                className="flex items-center gap-2 text-left rounded-lg px-2 py-1.5 hover:bg-rh-card"
              >
                {r.image && <img src={r.image} alt="" className="w-8 h-11 object-cover rounded flex-shrink-0" />}
                <div className="min-w-0">
                  <div className="text-[12px] font-medium truncate">{r.title_ua || r.title_en}</div>
                  <div className="text-[10.5px] text-rh-muted truncate">{r.title_en}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
