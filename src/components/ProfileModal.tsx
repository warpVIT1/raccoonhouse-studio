import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { Spinner } from './ui/Spinner'
import type { Profile } from '../types'

const COLORS = ['#E52128', '#3B82F6', '#A855F7', '#22C55E', '#EC4899', '#F59E0B']

interface ProfileModalProps {
  onClose: () => void
}
export function ProfileModal({ onClose }: ProfileModalProps) {
  const { get, post, del } = useApi()
  const activeProfile = useAppStore((s) => s.activeProfile)
  const setActiveProfile = useAppStore((s) => s.setActiveProfile)

  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState('Звукорежисер')
  const [color, setColor] = useState(COLORS[0])

  useEffect(() => {
    get<Profile[]>('/profiles').then(setProfiles).catch(() => {}).finally(() => setLoading(false))
  }, [get])

  async function activate(profile: Profile) {
    try {
      const updated = await post<Profile>(`/profiles/${profile.id}/activate`)
      setActiveProfile(updated)
      onClose()
    } catch {
      // ignore
    }
  }

  async function createProfile() {
    if (!name.trim()) return
    try {
      const created = await post<Profile>('/profiles', { name: name.trim(), role: role.trim() || 'Звукорежисер', color })
      setProfiles((prev) => [...prev, created])
      await activate(created)
    } catch {
      // ignore
    }
  }

  async function removeProfile(id: number) {
    try {
      await del(`/profiles/${id}`)
      setProfiles((prev) => prev.filter((p) => p.id !== id))
      if (activeProfile?.id === id) setActiveProfile(null)
    } catch {
      // ignore
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="rh-card w-[380px] p-6 flex flex-col gap-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Профіль</h2>

        {loading ? (
          <div className="flex justify-center py-6"><Spinner size={20} className="text-rh-accent" /></div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
            {profiles.length === 0 && (
              <div className="text-xs text-rh-muted">Ще немає жодного профілю — створіть перший нижче.</div>
            )}
            {profiles.map((p) => (
              <div
                key={p.id}
                className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors
                  ${activeProfile?.id === p.id ? 'border-rh-accent bg-rh-accent/5' : 'border-rh-border hover:border-rh-border2'}`}
                onClick={() => activate(p)}
              >
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-extrabold text-white flex-shrink-0"
                  style={{ background: p.color }}
                >
                  {p.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{p.name}</div>
                  <div className="text-[10.5px] text-rh-muted truncate">{p.role}</div>
                </div>
                {activeProfile?.id === p.id && <span className="text-[10px] text-rh-accent flex-shrink-0">активний</span>}
                <button
                  onClick={(e) => { e.stopPropagation(); removeProfile(p.id) }}
                  className="text-rh-muted hover:text-red-400 text-xs flex-shrink-0 px-1"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-rh-border pt-3.5 flex flex-col gap-2.5">
          {creating ? (
            <>
              <input className="rh-input w-full" placeholder="Ім'я" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              <input className="rh-input w-full" placeholder="Роль (напр. Звукорежисер)" value={role} onChange={(e) => setRole(e.target.value)} />
              <div className="flex gap-1.5">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full flex-shrink-0 ${color === c ? 'ring-2 ring-white' : ''}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setCreating(false)} className="rh-btn-ghost">Скасувати</button>
                <button onClick={createProfile} className="rh-btn-primary" disabled={!name.trim()}>Створити</button>
              </div>
            </>
          ) : (
            <button onClick={() => setCreating(true)} className="rh-btn-outline w-full">+ Новий профіль</button>
          )}
        </div>
      </div>
    </div>
  )
}
