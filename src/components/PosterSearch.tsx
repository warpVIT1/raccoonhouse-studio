import React, { useState } from 'react'
import { useApi } from '../hooks/useApi'
import { Spinner } from './ui/Spinner'
import type { HikkaAnimeResult } from '../types'

interface PosterSearchProps {
  defaultQuery?: string
  selected: HikkaAnimeResult | null
  onSelect: (result: HikkaAnimeResult | null) => void
}

export function PosterSearch({ defaultQuery, selected, onSelect }: PosterSearchProps) {
  const { get } = useApi()
  const [query, setQuery] = useState(defaultQuery ?? '')
  const [results, setResults] = useState<HikkaAnimeResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runSearch() {
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      const list = await get<HikkaAnimeResult[]>(`/hikka/search?query=${encodeURIComponent(query.trim())}`)
      setResults(list)
      setSearched(true)
    } catch {
      setError('Не вдалося виконати пошук — перевірте з’єднання з інтернетом.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <label className="text-xs text-rh-muted block">Постер (Hikka)</label>
      <div className="flex gap-2">
        <input
          className="rh-input flex-1"
          placeholder="Назва для пошуку постера..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch() } }}
        />
        <button type="button" onClick={runSearch} className="rh-btn-outline flex-shrink-0" disabled={loading || !query.trim()}>
          {loading ? <Spinner size={14} /> : 'Шукати'}
        </button>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {selected && (
        <div className="flex items-center gap-2 rounded-lg border border-rh-accent/40 bg-rh-accent/5 px-2.5 py-2">
          {selected.image && (
            <img src={selected.image} alt="" className="w-8 h-11 object-cover rounded flex-shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{selected.title_ua || selected.title_en}</div>
            <div className="text-[10.5px] text-rh-muted truncate">{selected.title_en}</div>
          </div>
          <button type="button" onClick={() => onSelect(null)} className="text-[10.5px] text-rh-muted hover:text-white flex-shrink-0">
            Прибрати
          </button>
        </div>
      )}

      {searched && !loading && results.length === 0 && !error && (
        <div className="text-xs text-rh-muted">Нічого не знайдено на Hikka.</div>
      )}

      {results.length > 0 && (
        <div className="grid grid-cols-4 gap-2 max-h-56 overflow-y-auto">
          {results.map((r) => (
            <button
              type="button"
              key={r.slug ?? r.title_en ?? Math.random()}
              onClick={() => onSelect(r)}
              className={`flex flex-col gap-1 rounded-lg overflow-hidden border transition-colors text-left
                ${selected?.slug === r.slug ? 'border-rh-accent' : 'border-transparent hover:border-rh-border2'}`}
            >
              <div className="aspect-[3/4] bg-rh-card2">
                {r.image ? (
                  <img src={r.image} alt="" className="w-full h-full object-cover" />
                ) : null}
              </div>
              <div className="text-[10px] leading-tight px-0.5 pb-0.5 line-clamp-2 text-rh-text-dim">
                {r.title_ua || r.title_en}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
