import React, { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useApi } from '../hooks/useApi'

// Pushed live over the WS relay the moment a team admin invites this device
// (see backend discovery_service.py's "team_invite" relay kind) — the
// invite itself already persisted server-side regardless, so a missed/
// offline delivery still shows up via TeamsPage's own pending-invites poll;
// this is just the immediate nudge for when you're already online.
export function TeamInviteBanner() {
  const notice = useAppStore((s) => s.teamInviteNotice)
  const clear = useAppStore((s) => s.clearTeamInviteNotice)
  const activeProfile = useAppStore((s) => s.activeProfile)
  const { post } = useApi()
  const [busy, setBusy] = useState(false)
  if (!notice) return null

  async function respond(accept: boolean) {
    if (!notice) return
    setBusy(true)
    try {
      await post('/teams/invites/respond', {
        invite_id: notice.invite_id,
        accept,
        display_name: activeProfile?.name || '?',
      })
    } catch {
      // ignore — TeamsPage's own pending list is the source of truth if this fails
    } finally {
      setBusy(false)
      clear()
    }
  }

  return (
    <div className="fixed bottom-6 left-6 z-[100] w-80 rh-card p-4 shadow-2xl border border-rh-accent/40 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-rh-accent flex-shrink-0 animate-pulse" />
        <span className="text-xs font-semibold text-rh-accent">Запрошення в команду</span>
      </div>
      <p className="text-xs text-rh-text-dim leading-relaxed">
        Команда <span className="font-semibold text-rh-text">{notice.team_name}</span> запрошує вас приєднатися.
      </p>
      <div className="flex gap-2">
        <button onClick={() => respond(false)} disabled={busy} className="rh-btn-ghost flex-1">Відхилити</button>
        <button onClick={() => respond(true)} disabled={busy} className="rh-btn-primary flex-1">Прийняти</button>
      </div>
    </div>
  )
}
