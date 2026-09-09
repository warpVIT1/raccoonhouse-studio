import React, { useEffect, useState, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { TitleBadge } from './ui/Badge'
import { Spinner } from './ui/Spinner'
import { PosterSearch } from './PosterSearch'
import { posterSrc } from '../lib/poster'
import type { Title, TitleStatus, HikkaAnimeResult, MyTeam } from '../types'

const STATUS_FILTER_OPTIONS: Array<{ value: TitleStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Всі' },
  { value: 'in_progress', label: 'В роботі' },
  { value: 'done', label: 'Завершені' },
]

const STATUS_OPTIONS: Array<{ value: TitleStatus; label: string }> = [
  { value: 'new', label: 'Новий' },
  { value: 'in_progress', label: 'В роботі' },
  { value: 'done', label: 'Готово' },
]

export function TitlesPage() {
  const { get, put, del } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const setSelectedTitle = useAppStore((s) => s.setSelectedTitle)
  const sharedContentUpdatedAt = useAppStore((s) => s.sharedContentUpdatedAt)

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

  // A teammate's shared-title change was just pulled in locally (see
  // backend discovery_service.py's "shared_content_updated" handling) —
  // silently refetch, no window-switching or manual refresh needed.
  useEffect(() => {
    if (!backendReady || !sharedContentUpdatedAt) return
    get<Title[]>('/titles').then(setTitles).catch(() => {})
  }, [sharedContentUpdatedAt, backendReady, get])

  async function handleDeleteTitle(id: number, permanent: boolean) {
    try {
      await del(`/titles/${id}${permanent ? '?permanent=true' : ''}`)
      setTitles((prev) => prev.filter((t) => t.id !== id))
    } catch {
      // ignore
    }
  }

  async function handleStatusChange(id: number, status: TitleStatus) {
    try {
      const updated = await put<Title>(`/titles/${id}`, { status })
      setTitles((prev) => prev.map((t) => (t.id === id ? updated : t)))
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
                onDelete={(permanent) => handleDeleteTitle(title.id, permanent)}
                onStatusChange={(status) => handleStatusChange(title.id, status)}
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
  onDelete: (permanent: boolean) => void
  onStatusChange: (status: TitleStatus) => void
}
function TitleCard({ title, onClick, onDelete, onStatusChange }: TitleCardProps) {
  const { get } = useApi()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [changingStatus, setChangingStatus] = useState(false)
  // Only fetched lazily (on opening the delete confirm), and only matters
  // for shared titles — gates whether "Видалити назавжди" even renders,
  // same "hide, don't just block" posture as everywhere else (the backend
  // enforces this too — see routers/titles.py's delete_title).
  const [canDeletePermanently, setCanDeletePermanently] = useState(false)
  useEffect(() => {
    if (!confirmingDelete || !title.shared_id) return
    get<{ can_delete_permanently: boolean }>(`/titles/${title.id}/can-delete-permanently`)
      .then((r) => setCanDeletePermanently(r.can_delete_permanently))
      .catch(() => setCanDeletePermanently(false))
  }, [confirmingDelete, title.shared_id, title.id, get])

  // Same permission as canDeletePermanently above (team admin or app admin)
  // — reused here to gate the "Команда тайтлу" button, fetched eagerly
  // (not lazily) since the button's very visibility depends on it.
  const [canManageTeam, setCanManageTeam] = useState(false)
  const [showTeamModal, setShowTeamModal] = useState(false)
  useEffect(() => {
    if (!title.shared_id) return
    get<{ can_delete_permanently: boolean }>(`/titles/${title.id}/can-delete-permanently`)
      .then((r) => setCanManageTeam(r.can_delete_permanently))
      .catch(() => setCanManageTeam(false))
  }, [title.shared_id, title.id, get])

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

        {canManageTeam && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowTeamModal(true) }}
            className="absolute top-1.5 right-8 w-6 h-6 rounded-lg bg-black/60 backdrop-blur-sm text-white/80 hover:bg-rh-accent hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs"
            title="Команда тайтлу"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
            </svg>
          </button>
        )}

        {showTeamModal && (
          <div onClick={(e) => e.stopPropagation()}>
            <TitleTeamModal title={title} onClose={() => setShowTeamModal(false)} />
          </div>
        )}

        {confirmingDelete && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-2 p-3 text-center"
          >
            <span className="text-xs text-white">Видалити «{title.name_ua}»?</span>
            {title.shared_id ? (
              <>
                <span className="text-[10px] text-rh-muted max-w-[180px]">
                  Спільний з командою — просте видалення прибере його лише у вас, він повернеться при наступній синхронізації
                </span>
                <div className="flex flex-col gap-1.5 w-full">
                  <button onClick={() => onDelete(false)} className="rh-btn-ghost text-[11px] px-2 py-1 w-full">Видалити лише в мене</button>
                  {canDeletePermanently && (
                    <button onClick={() => onDelete(true)} className="bg-rh-accent hover:bg-rh-accent-h text-white text-[11px] px-2 py-1 rounded-md font-semibold w-full">Видалити назавжди (у всієї команди)</button>
                  )}
                  <button onClick={() => setConfirmingDelete(false)} className="rh-btn-ghost text-[11px] px-2 py-1 w-full">Скасувати</button>
                </div>
              </>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => setConfirmingDelete(false)} className="rh-btn-ghost text-[11px] px-2 py-1">Скасувати</button>
                <button onClick={() => onDelete(false)} className="bg-rh-accent hover:bg-rh-accent-h text-white text-[11px] px-2 py-1 rounded-md font-semibold">Видалити</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3 flex flex-col gap-1.5">
        <div className="font-medium text-sm text-rh-text leading-tight line-clamp-1">
          {title.name_ua}
        </div>
        <div className="text-xs text-rh-muted line-clamp-1">{title.name_original}</div>
        {/* Which team, not just "shared" — someone can be in several
            teams, so the icon alone doesn't say which one this title
            belongs to (confirmed live 2026-08-18). */}
        {title.team_name && (
          <div className="text-[10px] text-rh-accent/80 line-clamp-1">{title.team_name}</div>
        )}
        <div className="flex items-center justify-between mt-0.5 relative">
          <button onClick={(e) => { e.stopPropagation(); setChangingStatus((v) => !v) }} className="cursor-pointer">
            <TitleBadge status={title.status} />
          </button>
          <span className="text-xs text-rh-muted flex items-center gap-1">
            {title.shared_id && (
              <span title={title.team_name ? `Спільний з командою: ${title.team_name}` : 'Спільний з командою'}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
                </svg>
              </span>
            )}
            {title.episode_count ?? 0} еп.
          </span>

          {changingStatus && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-0 bottom-6 z-40 bg-[#1B1B1F] border border-rh-border2 rounded-xl p-1 min-w-[140px] shadow-2xl flex flex-col"
            >
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => { onStatusChange(opt.value); setChangingStatus(false) }}
                  className={`text-left rounded-lg px-2.5 py-1.5 text-xs hover:bg-white/5 ${opt.value === title.status ? 'text-rh-accent font-semibold' : 'text-rh-text'}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface TitleTeamModalProps {
  title: Title
  onClose: () => void
}
// "Команда тайтлу" — who currently holds each non-actor studio role
// (director/translator/sound_engineer/...) for this title, see backend
// routers/titles.py's role-assignments endpoints. Actor casting is
// deliberately absent here — that's the director's own job via the
// subtitle grid/Ролі tab's team-actor dropdown, untouched by this panel.
// Only ever rendered for someone canManageTeam already gated true for
// (see TitleCard), but the backend enforces the same check regardless.
function TitleTeamModal({ title, onClose }: TitleTeamModalProps) {
  const backdrop = useBackdropClose(onClose)
  const { get, put } = useApi()
  const [roles, setRoles] = useState<import('../types').RoleCatalogItem[]>([])
  const [assignments, setAssignments] = useState<import('../types').TitleRoleAssignment[]>([])
  const [teamMembersByRole, setTeamMembersByRole] = useState<Record<string, { device_id: string; display_name: string }[]>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    get<import('../types').RoleCatalogItem[]>('/role-catalog').then((all) => {
      const nonActor = all.filter((r) => r.key !== 'actor')
      setRoles(nonActor)
      if (!title.team_id) return
      Promise.all(nonActor.map((r) =>
        get<{ device_id: string; display_name: string }[]>(`/teams/${title.team_id}/actors?role=${r.key}`).catch(() => []),
      )).then((lists) => {
        const byRole: Record<string, { device_id: string; display_name: string }[]> = {}
        nonActor.forEach((r, i) => { byRole[r.key] = lists[i] })
        setTeamMembersByRole(byRole)
      })
    }).catch(() => {})
    get<import('../types').TitleRoleAssignment[]>(`/titles/${title.id}/role-assignments`).then(setAssignments).catch(() => {})
  }, [get, title.id, title.team_id])

  async function assign(role: string, deviceId: string) {
    setSaving(role)
    try {
      const member = (teamMembersByRole[role] ?? []).find((m) => m.device_id === deviceId)
      const updated = await put<import('../types').TitleRoleAssignment | null>(
        `/titles/${title.id}/role-assignments/${role}`,
        { device_id: deviceId || null, display_name: member?.display_name ?? null },
      )
      setAssignments((prev) => {
        const rest = prev.filter((a) => a.role !== role)
        return updated ? [...rest, updated] : rest
      })
    } catch {
      /* ignore — best-effort like every other admin action in this app */
    } finally {
      setSaving(null)
    }
  }

  return (
    <div {...backdrop} className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-rh-card border border-rh-border rounded-2xl w-full max-w-md overflow-hidden">
        <div className="px-4 py-3 border-b border-rh-border/70 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-bold">Команда тайтлу</div>
            <div className="text-[10.5px] text-rh-muted mt-0.5">{title.name_ua}</div>
          </div>
          <button onClick={onClose} className="text-rh-muted hover:text-white text-sm">✕</button>
        </div>
        <div className="flex flex-col">
          {roles.map((role) => {
            const current = assignments.find((a) => a.role === role.key)
            const members = teamMembersByRole[role.key] ?? []
            return (
              <div key={role.key} className="flex items-center gap-2.5 px-4 py-2.5 border-b border-rh-border/50 last:border-b-0">
                <span className="flex-1 text-[12px] text-rh-text-dim">{role.label}</span>
                <select
                  value={current?.device_id ?? ''}
                  onChange={(e) => assign(role.key, e.target.value)}
                  disabled={saving === role.key}
                  className="w-44 bg-rh-bg border border-rh-border rounded-lg px-2 py-1 text-[11px]"
                >
                  <option value="">— не призначено —</option>
                  {members.map((m) => (
                    <option key={m.device_id} value={m.device_id}>{m.display_name}</option>
                  ))}
                </select>
              </div>
            )
          })}
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
  const backdrop = useBackdropClose(onClose)
  const { get, post } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const [nameUa, setNameUa] = useState('')
  const [nameOrig, setNameOrig] = useState('')
  const [saving, setSaving] = useState(false)
  const [selectedPoster, setSelectedPoster] = useState<HikkaAnimeResult | null>(null)

  // Only shown at all if the active profile is in at least one team — same
  // "hide, don't just block" posture as every other team-gated UI piece.
  // Auto-picks the team when there's exactly one; a picker only appears
  // for someone in more than one.
  const [myTeams, setMyTeams] = useState<MyTeam[]>([])
  const [shareTeamId, setShareTeamId] = useState<string | null>(null)
  useEffect(() => {
    if (!backendReady) return
    get<MyTeam[]>('/teams/mine').then(setMyTeams).catch(() => {})
  }, [backendReady, get])

  async function handleSave() {
    if (!nameUa.trim()) return
    setSaving(true)
    try {
      if (backendReady) {
        const created = await post<Title>('/titles', {
          name_ua: nameUa.trim(),
          name_original: nameOrig.trim(),
          status: 'new',
          team_id: shareTeamId,
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" {...backdrop}>
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
          {myTeams.length > 0 && (
            <div>
              <label className="text-xs text-rh-muted mb-1 block">Видимість</label>
              <div className="flex gap-1">
                <button
                  onClick={() => setShareTeamId(null)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${shareTeamId === null ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-rh-text hover:bg-white/5'}`}
                >
                  Особистий
                </button>
                <button
                  onClick={() => setShareTeamId(myTeams[0].id)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${shareTeamId !== null ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-rh-text hover:bg-white/5'}`}
                >
                  Спільний з командою
                </button>
              </div>
              {shareTeamId !== null && myTeams.length > 1 && (
                <select
                  className="rh-input w-full mt-1.5 text-xs"
                  value={shareTeamId}
                  onChange={(e) => setShareTeamId(e.target.value)}
                >
                  {myTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              {shareTeamId !== null && (
                <p className="text-[10.5px] text-rh-muted mt-1">
                  Тайтл, епізоди, персонажі й субтитри автоматично з'являться у всіх учасників команди.
                </p>
              )}
            </div>
          )}
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
