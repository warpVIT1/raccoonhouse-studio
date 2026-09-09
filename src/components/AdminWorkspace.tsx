import React, { useCallback, useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import type { EpisodeAdminPersonStatus, EpisodeRoleAssignment, RoleCatalogItem, TeamActor, Title } from '../types'

// Fixed section order — actors first (many people, one section), then the
// singular studio roles in the order production actually happens, mirroring
// EpisodeRoleRouter.tsx's own role-tab labels. Any other RoleCatalog role an
// admin added by hand gets appended after these, label from the catalog.
const ADMIN_SECTION_ORDER = ['actor', 'translator', 'director', 'sound_engineer', 'cleaner']
const ADMIN_ROLE_LABELS: Record<string, string> = {
  actor: 'Актори', translator: 'Перекладач', director: 'Режисер',
  sound_engineer: 'Звукорежисер', cleaner: 'Клінапер',
}

function deadlineKey(role: string, characterId?: number | null): string {
  return `${role}:${characterId ?? ''}`
}

interface AdminWorkspaceProps {
  episodeId: number
  titleId: number
}

// Team-admin/app-admin-only per-episode production status: deadlines,
// reminders, late alerts, per-role assignment overrides for this one
// episode. Used to live as a tab nested inside DirectorWorkspace (alongside
// Репліки/Маркери/Ролі) — moved to its own peer-level workspace, same as
// Актор/Режисер/Звукорежисер/Клінапер/Перекладач (confirmed live
// 2026-08-19/20: nesting inside DirectorWorkspace was the wrong shape).
//
// Deadlines auto-save on change (no separate "Зберегти" button) — the
// earlier staged-draft-then-batch-save design demonstrably lost data:
// confirmed live 2026-08-20 that a director typed a deadline, believed it
// was set, and "Нагадати" reported "не встановлено" — the electron.log
// showed the PUT /role-deadlines request was NEVER SENT at all (the app
// never crashed or errored; the person simply never clicked the separate
// Save button, and nothing made that obvious). Auto-save removes the
// failure mode entirely instead of trying to make the button harder to miss.
export function AdminWorkspace({ episodeId, titleId }: AdminWorkspaceProps) {
  const { get, post, put } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)

  const [adminStatuses, setAdminStatuses] = useState<EpisodeAdminPersonStatus[]>([])
  const [deadlines, setDeadlines] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [savedFlashKey, setSavedFlashKey] = useState<string | null>(null)
  const [adminActionResult, setAdminActionResult] = useState<string | null>(null)

  // Per-episode role-assignment overrides (see backend sync_service.py's
  // resolve_role_assignment) — a role's effective assignee already shows
  // up in adminStatuses via the resolver server-side; this is only for
  // driving the override <select> itself (which team member is CURRENTLY
  // overriding this role for this episode, if any).
  const [episodeRoleAssignments, setEpisodeRoleAssignments] = useState<EpisodeRoleAssignment[]>([])
  const [adminRoleCatalog, setAdminRoleCatalog] = useState<RoleCatalogItem[]>([])
  const [teamMembersByRole, setTeamMembersByRole] = useState<Record<string, TeamActor[]>>({})
  const [assigningRole, setAssigningRole] = useState<string | null>(null)
  const [teamId, setTeamId] = useState<string | null>(null)

  useEffect(() => {
    if (!backendReady) return
    get<Title>(`/titles/${titleId}`).then((t) => setTeamId(t.team_id ?? null)).catch(() => setTeamId(null))
  }, [backendReady, titleId, get])

  const loadAdminStatuses = useCallback(() => {
    if (!backendReady) return
    get<EpisodeAdminPersonStatus[]>(`/episodes/${episodeId}/admin-status`).then(setAdminStatuses).catch(() => {})
  }, [backendReady, episodeId, get])

  // Deadlines are always Kyiv wall-clock time, regardless of which
  // timezone the machine setting/reading them is actually in (a team
  // spread across timezones needs one shared "the deadline is 18:00" that
  // doesn't silently mean something different per person). The backend
  // stores/sends naive-UTC ISO. Both directions use Intl's real Europe/Kyiv
  // timezone data (handles Ukraine's DST rules correctly without hardcoding
  // an offset) rather than the browser's own local timezone.
  const toDatetimeLocal = (iso: string | null | undefined) => {
    if (!iso) return ''
    const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
  }

  // Inverse of toDatetimeLocal — treats `value` (a datetime-local string) as
  // Kyiv wall-clock time and returns the equivalent UTC ISO string. Standard
  // "format the same instant in the target zone, diff, correct" trick since
  // JS has no native "parse this string as timezone X" — verified: for a
  // UTC+3 instant, an input of 14:00 correctly resolves to 11:00 UTC.
  const kyivLocalToUtcIso = (value: string): string | null => {
    if (!value) return null
    const asIfUtc = new Date(`${value}:00Z`)
    const kyivFormatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(asIfUtc).replace(', ', 'T')
    const kyivAsUtc = new Date(`${kyivFormatted}Z`)
    const offsetMs = asIfUtc.getTime() - kyivAsUtc.getTime()
    return new Date(asIfUtc.getTime() + offsetMs).toISOString()
  }

  const loadDeadlines = useCallback(() => {
    if (!backendReady) return
    get<Array<{ role: string; character_id?: number | null; deadline?: string | null }>>(
      `/episodes/${episodeId}/role-deadlines`,
    ).then((rows) => {
      const map: Record<string, string> = {}
      rows.forEach((r) => { map[deadlineKey(r.role, r.character_id)] = toDatetimeLocal(r.deadline) })
      setDeadlines(map)
    }).catch(() => {})
  }, [backendReady, episodeId, get])

  const loadEpisodeRoleAssignments = useCallback(() => {
    if (!backendReady) return
    get<EpisodeRoleAssignment[]>(`/episodes/${episodeId}/role-assignments`).then(setEpisodeRoleAssignments).catch(() => {})
  }, [backendReady, episodeId, get])

  // Role-catalog + per-role team-member lists, for the override <select>
  // in each section header — same fetch shape as TitlesPage.tsx's
  // TitleTeamModal, minus the "actor" role (casting stays the "Ролі"
  // tab's own job, untouched by this override system).
  const loadAdminRoleOptions = useCallback(() => {
    if (!backendReady || !teamId) return
    get<RoleCatalogItem[]>('/role-catalog').then((all) => {
      const nonActor = all.filter((r) => r.key !== 'actor')
      setAdminRoleCatalog(nonActor)
      Promise.all(nonActor.map((r) =>
        get<TeamActor[]>(`/teams/${teamId}/actors?role=${r.key}`).catch(() => []),
      )).then((lists) => {
        const byRole: Record<string, TeamActor[]> = {}
        nonActor.forEach((r, i) => { byRole[r.key] = lists[i] })
        setTeamMembersByRole(byRole)
      })
    }).catch(() => {})
  }, [backendReady, teamId, get])

  useEffect(() => {
    loadAdminStatuses()
    loadDeadlines()
    loadEpisodeRoleAssignments()
  }, [loadAdminStatuses, loadDeadlines, loadEpisodeRoleAssignments])
  useEffect(() => { loadAdminRoleOptions() }, [loadAdminRoleOptions])

  async function assignEpisodeRole(role: string, deviceId: string) {
    setAssigningRole(role)
    try {
      const member = (teamMembersByRole[role] ?? []).find((m) => m.device_id === deviceId)
      const updated = await put<EpisodeRoleAssignment | null>(
        `/episodes/${episodeId}/role-assignments/${role}`,
        { device_id: deviceId || null, display_name: member?.display_name ?? null },
      )
      setEpisodeRoleAssignments((prev) => {
        const rest = prev.filter((a) => a.role !== role)
        return updated ? [...rest, updated] : rest
      })
      loadAdminStatuses()  // effective assignee (resolved server-side) may have changed
    } catch {
      setAdminActionResult('Не вдалося змінити призначення для цієї серії')
    } finally {
      setAssigningRole(null)
    }
  }

  // Saves the instant a full valid datetime is picked (datetime-local only
  // fires onChange once a complete value exists, so there's no risk of
  // saving a half-typed value) — no separate confirm step, see the file
  // header comment for why.
  async function saveDeadline(role: string, characterId: number | null | undefined, value: string) {
    const key = deadlineKey(role, characterId)
    const previous = deadlines[key] ?? ''
    setDeadlines((prev) => ({ ...prev, [key]: value }))
    setSavingKey(key)
    try {
      const qs = characterId != null ? `?character_id=${characterId}` : ''
      await put(`/episodes/${episodeId}/role-deadlines/${role}${qs}`, {
        deadline: kyivLocalToUtcIso(value),
      })
      setSavedFlashKey(key)
      setTimeout(() => setSavedFlashKey((k) => (k === key ? null : k)), 1500)
    } catch {
      setDeadlines((prev) => ({ ...prev, [key]: previous }))
      setAdminActionResult('Не вдалося зберегти дедлайн — спробуйте ще раз')
    } finally {
      setSavingKey(null)
    }
  }

  async function handleRemind(role: string, characterId?: number | null) {
    try {
      await post(`/episodes/${episodeId}/remind`, { role, character_id: characterId ?? null })
      setAdminActionResult('Нагадування надіслано')
    } catch {
      setAdminActionResult('Не вдалося надіслати нагадування')
    }
  }

  const byRole = new Map<string, EpisodeAdminPersonStatus[]>()
  for (const p of adminStatuses) {
    if (!byRole.has(p.role)) byRole.set(p.role, [])
    byRole.get(p.role)!.push(p)
  }
  const knownOrder = ADMIN_SECTION_ORDER.filter((r) => byRole.has(r))
  const otherOrder = [...byRole.keys()].filter((r) => !ADMIN_SECTION_ORDER.includes(r))
  const sectionOrder = [...knownOrder, ...otherOrder]

  function personCard(p: EpisodeAdminPersonStatus) {
    const key = deadlineKey(p.role, p.character_id)
    return (
      <div key={key} className="bg-rh-card border border-rh-border rounded-2xl px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[12.5px] font-bold min-w-[110px]">
            {p.character_name ?? ADMIN_ROLE_LABELS[p.role] ?? p.role}
          </span>
          <span className="text-[11px] text-rh-muted flex-1 min-w-0 truncate">
            {p.display_name ?? '— не призначено —'}
          </span>
          {p.status && <span className="text-[11px] px-2 py-0.5 rounded-full bg-rh-card2 border border-rh-border">{p.status}</span>}
          {p.progress && <span className="text-[11px] px-2 py-0.5 rounded-full bg-rh-card2 border border-rh-border">{p.progress}</span>}
          {p.badges && Object.entries(p.badges).map(([label, on]) => (
            <span
              key={label}
              className={`text-[10.5px] px-2 py-0.5 rounded-full border ${on ? 'bg-emerald-900/30 border-emerald-700 text-emerald-400' : 'bg-rh-card2 border-rh-border text-rh-muted'}`}
            >
              {label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={deadlines[key] ?? ''}
            onChange={(e) => saveDeadline(p.role, p.character_id, e.target.value)}
            className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1 text-[11px]"
            title="Час за Києвом, незалежно від часового поясу цього пристрою"
          />
          <span className="text-[10px] text-rh-muted">Київ</span>
          {savingKey === key && <span className="text-[10px] text-rh-muted">Зберігаю…</span>}
          {savedFlashKey === key && <span className="text-[10px] text-emerald-400 font-semibold">✓ Збережено</span>}
          <button
            onClick={() => handleRemind(p.role, p.character_id)}
            disabled={!p.device_id}
            className="rh-btn-outline text-[11px] px-2.5 py-1 disabled:opacity-40"
          >
            Нагадати
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-3">
      <span className="text-[11px] text-rh-muted">
        Дедлайни, нагадування та статус по кожній людині — зберігається одразу, окремої кнопки немає
      </span>
      {adminActionResult && (
        <div className="text-[11px] text-rh-accent flex items-center gap-2">
          {adminActionResult}
          <button onClick={() => setAdminActionResult(null)} className="text-rh-muted hover:text-white">✕</button>
        </div>
      )}
      {sectionOrder.map((role) => {
        const people = byRole.get(role) ?? []
        const isActor = role === 'actor'
        const override = episodeRoleAssignments.find((a) => a.role === role)
        const members = teamMembersByRole[role] ?? []
        const catalogEntry = adminRoleCatalog.find((r) => r.key === role)
        const label = ADMIN_ROLE_LABELS[role] ?? catalogEntry?.label ?? role
        return (
          <div key={role} className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-[11px] font-bold text-rh-text-dim uppercase tracking-wide">{label}</span>
              {!isActor && (
                <>
                  <select
                    value={override?.device_id ?? ''}
                    onChange={(e) => assignEpisodeRole(role, e.target.value)}
                    disabled={assigningRole === role || !teamId}
                    className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1 text-[10.5px]"
                  >
                    <option value="">— типово з тайтла —</option>
                    {members.map((m) => (
                      <option key={m.device_id} value={m.device_id}>{m.display_name}</option>
                    ))}
                  </select>
                  {override && (
                    <span className="text-[10px] text-rh-accent">заміна лише для цієї серії</span>
                  )}
                </>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {people.length > 0 ? people.map(personCard) : (
                <div className="text-[11px] text-rh-muted px-1">— не призначено —</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
