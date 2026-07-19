import React, { useEffect } from 'react'
import { TitlesPage } from './components/TitlesPage'
import { TitlePage } from './components/TitlePage'
import { EpisodeWorkspace } from './components/EpisodeWorkspace'
import { SettingsPage } from './components/SettingsPage'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { PowerShareConsentPopup } from './components/PowerShareConsentPopup'
import { PowerShareLendingBanner } from './components/PowerShareLendingBanner'
import { UpdateDialog } from './components/UpdateDialog'
import { useAppStore } from './stores/appStore'
import { useWebSocket } from './hooks/useWebSocket'
import { useApi } from './hooks/useApi'
import type { AppSettings } from './types'

export default function App() {
  const selectedTitleId = useAppStore((s) => s.selectedTitleId)
  const selectedEpisodeId = useAppStore((s) => s.selectedEpisodeId)
  const showSettings = useAppStore((s) => s.showSettings)
  const backendReady = useAppStore((s) => s.backendReady)
  const setBackendPort = useAppStore((s) => s.setBackendPort)
  const setSelectedTitle = useAppStore((s) => s.setSelectedTitle)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const setActiveProfile = useAppStore((s) => s.setActiveProfile)
  const { get } = useApi()

  // Initialize WebSocket connection to backend
  useWebSocket()

  // Get backend port from Electron
  useEffect(() => {
    if (window.electronAPI?.getBackendPort) {
      window.electronAPI.getBackendPort().then(setBackendPort).catch(() => {})
    }
  }, [setBackendPort])

  // Restore the active profile on launch
  useEffect(() => {
    if (!backendReady) return
    get<AppSettings>('/settings').then((s) => setActiveProfile(s.active_profile)).catch(() => {})
  }, [backendReady, get, setActiveProfile])

  const currentView = showSettings
    ? 'settings'
    : selectedEpisodeId
    ? 'episode'
    : selectedTitleId
    ? 'title'
    : 'titles'

  const barTitle = currentView === 'settings'
    ? 'RaccoonHouse Studio — Налаштування'
    : currentView === 'episode'
    ? 'RaccoonHouse Studio — Епізод'
    : currentView === 'title'
    ? 'RaccoonHouse Studio — Тайтл'
    : 'RaccoonHouse Studio'

  return (
    <div className="flex flex-col h-screen bg-rh-bg text-rh-text overflow-hidden">
      <TitleBar title={barTitle} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          view={currentView}
          onNavigate={(v) => {
            if (v === 'titles') {
              setShowSettings(false)
              setSelectedTitle(null)
            } else if (v === 'settings') {
              setShowSettings(true)
            }
          }}
        />
        <main className="flex-1 overflow-hidden">
          {currentView === 'settings' && <SettingsPage />}
          {currentView === 'titles' && <TitlesPage />}
          {currentView === 'title' && <TitlePage titleId={selectedTitleId!} />}
          {currentView === 'episode' && (
            <EpisodeWorkspace
              episodeId={selectedEpisodeId!}
              titleId={selectedTitleId!}
            />
          )}
        </main>
      </div>
      <PowerShareConsentPopup />
      <PowerShareLendingBanner />
      <UpdateDialog />
    </div>
  )
}
