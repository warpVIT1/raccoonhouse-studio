import React, { useEffect, useState } from 'react'
import { useApi } from '../../hooks/useApi'
import type { RoleCatalogItem } from '../../types'

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

interface RolePickerProps {
  selected: string[]
  onChange: (roles: string[]) => void
  // Gates the "+ роль" / "✕" catalog-editing controls — same is_admin flag
  // as everywhere else in the app (ProfileModal's own admin-only edits,
  // Апекс's line-up, teams). Everyone can still PICK from the catalog,
  // only an admin can change what's IN it.
  isAdmin: boolean
  className?: string
}

// Shared by ProfileModal (pick roles before logging in) and SettingsPage
// (change your own roles later) — one fetch-the-catalog + toggle-chips +
// admin-only add/remove implementation instead of two copies drifting
// apart. Fully controlled on the "which roles are picked" axis (selected/
// onChange), but owns its own fetch of the catalog itself and the admin
// add/remove calls, since every consumer needs those identically.
export function RolePicker({ selected, onChange, isAdmin, className }: RolePickerProps) {
  const { get, post, del } = useApi()
  const [roleCatalog, setRoleCatalog] = useState<RoleCatalogItem[]>([])
  const [addingRole, setAddingRole] = useState(false)
  const [newRoleLabel, setNewRoleLabel] = useState('')
  const [roleCatalogError, setRoleCatalogError] = useState<string | null>(null)

  useEffect(() => {
    get<RoleCatalogItem[]>('/role-catalog').then(setRoleCatalog).catch(() => {})
  }, [get])

  function toggle(key: string) {
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key])
  }

  async function addRoleCatalogItem() {
    const label = newRoleLabel.trim()
    if (!label) return
    setRoleCatalogError(null)
    try {
      const created = await post<RoleCatalogItem>('/role-catalog', { key: label, label })
      setRoleCatalog((prev) => [...prev, created])
      setNewRoleLabel('')
      setAddingRole(false)
    } catch (e) {
      setRoleCatalogError(extractApiError(e, 'Не вдалося додати роль'))
    }
  }

  async function removeRoleCatalogItem(key: string) {
    try {
      await del(`/role-catalog/${key}`)
      setRoleCatalog((prev) => prev.filter((r) => r.key !== key))
      onChange(selected.filter((k) => k !== key))
    } catch {
      // ignore
    }
  }

  return (
    <div className={`flex flex-col gap-1.5 ${className || ''}`}>
      <div className="flex flex-wrap gap-1.5">
        {roleCatalog.map((r) => {
          const active = selected.includes(r.key)
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => toggle(r.key)}
              className={`group flex items-center gap-1 text-[11px] font-medium rounded-full px-2.5 py-1 border transition-colors
                ${active ? 'bg-rh-accent/15 border-rh-accent text-rh-accent' : 'border-rh-border text-rh-muted hover:border-rh-border2 hover:text-white'}`}
            >
              {r.label}
              {isAdmin && (
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); removeRoleCatalogItem(r.key) }}
                  className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                  title="Видалити роль зі списку"
                >
                  ✕
                </span>
              )}
            </button>
          )
        })}
        {isAdmin && !addingRole && (
          <button
            type="button"
            onClick={() => setAddingRole(true)}
            className="text-[11px] font-medium rounded-full px-2.5 py-1 border border-dashed border-rh-border text-rh-muted hover:text-white hover:border-rh-border2"
          >
            + роль
          </button>
        )}
      </div>
      {isAdmin && addingRole && (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            className="rh-input flex-1 text-xs py-1"
            placeholder="Назва нової ролі"
            value={newRoleLabel}
            onChange={(e) => setNewRoleLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addRoleCatalogItem() }}
          />
          <button onClick={addRoleCatalogItem} className="rh-btn-primary text-[11px] px-2 py-1" disabled={!newRoleLabel.trim()}>
            Додати
          </button>
          <button onClick={() => { setAddingRole(false); setNewRoleLabel('') }} className="rh-btn-ghost text-[11px] px-2 py-1">
            ✕
          </button>
        </div>
      )}
      {roleCatalogError && <span className="text-[11px] text-[#FF6B70]">{roleCatalogError}</span>}
    </div>
  )
}

// roleLabels/RoleCatalogItem lookups — used to render a read-only summary
// (e.g. next to a profile's name) without re-fetching the catalog.
export function roleLabels(keys: string[] | null | undefined, catalog: RoleCatalogItem[]): string {
  if (!keys || keys.length === 0) return ''
  return keys.map((k) => catalog.find((r) => r.key === k)?.label || k).join(', ')
}
