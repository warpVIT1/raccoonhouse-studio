import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { EpisodeWorkspace } from './EpisodeWorkspace'
import { DirectorWorkspace } from './DirectorWorkspace'
import { ActorWorkspace } from './ActorWorkspace'
import { TranslatorWorkspace } from './TranslatorWorkspace'
import { CleanerWorkspace } from './CleanerWorkspace'
import { AdminWorkspace } from './AdminWorkspace'

const ROLE_WORKSPACE_LABELS: Record<string, string> = {
  actor: 'Актор',
  sound_engineer: 'Звукорежисер',
  director: 'Режисер',
  translator: 'Перекладач',
  cleaner: 'Клінапер',
}

// Not a real job-title role (never appears in Profile.roles) — a pseudo-tab
// shown alongside the real ones whenever this profile can manage the
// episode's production status, same gate DirectorWorkspace's old nested
// "Адмін" tab used to check. Lives here (peer of Актор/Режисер/etc.), not
// nested inside any one role's own workspace, since it isn't actually that
// role's content — confirmed live 2026-08-19 after the first attempt put it
// inside DirectorWorkspace's own tab bar, which wasn't the wanted shape.
const ADMIN_TAB = '__admin__'

// First-ever open (nothing remembered yet, see storageKey below) picks
// whichever of these the profile has, in this order — actor first,
// sound_engineer second, per the explicit request; the rest follow in no
// particular declared priority since nothing more specific was asked for.
// ADMIN_TAB is deliberately absent here — it's opt-in only (a click), never
// auto-selected, unless it's the only visible tab at all (see below).
const ROLE_PRIORITY = ['actor', 'sound_engineer', 'director', 'translator', 'cleaner']

interface EpisodeRoleRouterProps {
  episodeId: number
  titleId: number
}

// Sits where <EpisodeWorkspace> used to be mounted directly (see App.tsx) —
// a profile with only one role (or none at all — e.g. a profile created
// before this feature existed) sees exactly what they always saw, no tab
// bar. Multiple roles get a tab bar and their own dedicated workspace per
// role: "sound_engineer" still lands on the full EpisodeWorkspace (it has
// everything a sound engineer needs — markers, audio submissions, the
// original-video download banner), "director", "actor", "translator" and
// "cleaner" get their own dedicated ones. Team-admin/app-admin profiles
// additionally get an "Адмін" tab (see ADMIN_TAB above) — it auto-saves
// every edit (see AdminWorkspace.tsx), so switching away from it needs no
// unsaved-changes guard.
export function EpisodeRoleRouter({ episodeId, titleId }: EpisodeRoleRouterProps) {
  const { get } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const activeProfile = useAppStore((s) => s.activeProfile)
  const roles = activeProfile?.roles ?? []
  const rolesKey = roles.join(',')

  const [canManageAdmin, setCanManageAdmin] = useState(false)
  useEffect(() => {
    if (!backendReady) return
    get<{ can_delete_permanently: boolean }>(`/titles/${titleId}/can-delete-permanently`)
      .then((r) => setCanManageAdmin(r.can_delete_permanently))
      .catch(() => setCanManageAdmin(false))
  }, [backendReady, titleId, get])

  const visibleTabs = canManageAdmin ? [...roles, ADMIN_TAB] : roles

  const storageKey = activeProfile ? `rh_last_workspace_role_${activeProfile.id}` : null
  const [role, setRole] = useState<string | null>(null)

  useEffect(() => {
    if (roles.length === 0 && !canManageAdmin) {
      setRole(null)
      return
    }
    const remembered = storageKey ? localStorage.getItem(storageKey) : null
    if (remembered && visibleTabs.includes(remembered)) {
      setRole(remembered)
      return
    }
    setRole(ROLE_PRIORITY.find((r) => roles.includes(r)) ?? roles[0] ?? (canManageAdmin ? ADMIN_TAB : null))
    // rolesKey (not roles itself) so this doesn't re-run every render on a
    // new array reference with the same actual contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, rolesKey, canManageAdmin, storageKey])

  function selectRole(r: string) {
    setRole(r)
    if (storageKey) localStorage.setItem(storageKey, r)
  }

  if (visibleTabs.length === 0 || !role) {
    return <EpisodeWorkspace episodeId={episodeId} titleId={titleId} />
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {visibleTabs.length > 1 && (
        <div className="flex items-center gap-1 px-3 pt-2 flex-shrink-0 border-b border-rh-border">
          {visibleTabs.map((r) => (
            <button
              key={r}
              onClick={() => selectRole(r)}
              className={`px-3 py-1.5 text-[12px] font-semibold rounded-t-lg transition-colors ${
                role === r
                  ? 'bg-rh-card text-rh-accent border border-rh-border border-b-0'
                  : 'text-rh-muted hover:text-white'
              }`}
            >
              {r === ADMIN_TAB ? 'Адмін' : ROLE_WORKSPACE_LABELS[r] || r}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {role === 'director' ? (
          <DirectorWorkspace episodeId={episodeId} titleId={titleId} />
        ) : role === 'actor' ? (
          <ActorWorkspace episodeId={episodeId} titleId={titleId} />
        ) : role === 'translator' ? (
          <TranslatorWorkspace episodeId={episodeId} titleId={titleId} />
        ) : role === 'cleaner' ? (
          <CleanerWorkspace episodeId={episodeId} titleId={titleId} />
        ) : role === ADMIN_TAB ? (
          <AdminWorkspace episodeId={episodeId} titleId={titleId} />
        ) : (
          <EpisodeWorkspace episodeId={episodeId} titleId={titleId} />
        )}
      </div>
    </div>
  )
}
