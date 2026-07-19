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

const MIN_ZOOM = 1
const MAX_ZOOM = 40

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
  // zoom=1 shows the whole episode; scrollOffset is the visible window's
  // start time (seconds) — both needed to know which slice of the (always
  // fixed-resolution) sample buffer to stretch across the canvas.
  const [zoom, setZoom] = useState(1)
  const [scrollOffset, setScrollOffset] = useState(0)

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocalStemPath, backendPort])

  const visibleDuration = duration > 0 ? duration / zoom : 0
  const maxScroll = Math.max(0, duration - visibleDuration)
  const clampedScroll = Math.min(Math.max(0, scrollOffset), maxScroll)

  // Keep the playhead on-screen while playing/zoomed — otherwise scrubbing
  // past the edge of a zoomed-in view would just run off with no feedback.
  useEffect(() => {
    if (zoom <= 1 || !duration) return
    if (currentTime < clampedScroll || currentTime > clampedScroll + visibleDuration) {
      setScrollOffset(Math.max(0, Math.min(maxScroll, currentTime - visibleDuration / 2)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime])

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
    if (!samples || samples.length === 0 || !duration) {
      const barCount = Math.floor(width / 3)
      for (let i = 0; i < barCount; i++) {
        const h = Math.random() * 0.3 * height * 0.5
        ctx.fillStyle = '#2A2A30'
        ctx.fillRect(i * 3, height / 2 - h, 2, h * 2)
      }
      return
    }

    const winStart = clampedScroll
    const winEnd = clampedScroll + (visibleDuration || duration)
    const startIdx = Math.floor((winStart / duration) * samples.length)
    const endIdx = Math.max(startIdx + 1, Math.ceil((winEnd / duration) * samples.length))
    const visibleSamples = endIdx - startIdx

    const midY = height / 2
    const barWidth = Math.max(1, width / visibleSamples)

    for (let i = startIdx; i < endIdx && i < samples.length; i++) {
      const amp = samples[i]
      const barH = amp * midY * 0.9
      const x = (i - startIdx) * barWidth
      const t = (i / samples.length) * duration
      const isPlayed = t < currentTime

      ctx.fillStyle = isPlayed ? '#E52128' : '#3A3A45'
      ctx.fillRect(x, midY - barH, Math.max(1, barWidth - 0.5), barH * 2)
    }

    // Draw playhead (only if it's within the visible window)
    if (currentTime >= winStart && currentTime <= winEnd) {
      const playX = ((currentTime - winStart) / (winEnd - winStart)) * width
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(playX, 0)
      ctx.lineTo(playX, height)
      ctx.stroke()
    }

    // Draw markers within the visible window
    for (const marker of markers) {
      if (marker.position_seconds < winStart || marker.position_seconds > winEnd) continue
      const mx = ((marker.position_seconds - winStart) / (winEnd - winStart)) * width
      const color = marker.color || (marker.confirmed ? '#4ADE80' : '#F59E0B')
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(mx, 0)
      ctx.lineTo(mx, height)
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = color
      ctx.font = '9px monospace'
      ctx.fillText(marker.reaper_name.substring(0, 8), mx + 2, 11)
    }
  }, [currentTime, duration, markers, clampedScroll, visibleDuration])

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
    const winEnd = clampedScroll + (visibleDuration || duration)
    onSeek(clampedScroll + ratio * (winEnd - clampedScroll))
  }

  // Ctrl/Cmd+wheel zooms (centered on the cursor's time position); plain
  // wheel scrolls horizontally through the zoomed-in window — the same
  // convention as Audacity/most DAWs.
  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!duration) return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const ratio = (e.clientX - rect.left) / rect.width
      const winEnd = clampedScroll + (visibleDuration || duration)
      const cursorTime = clampedScroll + ratio * (winEnd - clampedScroll)
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (e.deltaY < 0 ? 1.3 : 1 / 1.3)))
      const nextVisibleDuration = duration / nextZoom
      setZoom(nextZoom)
      setScrollOffset(Math.max(0, Math.min(duration - nextVisibleDuration, cursorTime - ratio * nextVisibleDuration)))
    } else if (zoom > 1) {
      e.preventDefault()
      const deltaSeconds = (e.deltaY / 100) * (visibleDuration * 0.2)
      setScrollOffset((prev) => Math.max(0, Math.min(maxScroll, prev + deltaSeconds)))
    }
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-[#0A0A0C] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-rh-border flex-shrink-0">
        <span className="text-xs text-rh-muted font-medium">Вокал (ізольований)</span>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-rh-text-dim">Завантаження…</span>}
          {!vocalStemPath && !loading && <span className="text-xs text-rh-muted">Стем не готовий</span>}
          {vocalStemPath && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}
                className="w-4 h-4 flex items-center justify-center text-rh-muted hover:text-rh-text text-xs leading-none"
                title="Зменшити"
              >
                −
              </button>
              <span className="text-[10px] text-rh-muted font-mono w-8 text-center">{zoom.toFixed(1)}x</span>
              <button
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}
                className="w-4 h-4 flex items-center justify-center text-rh-muted hover:text-rh-text text-xs leading-none"
                title="Збільшити"
              >
                +
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          onClick={handleClick}
          onWheel={handleWheel}
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
