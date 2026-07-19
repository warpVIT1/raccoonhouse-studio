import React, { useEffect, useState, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { TitleBadge } from './ui/Badge'
import { Spinner } from './ui/Spinner'
import { PosterSearch } from './PosterSearch'
import { posterSrc } from '../lib/poster'
import type { Title, TitleStatus, HikkaAnimeResult } from '../types'

const STATUS_FILTER_OPTIONS: Array<{ value: TitleStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Всі' },
  { value: 'in_progress', label: 'В роботі' },
  { value: 'done', label: 'Завершені' },
]

export function TitlesPage() {
  const { get, del } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const setSelectedTitle = useAppStore((s) => s.setSelectedTitle)

  const [titles, setTitles] = useState<Title[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<TitleStatus | 'all'>('all')
  const [showAddModal, setShowAddModal] = useState(false)

  useEffect(() => {
    if (!backendReady) return
    setLoading(true)
    get<Title[]>('/titles')
      .then(setTitles)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [backendReady, get])

  async function handleDeleteTitle(id: number) {
    try {
      await del(`/titles/${id}`)
      setTitles((prev) => prev.filter((t) => t.id !== id))
    } catch {
      // ignore
    }
  }

  const filtered = titles.filter((t) => {
    const matchSearch =
      t.name_ua.toLowerCase().includes(search.toLowerCase()) ||
      t.name_original.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || t.status === statusFilter
    return matchSearch && matchStatus
  })

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-rh-border flex-shrink-0">
        <h1 className="text-lg font-semibold text-rh-text">Тайтли</h1>
        <span className="text-sm text-rh-muted font-mono">{filtered.length} із {titles.length}</span>

        <div className="ml-auto flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-rh-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
            <input
              className="rh-input pl-8 w-52"
              placeholder="Пошук тайтлу..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Status filter */}
          <div className="flex gap-1">
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors
                  ${statusFilter === opt.value
                    ? 'bg-rh-accent text-white'
                    : 'text-rh-muted hover:text-rh-text hover:bg-white/5'
                  }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Add button */}
          <button
            onClick={() => setShowAddModal(true)}
            className="rh-btn-primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Додати тайтл
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Spinner size={24} className="text-rh-accent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-rh-muted gap-2">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3H8L2 7h20l-6-4z"/>
            </svg>
            <span className="text-sm">Тайтлів не знайдено</span>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {filtered.map((title) => (
              <TitleCard
                key={title.id}
                title={title}
                onClick={() => setSelectedTitle(title.id)}
                onDelete={() => handleDeleteTitle(title.id)}
              />
            ))}
          </div>
        )}
      </div>

      {showAddModal && (
        <AddTitleModal
          onClose={() => setShowAddModal(false)}
          onAdded={(t) => {
            setTitles((prev) => [...prev, t])
            setShowAddModal(false)
          }}
        />
      )}
    </div>
  )
}

interface TitleCardProps {
  title: Title
  onClick: () => void
  onDelete: () => void
}
function TitleCard({ title, onClick, onDelete }: TitleCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  return (
    <div
      onClick={onClick}
      className="rh-card flex flex-col overflow-hidden hover:border-rh-border2 transition-all duration-150 text-left group cursor-pointer relative"
    >
      {/* Poster */}
      <div className="aspect-[3/4] bg-rh-card2 relative overflow-hidden">
        {title.poster_path ? (
          <img
            src={posterSrc(title.poster_path)}
            alt={title.name_ua}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#38383F" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <path d="M21 15l-5-5L5 21"/>
            </svg>
          </div>
        )}
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-rh-accent/0 group-hover:bg-rh-accent/10 transition-colors duration-150" />

        {/* Delete button */}
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true) }}
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-lg bg-black/60 backdrop-blur-sm text-white/80 hover:bg-rh-accent hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs"
          title="Видалити тайтл"
        >
          ✕
        </button>

        {confirmingDelete && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-2 p-3 text-center"
          >
            <span className="text-xs text-white">Видалити «{title.name_ua}»?</span>
            <div className="flex gap-2">
              <button onClick={() => setConfirmingDelete(false)} className="rh-btn-ghost text-[11px] px-2 py-1">Скасувати</button>
              <button onClick={onDelete} className="bg-rh-accent hover:bg-rh-accent-h text-white text-[11px] px-2 py-1 rounded-md font-semibold">Видалити</button>
            </div>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3 flex flex-col gap-1.5">
        <div className="font-medium text-sm text-rh-text leading-tight line-clamp-1">
          {title.name_ua}
        </div>
        <div className="text-xs text-rh-muted line-clamp-1">{title.name_original}</div>
        <div className="flex items-center justify-between mt-0.5">
          <TitleBadge status={title.status} />
          <span className="text-xs text-rh-muted">
            {title.episode_count ?? 0} еп.
          </span>
        </div>
      </div>
    </div>
  )
}

interface AddTitleModalProps {
  onClose: () => void
  onAdded: (title: Title) => void
}
function AddTitleModal({ onClose, onAdded }: AddTitleModalProps) {
  const { post } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const [nameUa, setNameUa] = useState('')
  const [nameOrig, setNameOrig] = useState('')
  const [saving, setSaving] = useState(false)
  const [selectedPoster, setSelectedPoster] = useState<HikkaAnimeResult | null>(null)

  async function handleSave() {
    if (!nameUa.trim()) return
    setSaving(true)
    try {
      if (backendReady) {
        const created = await post<Title>('/titles', {
          name_ua: nameUa.trim(),
          name_original: nameOrig.trim(),
          status: 'new',
        })
        if (selectedPoster?.image) {
          try {
            const withPoster = await post<Title>(`/titles/${created.id}/poster-from-url`, {
              image_url: selectedPoster.image,
            })
            onAdded(withPoster)
            return
          } catch {
            // poster download failed — keep the title, just without a poster
          }
        }
        onAdded(created)
      } else {
        // Mock fallback
        onAdded({
          id: Date.now(),
          name_ua: nameUa.trim(),
          name_original: nameOrig.trim(),
          poster_path: null,
          status: 'new',
          episode_count: 0,
        })
      }
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="rh-card w-[440px] max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Новий тайтл</h2>
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-rh-muted mb-1 block">Назва (UA)</label>
            <input
              className="rh-input w-full"
              placeholder="Людина-Бензопила"
              value={nameUa}
              onChange={(e) => setNameUa(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            />
          </div>
          <div>
            <label className="text-xs text-rh-muted mb-1 block">Оригінальна назва</label>
            <input
              className="rh-input w-full"
              placeholder="Chainsaw Man"
              value={nameOrig}
              onChange={(e) => setNameOrig(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            />
          </div>
          <PosterSearch
            defaultQuery={nameOrig || nameUa}
            selected={selectedPoster}
            onSelect={setSelectedPoster}
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="rh-btn-ghost">Скасувати</button>
          <button onClick={handleSave} className="rh-btn-primary" disabled={saving || !nameUa.trim()}>
            {saving ? <Spinner size={14} /> : null}
            Зберегти
          </button>
        </div>
      </div>
    </div>
  )
}
