import React, { useEffect, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { Spinner } from './ui/Spinner'
import { RolePicker, roleLabels as roleLabelsFor } from './ui/RolePicker'
import type { Profile, RoleCatalogItem } from '../types'

const COLORS = ['#E52128', '#3B82F6', '#A855F7', '#22C55E', '#EC4899', '#F59E0B']

function extractApiError(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  const match = e.message.match(/\{.*\}$/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (typeof parsed.detail === 'string') return parsed.detail
    } catch {
      /* not JSON — fall through to the raw message */
    }
  }
  return e.message
}

interface ProfileModalProps {
  onClose: () => void
}
export function ProfileModal({ onClose }: ProfileModalProps) {
  const backdrop = useBackdropClose(onClose)
  const { get, post, put, del } = useApi()
  const activeProfile = useAppStore((s) => s.activeProfile)
  const setActiveProfile = useAppStore((s) => s.setActiveProfile)

  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  // Telegram avatar_url always points at our own proxy (see Worker's
  // /telegram-avatar/:id) even for a profile with no photo set at all —
  // that 404s, so this falls back to the usual color-initials badge
  // instead of a broken <img>.
  const [failedAvatarIds, setFailedAvatarIds] = useState<Set<number>>(new Set())
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState('Звукорежисер')
  const [color, setColor] = useState(COLORS[0])
  // Optional, per-profile — distinct from adminPassword below (that one
  // unlocks the app-wide admin flag; this one just gates who on a shared PC
  // can click into THIS profile at all). See backend Profile.password_hash.
  const [newProfilePassword, setNewProfilePassword] = useState('')

  // Set when clicking a password-protected profile that isn't already
  // active — shows an inline prompt on that row instead of activating right away.
  const [pendingActivate, setPendingActivate] = useState<Profile | null>(null)
  const [activatePassword, setActivatePassword] = useState('')
  const [activateError, setActivateError] = useState<string | null>(null)

  // Typing exactly "admin" as the role is a deliberately unadvertised trigger
  // for the password prompt below (see backend/routers/settings.py's
  // verify-admin-password endpoint) — a convenience gate for a closed
  // trusted circle, not real security. On success, is_admin=true is set on
  // THIS profile only (see Profile.is_admin's comment) — switching to a
  // different profile hides admin-only features again.
  const isAdminRole = role.trim().toLowerCase() === 'admin'
  const [adminPassword, setAdminPassword] = useState('')
  const [adminError, setAdminError] = useState<string | null>(null)
  const [adminBusy, setAdminBusy] = useState(false)

  // Job-title roles — the actual "what does this person do" list, distinct
  // from the legacy `role` text field above (which stays purely the
  // admin-unlock trigger). Picking happens BEFORE logging in (Telegram or
  // manual), not as a separate edit step afterward — see the <RolePicker>
  // usages below and loginWithTelegram. The catalog itself (for rendering
  // roleLabels next to each profile row below) is fetched separately from
  // the shared <RolePicker>'s own internal fetch, since that component
  // only exposes the picking UI, not the raw list.
  const [roleCatalog, setRoleCatalog] = useState<RoleCatalogItem[]>([])
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])

  useEffect(() => {
    get<Profile[]>('/profiles').then(setProfiles).catch(() => {}).finally(() => setLoading(false))
    get<RoleCatalogItem[]>('/role-catalog').then(setRoleCatalog).catch(() => {})
  }, [get])

  function roleLabels(keys: string[] | null | undefined): string {
    return roleLabelsFor(keys, roleCatalog)
  }

  // Telegram login — a bot deep-link (t.me/<bot>?start=<code>, see
  // electron/main.ts's telegram-login:open) opened directly via the OS,
  // not an embedded window: it hands off to the person's own already-
  // logged-in Telegram, so there's no phone number/code to type here at
  // all. Polls this backend for the result the same "device code" shape as
  // any other background job in this app. cancelledRef guards against
  // setting state after the modal itself has closed mid-poll (e.g. the
  // person picked a different profile the normal way while still on Telegram).
  const [telegramBusy, setTelegramBusy] = useState(false)
  const [telegramError, setTelegramError] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])

  async function loginWithTelegram() {
    setTelegramBusy(true)
    setTelegramError(null)
    try {
      const { code } = await post<{ code: string }>('/profiles/telegram-login/start', {})
      await window.electronAPI?.openTelegramLogin(code)

      const deadline = Date.now() + 5 * 60 * 1000 // 5 min — generous, matches the Worker's own 10-minute code expiry with room to spare
      while (Date.now() < deadline) {
        if (cancelledRef.current) return
        await new Promise((r) => setTimeout(r, 2000))
        // roles is only actually applied server-side the moment a brand
        // NEW profile gets created (see routers/profiles.py) — picked
        // here, before the person even leaves this dialog, rather than as
        // a separate edit step afterward.
        const rolesParam = selectedRoles.length ? `&roles=${encodeURIComponent(selectedRoles.join(','))}` : ''
        const result = await get<{ status: string; profile?: Profile }>(`/profiles/telegram-login/poll?code=${encodeURIComponent(code)}${rolesParam}`)
        if (result.status === 'done' && result.profile) {
          if (!cancelledRef.current) {
            setActiveProfile(result.profile)
            onClose()
          }
          return
        }
      }
      if (!cancelledRef.current) setTelegramError('Час на вхід через Telegram вичерпано — спробуйте ще раз')
    } catch (e) {
      if (!cancelledRef.current) setTelegramError(extractApiError(e, 'Не вдалося увійти через Telegram'))
    } finally {
      if (!cancelledRef.current) setTelegramBusy(false)
    }
  }

  async function activate(profile: Profile, password?: string) {
    if (profile.has_password && activeProfile?.id !== profile.id && password === undefined) {
      setPendingActivate(profile)
      setActivatePassword('')
      setActivateError(null)
      return
    }
    try {
      const updated = await post<Profile>(`/profiles/${profile.id}/activate`, password ? { password } : {})
      setActiveProfile(updated)
      setPendingActivate(null)
      onClose()
    } catch (e) {
      if (pendingActivate) setActivateError(extractApiError(e, 'Невірний пароль'))
    }
  }

  async function createProfile() {
    if (!name.trim()) return
    if (isAdminRole) {
      setAdminBusy(true)
      setAdminError(null)
      try {
        await post('/settings/verify-admin-password', { password: adminPassword })
      } catch (e) {
        setAdminError(extractApiError(e, 'Невірний пароль'))
        setAdminBusy(false)
        return
      }
      setAdminBusy(false)
    }
    try {
      const created = await post<Profile>('/profiles', {
        name: name.trim(), role: role.trim() || 'Звукорежисер', roles: selectedRoles, color, is_admin: isAdminRole,
        password: newProfilePassword || undefined,
      })
      setProfiles((prev) => [...prev, created])
      await activate(created)
    } catch {
      // ignore
    }
  }

  // Only rendered when the currently active profile is itself admin (see
  // Profile.is_admin's comment) — lets an admin promote/demote OTHER
  // profiles without each one having to go through the "type admin as your
  // role + password" flow separately. PUT overwrites every field on the
  // target profile (see routers/profiles.py's update_profile), so the
  // current name/role/color are sent back unchanged alongside the flipped
  // is_admin — never just is_admin alone.
  async function toggleAdmin(p: Profile) {
    try {
      const updated = await put<Profile>(`/profiles/${p.id}`, {
        name: p.name, role: p.role, roles: p.roles, color: p.color, is_admin: !p.is_admin,
      })
      setProfiles((prev) => prev.map((x) => (x.id === p.id ? updated : x)))
      if (activeProfile?.id === p.id) setActiveProfile(updated)
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" {...backdrop}>
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
                className={`flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors
                  ${activeProfile?.id === p.id ? 'border-rh-accent bg-rh-accent/5' : 'border-rh-border hover:border-rh-border2'}`}
                onClick={() => activate(p)}
              >
                <div className="flex items-center gap-2.5">
                  {p.avatar_url && !failedAvatarIds.has(p.id) ? (
                    <img
                      src={p.avatar_url}
                      alt={p.name}
                      onError={() => setFailedAvatarIds((prev) => new Set(prev).add(p.id))}
                      className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <span
                      className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-extrabold text-white flex-shrink-0"
                      style={{ background: p.color }}
                    >
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate flex items-center gap-1.5">
                      {p.name}
                      {p.is_admin && (
                        <span className="text-[9px] font-bold uppercase tracking-wide text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded px-1 py-0.5">
                          admin
                        </span>
                      )}
                      {p.has_password && (
                        <span className="text-[9px] text-rh-muted" title="Профіль захищено паролем">🔒</span>
                      )}
                    </div>
                    {roleLabels(p.roles) && (
                    <div className="text-[10.5px] text-rh-muted truncate">{roleLabels(p.roles)}</div>
                  )}
                  </div>
                  {activeProfile?.id === p.id && <span className="text-[10px] text-rh-accent flex-shrink-0">активний</span>}
                  {activeProfile?.is_admin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleAdmin(p) }}
                      className="text-[10px] font-semibold text-amber-400/80 hover:text-amber-300 flex-shrink-0 px-1"
                      title={p.is_admin ? 'Забрати права адміна' : 'Зробити адміном'}
                    >
                      {p.is_admin ? '−admin' : '+admin'}
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); removeProfile(p.id) }}
                    className="text-rh-muted hover:text-red-400 text-xs flex-shrink-0 px-1"
                  >
                    ✕
                  </button>
                </div>
                {pendingActivate?.id === p.id && (
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="password"
                      autoFocus
                      className="rh-input flex-1 text-xs py-1"
                      placeholder="Пароль профілю"
                      value={activatePassword}
                      onChange={(e) => { setActivatePassword(e.target.value); setActivateError(null) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') activate(p, activatePassword) }}
                    />
                    <button
                      onClick={() => activate(p, activatePassword)}
                      className="rh-btn-primary text-[11px] px-2 py-1"
                      disabled={!activatePassword}
                    >
                      Увійти
                    </button>
                  </div>
                )}
                {pendingActivate?.id === p.id && activateError && (
                  <span className="text-[11px] text-[#FF6B70]">{activateError}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-rh-border pt-3.5 flex flex-col gap-2.5">
          {creating ? (
            <>
              <input className="rh-input w-full" placeholder="Ім'я" value={name} onChange={(e) => setName(e.target.value)} autoFocus />

              <RolePicker selected={selectedRoles} onChange={setSelectedRoles} isAdmin={!!activeProfile?.is_admin} />

              <input
                className="rh-input w-full"
                placeholder="Роль (напр. Звукорежисер)"
                value={role}
                onChange={(e) => { setRole(e.target.value); setAdminError(null) }}
              />
              {isAdminRole && (
                <input
                  type="password"
                  className="rh-input w-full"
                  placeholder="Пароль"
                  value={adminPassword}
                  onChange={(e) => { setAdminPassword(e.target.value); setAdminError(null) }}
                />
              )}
              {adminError && <span className="text-[11px] text-[#FF6B70]">{adminError}</span>}
              <input
                type="password"
                className="rh-input w-full"
                placeholder="Пароль профілю (необов'язково)"
                value={newProfilePassword}
                onChange={(e) => setNewProfilePassword(e.target.value)}
              />
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
                <button
                  onClick={createProfile}
                  className="rh-btn-primary"
                  disabled={!name.trim() || adminBusy || (isAdminRole && !adminPassword)}
                >
                  {adminBusy ? <Spinner size={12} /> : null}
                  Створити
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-[10.5px] text-rh-muted -mb-1">Ваша роль у студії</span>
              <RolePicker selected={selectedRoles} onChange={setSelectedRoles} isAdmin={!!activeProfile?.is_admin} />
              <button
                onClick={loginWithTelegram}
                disabled={telegramBusy}
                className="rh-btn-primary w-full flex items-center justify-center gap-2"
              >
                {telegramBusy ? <Spinner size={12} /> : null}
                Увійти через Telegram
              </button>
              {telegramError && <span className="text-[11px] text-[#FF6B70]">{telegramError}</span>}
              <div className="flex items-center gap-2 text-[10.5px] text-rh-muted">
                <div className="flex-1 h-px bg-rh-border" />
                або
                <div className="flex-1 h-px bg-rh-border" />
              </div>
              <button onClick={() => setCreating(true)} className="rh-btn-outline w-full">+ Новий профіль вручну</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
