import React, { useState, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useApi } from '../../hooks/useApi'
import { ProfileModal } from '../ProfileModal'
import logoUrl from '../../assets/logo.png'

interface SidebarProps {
  view: 'titles' | 'title' | 'episode' | 'settings' | 'browser' | 'teams' | 'contact'
  onNavigate: (view: 'titles' | 'settings' | 'browser' | 'teams' | 'contact') => void
}

export function Sidebar({ view, onNavigate }: SidebarProps) {
  const backendReady = useAppStore((s) => s.backendReady)
  const activeProfile = useAppStore((s) => s.activeProfile)
  const isLibraryArea = view === 'titles' || view === 'title' || view === 'episode'
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  // avatar_url always points at the Worker's own proxy even for a profile
  // with no Telegram photo at all (see ProfileModal.tsx's identical
  // fallback) — that 404s, so this drops back to the usual color-initials
  // badge instead of a broken image. Reset per profile id so switching to
  // a DIFFERENT profile with its own real photo gets a fresh attempt.
  const [avatarFailed, setAvatarFailed] = useState(false)
  useEffect(() => { setAvatarFailed(false) }, [activeProfile?.id])
  const { get } = useApi()
  // The "Команди" icon (and everything behind it) is hidden from anyone
  // who isn't already in a team and isn't the app admin — team admins/
  // members only ever see THEIR OWN team, and outsiders shouldn't even
  // know the page exists (confirmed live 2026-08-05: an earlier version
  // let any user browse every team's name via a join dropdown). Someone
  // invited while this is hidden still gets the live TeamInviteBanner popup
  // regardless — accepting it is what makes this icon appear, via the poll
  // below picking up their new membership shortly after.
  const [canSeeTeams, setCanSeeTeams] = useState(false)

  useEffect(() => {
    window.electronAPI?.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  useEffect(() => {
    if (!backendReady) return
    let cancelled = false
    async function check() {
      try {
        const [admin, mine] = await Promise.all([
          get<{ is_app_admin: boolean }>('/teams/is-app-admin'),
          get<unknown[]>('/teams/mine'),
        ])
        if (!cancelled) setCanSeeTeams(admin.is_app_admin || mine.length > 0)
      } catch {
        if (!cancelled) setCanSeeTeams(false)
      }
    }
    check()
    const interval = setInterval(check, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [backendReady, get, activeProfile])

  return (
    <aside className="w-14 flex flex-col items-center py-3 bg-rh-bg border-r border-rh-border flex-shrink-0">
      {/* Logo */}
      <button
        onClick={() => onNavigate('titles')}
        className="w-9 h-9 mb-6 flex items-center justify-center rounded-lg hover:bg-white/5 transition-colors no-drag overflow-hidden"
        title="RaccoonHouse Studio"
      >
        <img src={logoUrl} alt="RaccoonHouse" className="w-full h-full object-contain" />
      </button>

      {/* Nav items */}
      <nav className="flex flex-col gap-1.5 no-drag">
        <SidebarIcon active={isLibraryArea} onClick={() => onNavigate('titles')} title="Тайтли">
          {/* Grid icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        </SidebarIcon>
        <SidebarIcon active={view === 'browser'} onClick={() => onNavigate('browser')} title="Браузер моделей">
          {/* Globe icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </SidebarIcon>
        {canSeeTeams && (
          <SidebarIcon active={view === 'teams'} onClick={() => onNavigate('teams')} title="Команди">
            {/* People icon */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </SidebarIcon>
        )}
        <SidebarIcon active={view === 'contact'} onClick={() => onNavigate('contact')} title="Зв'язок з розробником">
          {/* Message/mail icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </SidebarIcon>
        <SidebarIcon active={view === 'settings'} onClick={() => onNavigate('settings')} title="Налаштування">
          {/* Gear icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </SidebarIcon>
      </nav>

      <div className="flex-1" />

      <div className="mb-2 no-drag" title={backendReady ? 'Сервер запущено' : "З'єднання..."}>
        <div className={`w-2 h-2 rounded-full ${backendReady ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
      </div>

      {/* Profile avatar */}
      <button
        onClick={() => setShowProfileModal(true)}
        title={activeProfile ? `${activeProfile.name} — ${activeProfile.role}` : 'Створити профіль'}
        className="w-[30px] h-[30px] rounded-full flex items-center justify-center text-[10px] font-extrabold text-white cursor-pointer no-drag transition-transform hover:scale-105 overflow-hidden"
        style={{ background: activeProfile ? activeProfile.color : 'linear-gradient(140deg,#38383F,#221F22)' }}
      >
        {activeProfile?.avatar_url && !avatarFailed ? (
          <img
            src={activeProfile.avatar_url}
            alt={activeProfile.name}
            onError={() => setAvatarFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : activeProfile ? (
          initials(activeProfile.name)
        ) : (
          '+'
        )}
      </button>

      {showProfileModal && <ProfileModal onClose={() => setShowProfileModal(false)} />}

      {appVersion && (
        <div
          className="mt-2 text-[9px] text-rh-muted/50 select-none no-drag"
          title={`RaccoonHouse Studio v${appVersion}`}
        >
          v{appVersion}
        </div>
      )}
    </aside>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

interface SidebarIconProps {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}
function SidebarIcon({ active, onClick, title, children }: SidebarIconProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors
        ${active
          ? 'bg-rh-accent/20 text-rh-accent'
          : 'text-rh-muted hover:text-rh-text hover:bg-white/5'
        }`}
    >
      {children}
    </button>
  )
}
