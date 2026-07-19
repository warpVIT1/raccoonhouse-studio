import React from 'react'

interface ProgressBarProps {
  percent: number
  className?: string
  color?: string
}
export function ProgressBar({ percent, className = '', color = 'bg-rh-accent' }: ProgressBarProps) {
  return (
    <div className={`h-0.5 bg-rh-border rounded-full overflow-hidden ${className}`}>
      <div
        className={`h-full ${color} rounded-full transition-all duration-300`}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  )
}
