import React, { useState, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { ProfileModal } from '../ProfileModal'
import logoUrl from '../../assets/logo.png'

interface SidebarProps {
  view: 'titles' | 'title' | 'episode' | 'settings'
  onNavigate: (view: 'titles' | 'settings') => void
}

export function Sidebar({ view, onNavigate }: SidebarProps) {
  const backendReady = useAppStore((s) => s.backendReady)
  const activeProfile = useAppStore((s) => s.activeProfile)
  const isLibraryArea = view === 'titles' || view === 'title' || view === 'episode'
  const [showProfileModal, setShowProfileModal] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.electronAPI?.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

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
        className="w-[30px] h-[30px] rounded-full flex items-center justify-center text-[10px] font-extrabold text-white cursor-pointer no-drag transition-transform hover:scale-105"
        style={{ background: activeProfile ? activeProfile.color : 'linear-gradient(140deg,#38383F,#221F22)' }}
      >
        {activeProfile ? initials(activeProfile.name) : '+'}
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
