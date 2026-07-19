import React, { useRef, useEffect, useState, useCallback } from 'react'
import type { Marker } from '../../types'

interface WaveformViewerProps {
  vocalStemPath: string | null
  currentTime: number
  duration: number
  markers: Marker[]
  onSeek: (t: number) => void
  onMarkerClick: (marker: Marker) => void
  backendPort: number
}

export function WaveformViewer({
  vocalStemPath,
  currentTime,
  duration,
  markers,
  onSeek,
  onMarkerClick,
  backendPort,
}: WaveformViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const waveformData = useRef<Float32Array | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch downsampled waveform data from backend
  useEffect(() => {
    if (!vocalStemPath) return
    setLoading(true)
    fetch(`http://localhost:${backendPort}/api/waveform?path=${encodeURIComponent(vocalStemPath)}&samples=2000`)
      .then((r) => r.json())
      .then((data: { samples: number[] }) => {
        waveformData.current = new Float32Array(data.samples)
        drawWaveform()
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [vocalStemPath, backendPort])

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const width = container.clientWidth
    const height = container.clientHeight
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.scale(dpr, dpr)

    // Background
    ctx.fillStyle = '#0A0A0C'
    ctx.fillRect(0, 0, width, height)

    const samples = waveformData.current
    if (!samples || samples.length === 0) {
      // Draw placeholder bars
      const barCount = Math.floor(width / 3)
      for (let i = 0; i < barCount; i++) {
        const h = Math.random() * 0.3 * height * 0.5
        ctx.fillStyle = '#2A2A30'
        ctx.fillRect(i * 3, height / 2 - h, 2, h * 2)
      }
      return
    }

    const midY = height / 2
    const barWidth = Math.max(1, width / samples.length)

    // Draw waveform bars
    for (let i = 0; i < samples.length; i++) {
      const amp = samples[i]
      const barH = amp * midY * 0.9
      const x = i * barWidth
      const progressRatio = duration > 0 ? currentTime / duration : 0
      const isPlayed = i / samples.length < progressRatio

      ctx.fillStyle = isPlayed ? '#E52128' : '#3A3A45'
      ctx.fillRect(x, midY - barH, Math.max(1, barWidth - 0.5), barH * 2)
    }

    // Draw playhead
    if (duration > 0) {
      const playX = (currentTime / duration) * width
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(playX, 0)
      ctx.lineTo(playX, height)
      ctx.stroke()
    }

    // Draw markers
    for (const marker of markers) {
      if (!duration) continue
      const mx = (marker.position_seconds / duration) * width
      ctx.strokeStyle = marker.confirmed ? '#4ADE80' : '#F59E0B'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(mx, 0)
      ctx.lineTo(mx, height)
      ctx.stroke()
      ctx.setLineDash([])

      // Marker label
      ctx.fillStyle = marker.confirmed ? '#4ADE80' : '#F59E0B'
      ctx.font = '9px monospace'
      ctx.fillText(marker.reaper_name.substring(0, 8), mx + 2, 11)
    }
  }, [currentTime, duration, markers])

  useEffect(() => {
    drawWaveform()
  }, [drawWaveform])

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => drawWaveform())
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [drawWaveform])

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ratio = x / rect.width
    onSeek(ratio * duration)
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-[#0A0A0C] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-rh-border flex-shrink-0">
        <span className="text-xs text-rh-muted font-medium">Вокал (ізольований)</span>
        {loading && (
          <span className="text-xs text-rh-text-dim">Завантаження…</span>
        )}
        {!vocalStemPath && !loading && (
          <span className="text-xs text-rh-muted">Стем не готовий</span>
        )}
      </div>

      {/* Canvas */}
      <div className="flex-1 relative min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          onClick={handleClick}
        />
        {!vocalStemPath && (
          <div className="absolute inset-0 flex items-center justify-center text-rh-muted text-xs">
            Виконайте ізоляцію вокалу для відображення форми хвилі
          </div>
        )}
      </div>
    </div>
  )
}
