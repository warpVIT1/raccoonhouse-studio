import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'

interface BackupStatus {
  titles_restored: number
}

// One-off notice for the rare case where an update just ran and
// backup_service.restore_and_cleanup_backup (called synchronously during
// the backend's init_db(), before this app even loaded) brought back
// personal titles from a pre-update backup — see backend/services/
// backup_service.py and electron/main.ts's before-quit handler. Silent
// (no banner at all) on every normal launch, which is the overwhelming
// majority of the time.
export function BackupRestoredBanner() {
  const backendReady = useAppStore((s) => s.backendReady)
  const { get } = useApi()
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!backendReady) return
    get<BackupStatus>('/backup/status').then((s) => setCount(s.titles_restored || 0)).catch(() => {})
  }, [backendReady, get])

  if (count <= 0) return null

  return (
    <div className="fixed bottom-6 left-6 z-[90] w-72 rh-card p-3 shadow-2xl border border-rh-border flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs">💾</span>
        <span className="text-xs font-semibold text-rh-text">Відновлено після оновлення</span>
        <button onClick={() => setCount(0)} className="ml-auto text-rh-muted hover:text-white text-sm leading-none px-1">✕</button>
      </div>
      <p className="text-[11px] text-rh-muted leading-relaxed">
        {count === 1 ? 'Відновлено 1 особистий тайтл' : `Відновлено особистих тайтлів: ${count}`} із резервної копії, збереженої перед оновленням.
      </p>
    </div>
  )
}
