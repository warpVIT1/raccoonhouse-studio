import React from 'react'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: React.ReactNode
  hint?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
}

// Shared pill-style switch — used everywhere a plain <input type="checkbox">
// would otherwise render as a bare OS checkbox square.
export function Toggle({ checked, onChange, label, hint, disabled, size = 'md', className = '' }: ToggleProps) {
  const track = size === 'sm' ? 'w-8 h-[18px]' : 'w-9 h-5'
  const knob = size === 'sm' ? 'w-[14px] h-[14px]' : 'w-4 h-4'
  const knobTranslate = size === 'sm' ? 'peer-checked:translate-x-[14px]' : 'peer-checked:translate-x-4'

  return (
    <label className={`flex items-center gap-2.5 select-none ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} ${className}`}>
      <span className="relative inline-flex items-center flex-shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only peer"
        />
        <span className={`${track} bg-rh-border rounded-full peer-checked:bg-rh-accent transition-colors`} />
        <span className={`absolute left-0.5 top-0.5 ${knob} bg-white rounded-full shadow transition-transform ${knobTranslate}`} />
      </span>
      {(label || hint) && (
        <span className="flex flex-col gap-0.5">
          {label && <span className="text-xs text-rh-text-dim leading-snug">{label}</span>}
          {hint && <span className="text-[10.5px] text-rh-muted leading-snug">{hint}</span>}
        </span>
      )}
    </label>
  )
}
