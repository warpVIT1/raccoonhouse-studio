import React, { useCallback, useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { Toggle } from './ui/Toggle'
import { Spinner } from './ui/Spinner'
import { RolePicker } from './ui/RolePicker'
import type { AppSettings, ErrorReport, FeedbackItem, KnownUser, MyTeam, Profile, SeparationReport, Team, TeamInvite, TeamJoinRequest, TeamMember } from '../types'

export function TeamsPage() {
  const { get } = useApi()
  const [tab, setTab] = useState<'teams' | 'users' | 'database'>('teams')
  const [isAppAdmin, setIsAppAdmin] = useState(false)

  useEffect(() => {
    get<{ is_app_admin: boolean }>('/teams/is-app-admin').then((r) => setIsAppAdmin(r.is_app_admin)).catch(() => {})
  }, [get])

  return (
    <main className="relative z-[1] p-5 px-6 max-w-[760px] mx-auto overflow-y-auto h-full">
      <h1 className="m-0 mb-1 text-lg font-black">Команди</h1>
      {/* "Користувачі"/"База даних" are app-admin-only data server-side too,
          but a regular user shouldn't even see the tabs exist — same "hide,
          don't just block" posture as the rest of this page's admin-only
          pieces. */}
      {isAppAdmin && (
        <div className="flex items-center gap-1 mb-3.5 -mx-1">
          <button
            onClick={() => setTab('teams')}
            className={`px-3 py-1.5 text-[11.5px] font-semibold rounded-lg transition-colors ${tab === 'teams' ? 'bg-rh-accent/15 text-rh-accent' : 'text-rh-muted hover:text-white'}`}
          >
            Команди
          </button>
          <button
            onClick={() => setTab('users')}
            className={`px-3 py-1.5 text-[11.5px] font-semibold rounded-lg transition-colors ${tab === 'users' ? 'bg-rh-accent/15 text-rh-accent' : 'text-rh-muted hover:text-white'}`}
          >
            Користувачі
          </button>
          <button
            onClick={() => setTab('database')}
            className={`px-3 py-1.5 text-[11.5px] font-semibold rounded-lg transition-colors ${tab === 'database' ? 'bg-rh-accent/15 text-rh-accent' : 'text-rh-muted hover:text-white'}`}
          >
            База даних
          </button>
        </div>
      )}
      {tab === 'users' && isAppAdmin ? <UsersTab /> : tab === 'database' && isAppAdmin ? <DatabaseTab /> : <TeamsTab />}
    </main>
  )
}

function TeamsTab() {
  const { get, post, put, del } = useApi()
  const activeProfile = useAppStore((s) => s.activeProfile)
  const setActiveProfile = useAppStore((s) => s.setActiveProfile)

  const [isAppAdmin, setIsAppAdmin] = useState(false)
  const [deviceId, setDeviceId] = useState('')
  const [myTeams, setMyTeams] = useState<MyTeam[]>([])
  const [allTeams, setAllTeams] = useState<Team[]>([])
  const [previewTeam, setPreviewTeam] = useState<Team | null>(null)
  const [invites, setInvites] = useState<TeamInvite[]>([])
  const [membersByTeam, setMembersByTeam] = useState<Record<string, TeamMember[]>>({})
  // Pending `join <team_id>` bot requests (see cloudflare-signaling's
  // /telegram-bot/webhook `join` branch) — only fetched for teams the
  // current user actually admins, same scoping as the invite-by-id form
  // in renderMemberManagement below.
  const [joinRequestsByTeam, setJoinRequestsByTeam] = useState<Record<string, TeamJoinRequest[]>>({})
  const [loading, setLoading] = useState(true)
  // One-time bridge for the standalone sound-engineer Reaper script
  // (reaper-scripts/Marker Manager - RaccoonHouse.lua, 2026-09-10) — the
  // Worker has no auth, so that script needs a team_id to know which
  // team's titles/episodes/cast to fetch. It asks for this once on first
  // run and caches it in REAPER's own ExtState after — this button is the
  // only place a human can actually get that id to paste in.
  const [copiedTeamId, setCopiedTeamId] = useState<string | null>(null)

  const [inviteDeviceId, setInviteDeviceId] = useState<Record<string, string>>({})
  const [inviteError, setInviteError] = useState<Record<string, string>>({})

  // Team rename (2026-09-09) — presence of a team's id as a key means
  // "currently editing", value is the draft name. Team-admin/app-admin
  // gated the same way as renderMemberManagement's `canManage`.
  const [renamingTeam, setRenamingTeam] = useState<Record<string, string>>({})
  const [renameError, setRenameError] = useState<string | null>(null)
  async function saveTeamRename(teamId: string) {
    const name = (renamingTeam[teamId] || '').trim()
    if (!name) return
    setRenameError(null)
    try {
      await put(`/teams/${teamId}/name`, { name })
      setRenamingTeam((prev) => { const next = { ...prev }; delete next[teamId]; return next })
      await load()
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : 'Не вдалося перейменувати')
    }
  }

  const [joinTeamName, setJoinTeamName] = useState('')
  const [joinPassword, setJoinPassword] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joinBusy, setJoinBusy] = useState(false)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newCreditsEnabled, setNewCreditsEnabled] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)

  const load = useCallback(async () => {
    // Promise.all previously meant a hard failure in just ONE of these three
    // (confirmed live 2026-08-10: /teams/mine 400'd with "no active profile"
    // right after a fresh install) silently blanked out the OTHER two as
    // well — including is_app_admin, which made the entire "Усі команди
    // (адмін)" section (create-team button, form, everything) disappear
    // with no visible error, even though is-app-admin itself would have
    // succeeded on its own. Promise.allSettled means each of these updates
    // independently; one failing no longer holds the other two hostage.
    const [adminR, mineR, pendingR] = await Promise.allSettled([
      get<{ is_app_admin: boolean; device_id: string }>('/teams/is-app-admin'),
      get<MyTeam[]>('/teams/mine'),
      get<TeamInvite[]>('/teams/invites/pending'),
    ])
    let admin: { is_app_admin: boolean; device_id: string } | null = null
    let mine: MyTeam[] = []
    if (adminR.status === 'fulfilled') {
      admin = adminR.value
      setIsAppAdmin(admin.is_app_admin)
      setDeviceId(admin.device_id)
    }
    if (mineR.status === 'fulfilled') {
      mine = mineR.value
      setMyTeams(mine)
    }
    if (pendingR.status === 'fulfilled') setInvites(pendingR.value)

    try {
      // The full team roster is app-admin-only server-side (see
      // team_service.list_teams) — everyone else must not even be able to
      // see other teams exist, so this is skipped entirely for them rather
      // than requested and discarded.
      if (admin?.is_app_admin) {
        setAllTeams(await get<Team[]>('/teams'))
      }
      const members: Record<string, TeamMember[]> = {}
      await Promise.all(mine.map(async (t) => {
        members[t.id] = await get<TeamMember[]>(`/teams/${t.id}/members`)
      }))
      setMembersByTeam(members)

      const adminTeams = mine.filter((t) => t.is_team_admin || admin?.is_app_admin)
      const requests: Record<string, TeamJoinRequest[]> = {}
      await Promise.all(adminTeams.map(async (t) => {
        try {
          requests[t.id] = await get<TeamJoinRequest[]>(`/teams/join-requests?team_id=${t.id}`)
        } catch {
          requests[t.id] = []
        }
      }))
      setJoinRequestsByTeam(requests)
    } catch {
      // ignore — retried on next poll
    } finally {
      setLoading(false)
    }
  }, [get])

  // A real recurring poll, not just a one-time fetch on mount — a pending
  // invite created while this device was offline (or just sitting on a
  // different page) otherwise only ever showed up if you happened to leave
  // this page and come back, since nothing here previously re-checked on
  // its own. Same 15s cadence as Sidebar's own "canSeeTeams" poll.
  useEffect(() => {
    load()
    const interval = setInterval(load, 15000)
    return () => clearInterval(interval)
  }, [load])

  async function respondInvite(inviteId: string, accept: boolean) {
    try {
      await post('/teams/invites/respond', { invite_id: inviteId, accept, display_name: activeProfile?.name || '?' })
      await load()
    } catch {
      // ignore
    }
  }

  async function respondJoinRequest(teamId: string, requestId: string, accept: boolean) {
    try {
      await post('/teams/join-requests/respond', { request_id: requestId, accept, team_id: teamId })
      await load()
    } catch {
      // ignore
    }
  }

  async function invite(teamId: string) {
    const id = (inviteDeviceId[teamId] || '').trim()
    if (!id) return
    setInviteError((e) => ({ ...e, [teamId]: '' }))
    try {
      await post('/teams/invite', { team_id: teamId, invited_device_id: id })
      setInviteDeviceId((s) => ({ ...s, [teamId]: '' }))
    } catch (e) {
      setInviteError((s) => ({ ...s, [teamId]: e instanceof Error ? e.message : 'Не вдалося запросити' }))
    }
  }

  async function removeMember(teamId: string, memberDeviceId: string) {
    try {
      await del(`/teams/${teamId}/members/${memberDeviceId}`)
      await load()
    } catch {
      // ignore
    }
  }

  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null)

  async function toggleExpand(teamId: string) {
    if (expandedTeamId === teamId) {
      setExpandedTeamId(null)
      return
    }
    setExpandedTeamId(teamId)
    if (!membersByTeam[teamId]) {
      try {
        const members = await get<TeamMember[]>(`/teams/${teamId}/members`)
        setMembersByTeam((s) => ({ ...s, [teamId]: members }))
      } catch {
        // ignore
      }
    }
    // App-admin "Усі команди" view — same join-requests fetch as `load()`
    // does for "Мої команди", just lazy since it covers every team, not
    // only ones the app admin personally belongs to.
    if (!joinRequestsByTeam[teamId]) {
      try {
        const requests = await get<TeamJoinRequest[]>(`/teams/join-requests?team_id=${teamId}`)
        setJoinRequestsByTeam((s) => ({ ...s, [teamId]: requests }))
      } catch {
        // ignore
      }
    }
  }

  async function toggleTeamCredits(teamId: string, enabled: boolean) {
    try {
      await put(`/teams/${teamId}/credits`, { enabled })
      setAllTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, credits_enabled: enabled ? 1 : 0 } : t)))
    } catch {
      // ignore
    }
  }

  async function toggleTeamAdmin(teamId: string, memberDeviceId: string, makeAdmin: boolean) {
    try {
      await put(`/teams/${teamId}/members/${memberDeviceId}/admin`, { is_admin: makeAdmin })
      await load()
    } catch {
      // ignore
    }
  }

  // Job-title roles are no longer self-picked (2026-09-09) — a team admin
  // grants them here instead, only for members of THEIR OWN team (the
  // backend re-checks this — see team_service.set_member_roles — this is
  // just the friendly early gate via `canManage`, already scoped per-team
  // by whichever list called renderMemberManagement).
  async function saveMemberRoles(teamId: string, memberDeviceId: string, roles: string[]) {
    setMembersByTeam((prev) => ({
      ...prev,
      [teamId]: (prev[teamId] || []).map((m) => (m.device_id === memberDeviceId ? { ...m, roles } : m)),
    }))
    try {
      await put(`/teams/${teamId}/members/${memberDeviceId}/roles`, { roles })
      // Editing your OWN roles (a team admin managing their own row, same
      // as this test) otherwise wouldn't show up anywhere that reads
      // activeProfile.roles (e.g. EpisodeRoleRouter's tab list) until the
      // next periodic sync pull, up to 5 minutes later — confirmed live
      // 2026-09-09 as "roles I set don't apply". This forces that pull
      // right now, only when it's actually this device being edited.
      if (memberDeviceId === deviceId) {
        const updated = await post<Profile>('/profiles/refresh-roles', {})
        setActiveProfile(updated)
      }
    } catch {
      await load()
    }
  }

  async function leaveTeam(teamId: string, teamName: string) {
    if (!window.confirm(`Вийти з команди "${teamName}"?`)) return
    await removeMember(teamId, deviceId)
  }

  async function removeTeam(teamId: string, teamName: string) {
    if (!window.confirm(`Видалити команду "${teamName}" назавжди? Усі учасники втратять доступ.`)) return
    try {
      await del(`/teams/${teamId}`)
      await load()
    } catch {
      // ignore
    }
  }

  async function joinTeam() {
    if (!joinTeamName.trim() || !joinPassword) return
    setJoinBusy(true)
    setJoinError(null)
    try {
      await post('/teams/join', { name: joinTeamName.trim(), password: joinPassword, display_name: activeProfile?.name || '?' })
      setJoinTeamName('')
      setJoinPassword('')
      await load()
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : 'Не вдалося вступити')
    } finally {
      setJoinBusy(false)
    }
  }

  // Shared by "Мої команди" (teams I'm personally in) and the admin's "Усі
  // команди" list (any team, once expanded) — the actual member rows +
  // invite form are identical either way, only WHERE they're shown differs.
  function renderMemberManagement(teamId: string, teamName: string, canManage: boolean) {
    return (
      <>
        <div className="flex flex-col gap-1">
          {(membersByTeam[teamId] || []).map((m) => (
            <div key={m.device_id} className="flex flex-col gap-1 py-0.5">
              <div className="flex items-center gap-2 text-[11px] text-rh-text-dim font-mono">
                <span className="flex-1 truncate">
                  {m.display_name} {m.is_team_admin ? '· тім-адмін' : ''} · {m.device_id.slice(0, 10)}
                </span>
                {m.device_id === deviceId ? (
                  <button onClick={() => leaveTeam(teamId, teamName)} className="text-rh-muted hover:text-red-400 text-[10.5px]">
                    Вийти
                  </button>
                ) : (
                  <>
                    {isAppAdmin && (
                      <button
                        onClick={() => toggleTeamAdmin(teamId, m.device_id, !m.is_team_admin)}
                        className="text-amber-400/80 hover:text-amber-300 text-[10.5px]"
                      >
                        {m.is_team_admin ? '−admin' : '+admin'}
                      </button>
                    )}
                    {canManage && (
                      <button onClick={() => removeMember(teamId, m.device_id)} className="text-rh-muted hover:text-red-400">✕</button>
                    )}
                  </>
                )}
              </div>
              {/* Job-title roles — editable by this team's own admin (or
                  the app admin) only, never by the member themselves (see
                  ProfileModal.tsx/SettingsPage.tsx's removed self-edit
                  spots). isAdmin={false} here deliberately — a team admin
                  picks FROM the existing role catalog, editing the catalog
                  itself stays a true-app-admin-only action (see
                  RolePicker's own comment). */}
              {canManage ? (
                <RolePicker
                  selected={m.roles || []}
                  onChange={(roles) => saveMemberRoles(teamId, m.device_id, roles)}
                  isAdmin={false}
                  className="pl-1"
                />
              ) : (
                (m.roles || []).length > 0 && (
                  <span className="pl-1 text-[10px] text-rh-muted">{(m.roles || []).join(', ')}</span>
                )
              )}
            </div>
          ))}
        </div>
        {canManage && (joinRequestsByTeam[teamId] || []).length > 0 && (
          <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-rh-border/50">
            <div className="text-[10.5px] font-bold text-rh-text-dim">
              Заявки на вступ ({(joinRequestsByTeam[teamId] || []).length})
            </div>
            {(joinRequestsByTeam[teamId] || []).map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-[11px]">
                <span className="flex-1 truncate">
                  {r.display_name}{r.telegram_username ? ` (@${r.telegram_username})` : ''}
                </span>
                <button onClick={() => respondJoinRequest(teamId, r.id, false)} className="rh-btn-ghost text-[10.5px] px-2 py-1">Відхилити</button>
                <button onClick={() => respondJoinRequest(teamId, r.id, true)} className="rh-btn-primary text-[10.5px] px-2 py-1">Прийняти</button>
              </div>
            ))}
          </div>
        )}
        {canManage && (
          <div className="flex flex-col gap-1 mt-1">
            <div className="flex gap-1.5">
              <input
                value={inviteDeviceId[teamId] || ''}
                onChange={(e) => setInviteDeviceId((s) => ({ ...s, [teamId]: e.target.value }))}
                placeholder="ID пристрою для запрошення"
                className="flex-1 min-w-0 bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px] font-mono"
              />
              <button onClick={() => invite(teamId)} className="rh-btn-outline text-[11px] px-2 py-1.5 flex-none">
                Запросити
              </button>
            </div>
            {inviteError[teamId] && <span className="text-[11px] text-[#FF6B70]">{inviteError[teamId]}</span>}
          </div>
        )}
      </>
    )
  }

  async function createTeam() {
    if (!newName.trim() || !newPassword) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      await post('/teams', { name: newName.trim(), password: newPassword, credits_enabled: newCreditsEnabled })
      setNewName('')
      setNewPassword('')
      setNewCreditsEnabled(false)
      setCreating(false)
      await load()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Не вдалося створити')
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <>
      {loading ? (
        <div className="text-xs text-rh-muted">Завантаження…</div>
      ) : (
        <div className="flex flex-col gap-5">
          {invites.length > 0 && (
            <div className="bg-rh-card border border-rh-accent/40 rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-rh-border/70 text-[12.5px] font-bold">Вхідні запрошення</div>
              {invites.map((inv) => (
                <div key={inv.id} className="flex items-center gap-3 py-3 px-4 border-b border-rh-border/70 last:border-b-0">
                  <div className="flex-1 text-xs">
                    Команда <span className="font-semibold">{inv.team_name}</span> запрошує вас
                  </div>
                  <button onClick={() => respondInvite(inv.id, false)} className="rh-btn-ghost text-[11px] px-2 py-1">Відхилити</button>
                  <button onClick={() => respondInvite(inv.id, true)} className="rh-btn-primary text-[11px] px-2 py-1">Прийняти</button>
                </div>
              ))}
            </div>
          )}

          <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-rh-border/70 text-[12.5px] font-bold">Мої команди</div>
            {myTeams.length === 0 && (
              <div className="px-4 py-3 text-xs text-rh-muted">Ви ще не в жодній команді.</div>
            )}
            {myTeams.map((t) => (
              <div key={t.id} className="px-4 py-3 border-b border-rh-border/70 last:border-b-0 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {renamingTeam[t.id] !== undefined ? (
                    <>
                      <input
                        autoFocus
                        value={renamingTeam[t.id]}
                        onChange={(e) => setRenamingTeam((prev) => ({ ...prev, [t.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveTeamRename(t.id) }}
                        className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1 text-xs font-semibold flex-1 min-w-0"
                      />
                      <button onClick={() => saveTeamRename(t.id)} className="rh-btn-primary text-[10.5px] px-2 py-1">Зберегти</button>
                      <button
                        onClick={() => setRenamingTeam((prev) => { const next = { ...prev }; delete next[t.id]; return next })}
                        className="rh-btn-ghost text-[10.5px] px-2 py-1"
                      >
                        Скасувати
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-semibold">{t.name}</span>
                      {(!!t.is_team_admin || isAppAdmin) && (
                        <button
                          onClick={() => setRenamingTeam((prev) => ({ ...prev, [t.id]: t.name }))}
                          className="text-rh-muted hover:text-white text-[10.5px]"
                          title="Перейменувати команду"
                        >
                          ✎
                        </button>
                      )}
                    </>
                  )}
                  {!!t.is_team_admin && (
                    <span className="text-[9px] font-bold uppercase tracking-wide text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded px-1 py-0.5">
                      тім-адмін
                    </span>
                  )}
                  {!!t.credits_enabled && (
                    <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 rounded px-1 py-0.5">
                      кредити
                    </span>
                  )}
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(t.id).then(() => {
                        setCopiedTeamId(t.id)
                        setTimeout(() => setCopiedTeamId((id) => (id === t.id ? null : id)), 1500)
                      }).catch(() => {})
                    }}
                    title="Для налаштування скрипта «Marker Manager» в Reaper — команда попросить цей ID один раз"
                    className="ml-auto text-[10px] text-rh-muted hover:text-white flex-shrink-0"
                  >
                    {copiedTeamId === t.id ? 'Скопійовано' : 'ID для Reaper'}
                  </button>
                </div>
                {renameError && renamingTeam[t.id] !== undefined && (
                  <span className="text-[10.5px] text-[#FF6B70]">{renameError}</span>
                )}
                {renderMemberManagement(t.id, t.name, !!t.is_team_admin || isAppAdmin)}
              </div>
            ))}
          </div>

          {(
            <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-rh-border/70 text-[12.5px] font-bold">Вступити в команду</div>
              <div className="px-4 py-3 flex flex-col gap-2">
                <p className="text-[10.5px] text-rh-text-dim -mt-1">
                  Введіть точну назву команди, яку вам повідомив адмін.
                  Або напишіть Telegram-боту <span className="font-mono">join &lt;ID команди&gt;</span> — адмін
                  прийме заявку в цьому розділі.
                </p>
                <input
                  value={joinTeamName}
                  onChange={(e) => { setJoinTeamName(e.target.value); setJoinError(null) }}
                  placeholder="Назва команди"
                  className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px]"
                />
                <input
                  type="password"
                  value={joinPassword}
                  onChange={(e) => { setJoinPassword(e.target.value); setJoinError(null) }}
                  placeholder="Пароль команди"
                  className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px]"
                />
                {joinError && <span className="text-[11px] text-[#FF6B70]">{joinError}</span>}
                <button
                  onClick={joinTeam}
                  disabled={joinBusy || !joinTeamName.trim() || !joinPassword}
                  className="rh-btn-primary text-[11px] px-3 py-1.5 self-start disabled:opacity-40"
                >
                  Вступити
                </button>
              </div>
            </div>
          )}

          {isAppAdmin && (
            <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-rh-border/70 flex items-center justify-between">
                <span className="text-[12.5px] font-bold">Усі команди (адмін)</span>
                {!creating && (
                  <button onClick={() => setCreating(true)} className="rh-btn-outline text-[11px] px-2 py-1">+ Створити</button>
                )}
              </div>
              {creating && (
                <div className="px-4 py-3 border-b border-rh-border/70 flex flex-col gap-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Назва команди"
                    className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px]"
                    autoFocus
                  />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Пароль команди"
                    className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px]"
                  />
                  <div className="flex items-center gap-2">
                    <Toggle checked={newCreditsEnabled} onChange={setNewCreditsEnabled} />
                    <span className="text-[11px] text-rh-text-dim">Дозволити кредитні нейромережі учасникам</span>
                  </div>
                  {createError && <span className="text-[11px] text-[#FF6B70]">{createError}</span>}
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setCreating(false)} className="rh-btn-ghost text-[11px] px-2 py-1">Скасувати</button>
                    <button
                      onClick={createTeam}
                      disabled={createBusy || !newName.trim() || !newPassword}
                      className="rh-btn-primary text-[11px] px-3 py-1 disabled:opacity-40"
                    >
                      Створити
                    </button>
                  </div>
                </div>
              )}
              {allTeams.map((t) => (
                <div key={t.id} className="border-b border-rh-border/70 last:border-b-0">
                  <div
                    className="px-4 py-2.5 text-[11px] font-mono text-rh-text-dim flex items-center gap-2 cursor-pointer hover:bg-white/[0.03]"
                    onClick={() => toggleExpand(t.id)}
                  >
                    <span className="flex-1 truncate text-rh-text font-sans">{t.name}</span>
                    <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <Toggle checked={!!t.credits_enabled} onChange={(v) => toggleTeamCredits(t.id, v)} />
                      <span className={t.credits_enabled ? 'text-emerald-400' : 'text-rh-muted'}>кредити</span>
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setPreviewTeam(t) }}
                      className="text-rh-muted hover:text-rh-accent flex-shrink-0"
                      title="Переглянути вміст команди"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                      </svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeTeam(t.id, t.name) }}
                      className="text-rh-muted hover:text-red-400 flex-shrink-0"
                      title="Видалити команду"
                    >
                      ✕
                    </button>
                  </div>
                  {expandedTeamId === t.id && (
                    <div className="px-4 py-3 bg-black/20 flex flex-col gap-1">
                      {renderMemberManagement(t.id, t.name, true)}
                    </div>
                  )}
                </div>
              ))}
              {previewTeam && (
                <TeamContentPreviewModal team={previewTeam} onClose={() => setPreviewTeam(null)} />
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

// Every device that's ever connected online, whether or not it's in a team
// (see team_service.all_known_users / known_devices) — team name is shown
// next to whoever has one, "без команди" otherwise. Admin-only: forbidden
// (empty list) for anyone else, enforced server-side too, not just by
// hiding the tab (see TeamsPage's own isAppAdmin check for that).
function UsersTab() {
  const { get, put, post } = useApi()
  const [users, setUsers] = useState<KnownUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [mvsepEnabled, setMvsepEnabled] = useState(false)
  const [mvsepBusy, setMvsepBusy] = useState(false)
  // Inline Telegram compose, one row open at a time — mirrors busyId's
  // "just track which row" pattern above rather than per-row state objects.
  const [messagingId, setMessagingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)
  const [justSentId, setJustSentId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [data, mvsep] = await Promise.all([
        get<KnownUser[]>('/teams/users/all'),
        get<{ enabled: boolean }>('/teams/mvsep-config'),
      ])
      setUsers(data)
      setMvsepEnabled(mvsep.enabled)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Немає доступу')
    } finally {
      setLoading(false)
    }
  }, [get])

  useEffect(() => { load() }, [load])

  async function toggleCredits(u: KnownUser) {
    setBusyId(u.device_id)
    try {
      await put(`/teams/users/${u.device_id}/credits`, { enabled: !u.credits_enabled })
      setUsers((prev) => prev.map((x) => (x.device_id === u.device_id ? { ...x, credits_enabled: !x.credits_enabled } : x)))
    } catch {
      // ignore
    } finally {
      setBusyId(null)
    }
  }

  async function sendMessage(deviceId: string) {
    const text = draft.trim()
    if (!text) return
    setSendingMessage(true)
    try {
      await post(`/teams/users/${deviceId}/message`, { message: text })
      setDraft('')
      setMessagingId(null)
      setJustSentId(deviceId)
      setTimeout(() => setJustSentId((id) => (id === deviceId ? null : id)), 3000)
    } catch {
      // ignore
    } finally {
      setSendingMessage(false)
    }
  }

  async function toggleMvsep() {
    setMvsepBusy(true)
    try {
      await put('/teams/mvsep-config', { enabled: !mvsepEnabled })
      setMvsepEnabled((v) => !v)
    } catch {
      // ignore
    } finally {
      setMvsepBusy(false)
    }
  }

  if (loading) return <div className="text-xs text-rh-muted">Завантаження…</div>
  if (error) return <div className="text-xs text-rh-muted">{error}</div>

  return (
    <div className="flex flex-col gap-5">
      {/* Master kill-switch for MVSep credit usage studio-wide — separate
          from both a team's own credits_enabled AND a person's individual
          grant below, which decide WHO is eligible; this decides whether
          credit usage works AT ALL right now (e.g. admin ran out of MVSep
          balance). Only reachable here at all if /teams/users/all already
          succeeded, i.e. this IS the app admin. */}
      <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
        <div className="flex items-center gap-3 py-3.5 px-4">
          <div className="flex-1">
            <div className="text-[12.5px] font-bold">Кредитні нейромережі MVSep — глобально</div>
            <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
              Вимикає використання кредитів для всіх одразу, незалежно від команд і особистих дозволів
            </div>
          </div>
          <Toggle checked={mvsepEnabled} onChange={toggleMvsep} className={mvsepBusy ? 'opacity-50 pointer-events-none' : ''} />
        </div>
      </div>

      <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-rh-border/70 text-[12.5px] font-bold">
          Усі користувачі ({users.length})
        </div>
      {users.length === 0 && (
        <div className="px-4 py-3 text-xs text-rh-muted">Ще нікого — люди з'являться тут, щойно хоч раз зайдуть онлайн.</div>
      )}
      {users.map((u) => (
        <div key={u.device_id} className="border-b border-rh-border/70 last:border-b-0">
          <div className="flex items-center gap-3 py-3 px-4">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate">{u.display_name}</div>
              <div className="text-[10.5px] text-rh-muted font-mono truncate">
                {u.device_id} · {u.teams.length > 0
                  ? u.teams.map((t) => t.team_name + (t.is_team_admin ? ' (адмін)' : '')).join(', ')
                  : 'без команди'}
              </div>
            </div>
            {justSentId === u.device_id && (
              <span className="text-[10.5px] text-emerald-400 flex-shrink-0">Надіслано</span>
            )}
            {/* Only shown for people who've done Telegram login (telegram_id
                on file, synced via known_devices) — no button at all
                otherwise, keeps the common case uncluttered. */}
            {u.telegram_id != null && messagingId !== u.device_id && (
              <button
                onClick={() => { setMessagingId(u.device_id); setDraft('') }}
                className="rh-btn-outline text-[10.5px] px-2 py-1 flex-shrink-0"
              >
                Написати
              </button>
            )}
            {u.credits_from_team ? (
              <span className="text-[10.5px] text-emerald-400 flex-shrink-0" title="Кредити через команду — вимикається на рівні команди, не тут">
                через команду
              </span>
            ) : (
              <Toggle checked={u.credits_enabled} onChange={() => toggleCredits(u)} className={busyId === u.device_id ? 'opacity-50 pointer-events-none' : ''} />
            )}
          </div>
          {messagingId === u.device_id && (
            <div className="flex items-center gap-2 px-4 pb-3">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendMessage(u.device_id)
                  if (e.key === 'Escape') setMessagingId(null)
                }}
                placeholder="Повідомлення в Telegram…"
                className="flex-1 bg-rh-bg border border-rh-border rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-rh-accent"
              />
              <button
                onClick={() => sendMessage(u.device_id)}
                disabled={sendingMessage || !draft.trim()}
                className="rh-btn-outline text-xs flex-shrink-0"
              >
                {sendingMessage ? <Spinner size={12} /> : 'Надіслати'}
              </button>
              <button onClick={() => setMessagingId(null)} className="text-rh-muted text-xs hover:text-white flex-shrink-0">
                Скасувати
              </button>
            </div>
          )}
        </div>
      ))}
      </div>
    </div>
  )
}

// Richer per-user browser than UsersTab above (which stays focused on
// credits/Telegram-messaging) — avatar/telegram login/roles at a glance,
// click a row for their "logs" (separation reports + feedback + renderer
// errors, all cross-referenced by device_id — see the backend's device_id
// plumbing added alongside this), and precise per-user deletion so QA/test
// profiles don't pile up in the shared production database (deliberately
// NOT a single wipe-everything button — see team_service.delete_known_user's
// own docstring for why).
function DatabaseTab() {
  const { get, del } = useApi()
  const [users, setUsers] = useState<KnownUser[]>([])
  const [avatarBase, setAvatarBase] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'console' | 'reports' | 'feedback' | 'errors'>('console')
  const [reports, setReports] = useState<SeparationReport[] | null>(null)
  const [feedback, setFeedback] = useState<FeedbackItem[] | null>(null)
  const [errors, setErrors] = useState<ErrorReport[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [logFile, setLogFile] = useState<'app.log' | 'electron.log' | 'power_share.log'>('electron.log')
  const [logContent, setLogContent] = useState<string | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [logLoading, setLogLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const [data, settings] = await Promise.all([
        get<KnownUser[]>('/teams/users/all'),
        get<AppSettings>('/settings'),
      ])
      setUsers(data)
      const url = settings.online_signaling_url
      setAvatarBase(url ? url.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '').replace(/\/ws$/, '') : null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Немає доступу')
    } finally {
      setLoading(false)
    }
  }, [get])

  useEffect(() => { load() }, [load])

  // The three "logs" lists are small studio-wide totals (matches this app's
  // existing "fetch-all, filter client-side" posture for other admin-only
  // small-N lists) — fetched once when a row is first expanded, not per
  // sub-tab switch.
  useEffect(() => {
    if (!expandedId) return
    if (reports === null) get<SeparationReport[]>('/reports').then(setReports).catch(() => setReports([]))
    if (feedback === null) get<FeedbackItem[]>('/feedback').then(setFeedback).catch(() => setFeedback([]))
    if (errors === null) get<ErrorReport[]>('/errors').then(setErrors).catch(() => setErrors([]))
  }, [expandedId, get, reports, feedback, errors])

  // On-demand, not auto-fetched — this is a live relay call to the target
  // person's own machine (see backend discovery_service.fetch_log_by_device_id),
  // only works while they're online, and can take up to ~20s to time out
  // when they're not — no reason to fire it just from expanding a row.
  async function fetchLog(deviceId: string, filename: string) {
    setLogLoading(true)
    setLogError(null)
    setLogContent(null)
    try {
      const result = await get<{ content: string }>(`/teams/users/${deviceId}/log?filename=${filename}`)
      setLogContent(result.content || '(порожньо)')
    } catch (e) {
      setLogError(e instanceof Error ? e.message : 'Не вдалося отримати журнал')
    } finally {
      setLogLoading(false)
    }
  }

  async function deleteUser(deviceId: string) {
    if (!window.confirm('Видалити цього користувача з бази? Це видалить його ідентичність, членство в командах і кредитний доступ. Спільні тайтли/епізоди команди НЕ зачіпаються.')) return
    setBusyId(deviceId)
    try {
      await del(`/teams/users/${deviceId}`)
      setUsers((prev) => prev.filter((u) => u.device_id !== deviceId))
      if (expandedId === deviceId) setExpandedId(null)
    } catch {
      // ignore
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <div className="text-xs text-rh-muted">Завантаження…</div>
  if (error) return <div className="text-xs text-rh-muted">{error}</div>

  return (
    <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-rh-border/70 text-[12.5px] font-bold">
        База даних ({users.length})
      </div>
      {users.length === 0 && (
        <div className="px-4 py-3 text-xs text-rh-muted">Ще нікого — люди з'являться тут, щойно хоч раз зайдуть онлайн.</div>
      )}
      {users.map((u) => {
        const isOpen = expandedId === u.device_id
        const userReports = reports?.filter((r) => r.device_id === u.device_id) ?? []
        const userFeedback = feedback?.filter((f) => f.device_id === u.device_id) ?? []
        const userErrors = errors?.filter((e) => e.device_id === u.device_id) ?? []
        return (
          <div key={u.device_id} className="border-b border-rh-border/70 last:border-b-0">
            <div
              className="flex items-center gap-3 py-3 px-4 cursor-pointer hover:bg-white/[0.02]"
              onClick={() => {
                if (isOpen) { setExpandedId(null); return }
                setExpandedId(u.device_id)
                setDetailTab('console')
                setLogContent(null)
                setLogError(null)
              }}
            >
              {u.telegram_id != null && avatarBase ? (
                <img
                  src={`${avatarBase}/telegram-avatar/${u.telegram_id}`}
                  alt=""
                  className="w-8 h-8 rounded-full flex-shrink-0 object-cover bg-rh-bg"
                  onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                />
              ) : (
                <div className="w-8 h-8 rounded-full flex-shrink-0 bg-rh-bg border border-rh-border" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">{u.display_name}</div>
                <div className="text-[10.5px] text-rh-muted font-mono truncate">
                  {u.telegram_username ? `@${u.telegram_username}` : u.telegram_id ?? '—'}
                  {(u.roles?.length ?? 0) > 0 && <> · {u.roles!.join(', ')}</>}
                </div>
              </div>
              {/* Opens a real Telegram chat with this person for the ADMIN
                  to type into personally — distinct from the bot-driven
                  "Написати" in the Користувачі tab above, which sends a
                  message the app composes and the bot delivers. */}
              {u.telegram_username && (
                <button
                  onClick={(e) => { e.stopPropagation(); window.electronAPI?.openTelegramChat(u.telegram_username!) }}
                  className="rh-btn-ghost text-[10.5px] px-2 py-1 flex-shrink-0"
                  title="Відкрити чат у Telegram"
                >
                  Telegram ↗
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); deleteUser(u.device_id) }}
                disabled={busyId === u.device_id}
                className="rh-btn-ghost text-[10.5px] px-2 py-1 flex-shrink-0 hover:text-red-400"
              >
                {busyId === u.device_id ? <Spinner size={12} /> : 'Видалити'}
              </button>
            </div>
            {isOpen && (
              <div className="px-4 pb-3">
                <div className="text-[10.5px] text-rh-muted font-mono mb-2">
                  Перша авторизація: {u.first_seen_at ? new Date(u.first_seen_at).toLocaleString() : '—'}
                  {' · '}Востаннє в мережі: {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—'}
                </div>
                <div className="flex items-center gap-1 mb-2">
                  {(['console', 'reports', 'feedback', 'errors'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setDetailTab(t)}
                      className={`px-2.5 py-1 text-[10.5px] font-semibold rounded-md transition-colors ${detailTab === t ? 'bg-rh-accent/15 text-rh-accent' : 'text-rh-muted hover:text-white'}`}
                    >
                      {t === 'console' ? 'Консоль' : t === 'reports' ? `Звіти (${userReports.length})` : t === 'feedback' ? `Фідбек (${userFeedback.length})` : `Помилки (${userErrors.length})`}
                    </button>
                  ))}
                </div>
                {detailTab === 'console' && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-1.5">
                      {(['electron.log', 'app.log', 'power_share.log'] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setLogFile(f)}
                          className={`px-2 py-1 text-[10px] font-mono rounded-md transition-colors ${logFile === f ? 'bg-rh-accent/15 text-rh-accent' : 'text-rh-muted hover:text-white'}`}
                        >
                          {f}
                        </button>
                      ))}
                      <button
                        onClick={() => fetchLog(u.device_id, logFile)}
                        disabled={logLoading}
                        className="rh-btn-outline text-[10px] px-2 py-1 ml-auto flex-shrink-0"
                      >
                        {logLoading ? <Spinner size={11} /> : 'Завантажити'}
                      </button>
                    </div>
                    {logError && <div className="text-[11px] text-[#FF6B70]">{logError}</div>}
                    {logContent != null && (
                      <pre className="text-[10px] font-mono text-rh-text-dim bg-rh-bg border border-rh-border rounded-lg p-2.5 max-h-72 overflow-auto whitespace-pre-wrap break-words">
                        {logContent}
                      </pre>
                    )}
                    {logContent == null && !logError && !logLoading && (
                      <div className="text-xs text-rh-muted">Натисніть «Завантажити», щоб отримати свіжий журнал (лише поки людина в мережі).</div>
                    )}
                  </div>
                )}
                {detailTab !== 'console' && (reports === null || feedback === null || errors === null ? (
                  <div className="flex justify-center py-3"><Spinner size={14} className="text-rh-accent" /></div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {detailTab === 'reports' && (userReports.length === 0
                      ? <div className="text-xs text-rh-muted">Немає звітів.</div>
                      : userReports.map((r) => (
                        <div key={r.id} className="text-[11px] rounded-lg border border-rh-border px-2.5 py-1.5">
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{r.episode_label || '—'}</span>
                            <span className="text-rh-muted font-mono text-[10px]">{new Date(r.created_at).toLocaleString()}</span>
                          </div>
                          <div className="text-rh-muted mt-0.5">
                            {r.model} · {r.status}{r.error_message ? ` · ${r.error_message}` : ''}
                          </div>
                        </div>
                      )))}
                    {detailTab === 'feedback' && (userFeedback.length === 0
                      ? <div className="text-xs text-rh-muted">Немає звернень.</div>
                      : userFeedback.map((f) => (
                        <div key={f.id} className="text-[11px] rounded-lg border border-rh-border px-2.5 py-1.5">
                          <div className="whitespace-pre-wrap break-words">{f.message}</div>
                          <div className="text-rh-muted font-mono text-[10px] mt-1">{new Date(f.created_at).toLocaleString()}</div>
                        </div>
                      )))}
                    {detailTab === 'errors' && (userErrors.length === 0
                      ? <div className="text-xs text-rh-muted">Немає помилок.</div>
                      : userErrors.map((e) => (
                        <div key={e.id} className="text-[11px] rounded-lg border border-rh-border px-2.5 py-1.5">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-red-400">{e.message}</span>
                            <span className="text-rh-muted font-mono text-[10px]">{new Date(e.created_at).toLocaleString()}</span>
                          </div>
                          <div className="text-rh-muted mt-0.5">{e.context}</div>
                        </div>
                      )))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// --- Admin "box" — read-only preview of a team's content, never written
// to local SQLite (see backend team_service.admin_preview_team_content).
// Loose local shapes matching the Worker's raw shared_titles snapshot
// JSON (cloudflare-signaling/src/index.ts's GET /shared-titles) — not the
// app's normal typed models, since this is someone else's data the local
// install never mirrors.
interface PreviewCharacter { id: string; name: string; code?: string | null }
interface PreviewMarker { id: string; reaper_name: string; position_seconds: number; confirmed: number; color?: string | null; character_id?: string | null }
interface PreviewLine { id: string; start_ms: number; end_ms: number; text: string; character_id?: string | null }
interface PreviewAudioSubmission {
  id: string; filename: string; transfer_id: string; uploaded_by_name: string; created_at: string
  character_id?: string | null; fix_requested_at?: string | null; sent_to_sound_engineer_at?: string | null
}
interface PreviewEpisode {
  id: string; season: number; number: number; video_transfer_id?: string | null; original_filename?: string | null
  status: string; subtitle_stage: string
  subtitle_lines: PreviewLine[]; markers: PreviewMarker[]; audio_submissions: PreviewAudioSubmission[]
}
interface PreviewTitle {
  id: string; name_ua: string; name_original: string
  episodes: PreviewEpisode[]; characters: PreviewCharacter[]
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

interface TeamContentPreviewModalProps {
  team: Team
  onClose: () => void
}
function TeamContentPreviewModal({ team, onClose }: TeamContentPreviewModalProps) {
  const { get } = useApi()
  const [titles, setTitles] = useState<PreviewTitle[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTitleId, setSelectedTitleId] = useState<string | null>(null)
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    get<PreviewTitle[]>(`/teams/${team.id}/preview`)
      .then(setTitles)
      .catch(() => setTitles([]))
      .finally(() => setLoading(false))
  }, [get, team.id])

  const selectedTitle = titles.find((t) => t.id === selectedTitleId) ?? null
  const selectedEpisode = selectedTitle?.episodes.find((e) => e.id === selectedEpisodeId) ?? null
  const charName = (id?: string | null) => selectedTitle?.characters.find((c) => c.id === id)?.name ?? '—'

  useEffect(() => {
    setVideoUrl(null)
    if (!selectedEpisode?.video_transfer_id) return
    get<{ url: string }>(
      `/teams/preview/transfer-url?transfer_id=${encodeURIComponent(selectedEpisode.video_transfer_id)}`,
    ).then((r) => setVideoUrl(r.url)).catch(() => {})
  }, [get, selectedEpisode])

  async function downloadUrl(transferId: string, filename: string) {
    try {
      const r = await get<{ url: string }>(
        `/teams/preview/transfer-url?transfer_id=${encodeURIComponent(transferId)}&filename=${encodeURIComponent(filename)}`,
      )
      window.open(r.url, '_blank')
    } catch {
      /* ignore */
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="bg-rh-card border border-rh-border rounded-2xl w-full max-w-3xl h-[85vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-rh-border/70 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="text-[13px] font-bold">Вміст команди</div>
            <div className="text-[10.5px] text-rh-muted mt-0.5">{team.name}</div>
          </div>
          <button onClick={onClose} className="text-rh-muted hover:text-white text-sm">✕</button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Titles */}
          <div className="w-1/4 border-r border-rh-border/70 overflow-y-auto flex-shrink-0">
            {loading ? (
              <div className="p-3"><Spinner size={16} /></div>
            ) : titles.length === 0 ? (
              <div className="p-3 text-[11px] text-rh-muted">Немає спільних тайтлів</div>
            ) : titles.map((t) => (
              <button
                key={t.id}
                onClick={() => { setSelectedTitleId(t.id); setSelectedEpisodeId(null) }}
                className={`w-full text-left px-3 py-2 text-[11.5px] border-b border-rh-border/50 hover:bg-white/5 ${selectedTitleId === t.id ? 'text-rh-accent font-semibold' : 'text-rh-text'}`}
              >
                {t.name_ua}
              </button>
            ))}
          </div>

          {/* Episodes */}
          <div className="w-1/4 border-r border-rh-border/70 overflow-y-auto flex-shrink-0">
            {selectedTitle?.episodes.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelectedEpisodeId(e.id)}
                className={`w-full text-left px-3 py-2 text-[11.5px] border-b border-rh-border/50 hover:bg-white/5 ${selectedEpisodeId === e.id ? 'text-rh-accent font-semibold' : 'text-rh-text'}`}
              >
                S{String(e.season).padStart(2, '0')}E{String(e.number).padStart(2, '0')}
              </button>
            ))}
          </div>

          {/* Episode detail */}
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
            {!selectedEpisode ? (
              <div className="text-[11px] text-rh-muted">Оберіть серію</div>
            ) : (
              <>
                <div>
                  <div className="text-[11px] font-bold text-rh-muted mb-1.5">Відео</div>
                  {videoUrl ? (
                    <video src={videoUrl} controls className="w-full rounded-xl bg-black max-h-[220px]" />
                  ) : (
                    <div className="text-[11px] text-rh-muted">Немає відео</div>
                  )}
                  {selectedEpisode.video_transfer_id && (
                    <button
                      onClick={() => downloadUrl(selectedEpisode.video_transfer_id!, selectedEpisode.original_filename || 'video.mp4')}
                      className="rh-btn-outline text-[11px] px-2.5 py-1 mt-1.5"
                    >
                      Завантажити
                    </button>
                  )}
                </div>

                <div>
                  <div className="text-[11px] font-bold text-rh-muted mb-1.5">Субтитри ({selectedEpisode.subtitle_lines.length})</div>
                  <div className="flex flex-col gap-0.5 max-h-[160px] overflow-y-auto">
                    {selectedEpisode.subtitle_lines.map((l) => (
                      <div key={l.id} className="text-[10.5px] flex gap-2">
                        <span className="text-rh-muted font-mono flex-shrink-0">{fmtMs(l.start_ms)}</span>
                        <span className="text-rh-accent/80 flex-shrink-0">{charName(l.character_id)}</span>
                        <span className="text-rh-text truncate">{l.text}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-bold text-rh-muted mb-1.5">Маркери ({selectedEpisode.markers.length})</div>
                  <div className="flex flex-col gap-0.5 max-h-[120px] overflow-y-auto">
                    {selectedEpisode.markers.map((m) => (
                      <div key={m.id} className="text-[10.5px] flex gap-2 items-center">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: m.color || '#666' }} />
                        <span className="text-rh-muted font-mono flex-shrink-0">{fmtMs(m.position_seconds * 1000)}</span>
                        <span className="text-rh-text truncate">{m.reaper_name}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-bold text-rh-muted mb-1.5">Аудіодоріжки ({selectedEpisode.audio_submissions.length})</div>
                  <div className="flex flex-col gap-1">
                    {selectedEpisode.audio_submissions.map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-2 text-[10.5px]">
                        <span className="truncate">{s.filename} · {s.uploaded_by_name}</span>
                        <button onClick={() => downloadUrl(s.transfer_id, s.filename)} className="rh-btn-outline text-[10px] px-2 py-0.5 flex-shrink-0">
                          Завантажити
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
