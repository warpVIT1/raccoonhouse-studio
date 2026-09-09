import React, { useEffect } from 'react'
import { TitlesPage } from './components/TitlesPage'
import { TitlePage } from './components/TitlePage'
import { EpisodeRoleRouter } from './components/EpisodeRoleRouter'
import { SettingsPage } from './components/SettingsPage'
import { ModelBrowserPage } from './components/ModelBrowserPage'
import { TeamsPage } from './components/TeamsPage'
import { ContactPage } from './components/ContactPage'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { PowerShareConsentPopup } from './components/PowerShareConsentPopup'
import { PowerShareModelDownloadPopup } from './components/PowerShareModelDownloadPopup'
import { PowerShareLendingBanner } from './components/PowerShareLendingBanner'
import { PowerShareBorrowingBanner } from './components/PowerShareBorrowingBanner'
import { ForceUpdateBanner } from './components/ForceUpdateBanner'
import { TeamInviteBanner } from './components/TeamInviteBanner'
import { UpdateDialog } from './components/UpdateDialog'
import { BetaAvailableBanner } from './components/BetaAvailableBanner'
import { BackupRestoredBanner } from './components/BackupRestoredBanner'
import { useAppStore } from './stores/appStore'
import { useWebSocket } from './hooks/useWebSocket'
import { useApi } from './hooks/useApi'
import type { AppSettings } from './types'

export default function App() {
  const selectedTitleId = useAppStore((s) => s.selectedTitleId)
  const selectedEpisodeId = useAppStore((s) => s.selectedEpisodeId)
  const showSettings = useAppStore((s) => s.showSettings)
  const showModelBrowser = useAppStore((s) => s.showModelBrowser)
  const showTeams = useAppStore((s) => s.showTeams)
  const showContact = useAppStore((s) => s.showContact)
  const backendReady = useAppStore((s) => s.backendReady)
  const setBackendPort = useAppStore((s) => s.setBackendPort)
  const setSelectedTitle = useAppStore((s) => s.setSelectedTitle)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const setShowModelBrowser = useAppStore((s) => s.setShowModelBrowser)
  const setShowTeams = useAppStore((s) => s.setShowTeams)
  const setShowContact = useAppStore((s) => s.setShowContact)
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
    : showModelBrowser
    ? 'browser'
    : showTeams
    ? 'teams'
    : showContact
    ? 'contact'
    : selectedEpisodeId
    ? 'episode'
    : selectedTitleId
    ? 'title'
    : 'titles'

  const barTitle = currentView === 'settings'
    ? 'RaccoonHouse Studio — Налаштування'
    : currentView === 'browser'
    ? 'RaccoonHouse Studio — Браузер моделей'
    : currentView === 'teams'
    ? 'RaccoonHouse Studio — Команди'
    : currentView === 'contact'
    ? "RaccoonHouse Studio — Зв'язок з розробником"
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
              setShowModelBrowser(false)
              setSelectedTitle(null)
            } else if (v === 'settings') {
              setShowSettings(true)
            } else if (v === 'browser') {
              setShowModelBrowser(true)
            } else if (v === 'teams') {
              setShowTeams(true)
            } else if (v === 'contact') {
              setShowContact(true)
            }
          }}
        />
        <main className="flex-1 overflow-hidden">
          {currentView === 'settings' && <SettingsPage />}
          {currentView === 'browser' && <ModelBrowserPage />}
          {currentView === 'teams' && <TeamsPage />}
          {currentView === 'contact' && <ContactPage />}
          {currentView === 'titles' && <TitlesPage />}
          {currentView === 'title' && <TitlePage titleId={selectedTitleId!} />}
          {currentView === 'episode' && (
            <EpisodeRoleRouter
              episodeId={selectedEpisodeId!}
              titleId={selectedTitleId!}
            />
          )}
        </main>
      </div>
      <PowerShareConsentPopup />
      <PowerShareModelDownloadPopup />
      <PowerShareLendingBanner />
      <PowerShareBorrowingBanner />
      <ForceUpdateBanner />
      <TeamInviteBanner />
      <UpdateDialog />
      <BetaAvailableBanner />
      <BackupRestoredBanner />
    </div>
  )
}
