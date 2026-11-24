import React from 'react'
import { useAppStore } from '../../stores/appStore'
import { resolveCharacterImage } from '../../lib/characterImage'
import type { Character } from '../../types'

interface RolePaletteProps {
  roles: Character[]
  unassignedCount: number
  autoAdvance: boolean
  onAutoAdvanceChange: (value: boolean) => void
  onAssign: (characterId: number | null) => void
}

// Quick role assignment for the director: pick lines (click / Ctrl / Shift),
// then press the role's number (1-9) or click its chip; 0 clears the role.
// With "Далі" on, a single-line assignment jumps to the next unassigned line,
// so a whole episode can be cast with the keyboard alone.
export function RolePalette({ roles, unassignedCount, autoAdvance, onAutoAdvanceChange, onAssign }: RolePaletteProps) {
  const backendPort = useAppStore((s) => s.backendPort)
  if (roles.length === 0) {
    return (
      <div className="px-3 py-1.5 border-b border-rh-border text-[11px] text-rh-muted flex-shrink-0">
        Ролей ще немає — зберіть їх з субтитрів або додайте на вкладці «Ролі».
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-rh-border bg-rh-card2 flex-shrink-0 overflow-x-auto">
      {roles.map((role, i) => (
        <button
          key={role.id}
          type="button"
          onClick={() => onAssign(role.id)}
          title={`${role.name} — клавіша ${i < 9 ? i + 1 : 'немає (клік)'}`}
          className="flex items-center gap-1.5 flex-shrink-0 rounded-full border border-rh-border bg-rh-bg hover:border-rh-accent pl-1 pr-2.5 py-0.5"
        >
          <span className="w-6 h-6 rounded-full overflow-hidden bg-rh-card flex items-center justify-center text-[10px] font-bold text-rh-muted flex-shrink-0">
            {role.image_url ? (
              <img src={resolveCharacterImage(role.image_url, backendPort) ?? ''} alt="" className="w-full h-full object-cover" />
            ) : (
              role.name.slice(0, 1).toUpperCase()
            )}
          </span>
          {i < 9 && (
            <kbd className="text-[9.5px] font-mono px-1 rounded bg-rh-card text-rh-muted">{i + 1}</kbd>
          )}
          <span className="text-[11.5px] font-medium whitespace-nowrap">{role.name}</span>
          <span className="text-[10px] text-rh-muted">{role.line_count}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => onAssign(null)}
        title="Прибрати роль — клавіша 0"
        className="flex-shrink-0 rounded-full border border-dashed border-rh-border px-2.5 py-1 text-[11px] text-rh-muted hover:text-white"
      >
        <kbd className="text-[9.5px] font-mono mr-1">0</kbd>без ролі
      </button>
      <label className="flex items-center gap-1 ml-auto flex-shrink-0 text-[11px] text-rh-muted cursor-pointer select-none">
        <input type="checkbox" checked={autoAdvance} onChange={(e) => onAutoAdvanceChange(e.target.checked)} />
        далі автоматично
      </label>
      <span className="flex-shrink-0 text-[11px] text-rh-muted">без ролі: {unassignedCount}</span>
    </div>
  )
}
