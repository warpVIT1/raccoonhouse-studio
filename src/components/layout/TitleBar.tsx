import React from 'react'
import { useAppStore } from '../../stores/appStore'
import { Spinner } from '../ui/Spinner'
import logoUrl from '../../assets/logo.png'

interface TitleBarProps {
  title?: string
}

export function TitleBar({ title = 'RaccoonHouse Studio' }: TitleBarProps) {
  const activeJobs = useAppStore((s) => s.activeJobs)
  const runningJobs = [...activeJobs.values()].filter((j) => j.status === 'running')

  const isWin = window.electronAPI?.platform === 'win32'

  function minimize() { window.electronAPI?.minimize() }
  function maximize() { window.electronAPI?.maximize() }
  function close() { window.electronAPI?.close() }

  return (
    <header className="h-8 flex items-center bg-rh-bg border-b border-rh-border flex-shrink-0 drag-region pl-3">
      <img src={logoUrl} alt="" className="w-[18px] h-[18px] object-contain flex-shrink-0 mr-2" />

      {/* Title */}
      <span className="text-xs text-rh-muted font-medium tracking-wide">{title}</span>

      {/* Active jobs indicator */}
      {runningJobs.length > 0 && (
        <div className="ml-3 flex items-center gap-1.5 no-drag">
          <Spinner size={12} className="text-rh-accent" />
          <span className="text-xs text-rh-text-dim font-mono">
            {runningJobs[0].message || 'Обробка…'} {runningJobs[0].percent}%
          </span>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Window controls (Windows style) */}
      {isWin && (
        <div className="flex no-drag">
          <button
            onClick={minimize}
            className="w-12 h-8 flex items-center justify-center text-rh-muted hover:bg-white/10 hover:text-rh-text transition-colors"
          >
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button
            onClick={maximize}
            className="w-12 h-8 flex items-center justify-center text-rh-muted hover:bg-white/10 hover:text-rh-text transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor"/>
            </svg>
          </button>
          <button
            onClick={close}
            className="w-12 h-8 flex items-center justify-center text-rh-muted hover:bg-rh-accent hover:text-white transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <line x1="1" y1="1" x2="9" y2="9"/>
              <line x1="9" y1="1" x2="1" y2="9"/>
            </svg>
          </button>
        </div>
      )}
    </header>
  )
}
