import React, { useRef, useEffect, useState, useCallback } from 'react'
import type { Marker, SubtitleLine } from '../../types'

interface WaveformViewerProps {
  audioPath: string | null
  currentTime: number
  duration: number
  markers: Marker[]
  onSeek: (t: number) => void
  onMarkerClick: (marker: Marker) => void
  backendPort: number
  // EpisodeWorkspace feeds this a vocal stem, TranslatorWorkspace the raw
  // episode video (see get_waveform_samples' ffmpeg fallback) — the header
  // copy differs accordingly, so the caller supplies it instead of this
  // component assuming "audio" always means "isolated stem".
  label?: string
  emptyMessage?: string
  // Aegisub-style visual timing — drag a line's edges/body directly on the
  // waveform. `lines`/`activeIndex` mirror SubtitleGrid's own props exactly
  // (same array, same index space) so callers pass the identical state to
  // both without translation.
  lines: SubtitleLine[]
  activeIndex: number | null
  onLineTimingChange: (index: number, changes: { start_ms?: number; end_ms?: number }) => void
  onLineActivate?: (index: number) => void
}

const MIN_ZOOM = 1
const MAX_ZOOM = 40
// Timecode ruler strip height, in CSS pixels — reserved at the top of the
// canvas, matching Aegisub's own audio-display ruler.
const RULER_H = 16
// Edge-grab tolerance, in CSS pixels — how close a mousedown needs to land
// to a line's start/end to resize it instead of moving/seeking.
const EDGE_HIT_PX = 6
// Backend enforces no start<end (or minimum-duration) constraint at all on
// SubtitleLineUpdate — this client-side floor is the only thing stopping a
// drag from collapsing or inverting a line.
const MIN_LINE_DURATION_MS = 100

type DragMode =
  | { kind: 'seek' }
  | { kind: 'resize-start' | 'resize-end'; lineIndex: number; origStartMs: number; origEndMs: number }
  | { kind: 'move'; lineIndex: number; origStartMs: number; origEndMs: number; grabOffsetMs: number }
  // A plain (non-Alt) click landing inside an INACTIVE line's body — Aegisub
  // doesn't let a plain drag move/retime a line that isn't the active one;
  // it just selects it, same as clicking its row in the grid. No drag
  // feedback while held, just an activation on release.
  | { kind: 'activate-line'; lineIndex: number }

type HoverInfo = { lineIndex: number; edge: 'start' | 'end' | 'move' }

export function WaveformViewer({
  audioPath,
  currentTime,
  duration,
  markers,
  onSeek,
  onMarkerClick,
  backendPort,
  label = 'Аудіо',
  emptyMessage = 'Аудіо недоступне',
  lines,
  activeIndex,
  onLineTimingChange,
  onLineActivate,
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

  // Drag state lives in refs, not React state — mirrors EpisodeWorkspace's
  // own resizingRef/window-listener pattern (see startVideoResize): avoids
  // stale closures and a re-render on every single mousemove while dragging.
  // previewRef holds in-progress (uncommitted) start/end for whichever line
  // is being dragged, read by drawWaveform for instant visual feedback —
  // onLineTimingChange (the actual PUT-triggering commit) only fires once,
  // on mouseup, not on every intermediate position.
  const dragRef = useRef<DragMode | null>(null)
  const dragMovedRef = useRef(false)
  const previewRef = useRef<Map<number, { start_ms: number; end_ms: number }>>(new Map())
  const [hover, setHover] = useState<HoverInfo | null>(null)

  // Fetch downsampled waveform data from backend
  useEffect(() => {
    if (!audioPath) return
    setLoading(true)
    fetch(`http://localhost:${backendPort}/api/waveform?path=${encodeURIComponent(audioPath)}&samples=2000`)
      .then((r) => r.json())
      .then((data: { samples: number[] }) => {
        waveformData.current = new Float32Array(data.samples)
        drawWaveform()
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPath, backendPort])

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

  // Effective (preview-aware) start/end for a line, in seconds — reads the
  // in-progress drag position when one exists, else the committed value.
  const effectiveRangeSec = useCallback((index: number): [number, number] => {
    const line = lines[index]
    const preview = previewRef.current.get(index)
    const startMs = preview?.start_ms ?? line.start_ms
    const endMs = preview?.end_ms ?? line.end_ms
    return [startMs / 1000, endMs / 1000]
  }, [lines])

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

    if (!duration) {
      const barCount = Math.floor(width / 3)
      for (let i = 0; i < barCount; i++) {
        const h = Math.random() * 0.3 * height * 0.5
        ctx.fillStyle = '#2A2A30'
        ctx.fillRect(i * 3, RULER_H + height / 2 - h, 2, h * 2)
      }
      return
    }

    const winStart = clampedScroll
    const winEnd = clampedScroll + (visibleDuration || duration)
    // Everything below the ruler strip works in this reduced coordinate
    // space — contentTop/contentHeight, not the raw canvas height — so the
    // ruler doesn't eat into the waveform/spans/playhead's own drawing area.
    const contentTop = RULER_H
    const contentHeight = Math.max(1, height - RULER_H)

    // Ruler — tick marks + timecodes along the top, same role as Aegisub's
    // own audio-display ruler. "Nice" interval chosen so labels land roughly
    // every ~70px regardless of zoom, rather than a fixed step that's either
    // unreadably dense when zoomed in or sparse when zoomed out.
    ctx.fillStyle = '#141418'
    ctx.fillRect(0, 0, width, RULER_H)
    const pxPerSec = width / (winEnd - winStart)
    const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]
    const step = niceSteps.find((s) => s * pxPerSec >= 70) ?? niceSteps[niceSteps.length - 1]
    const firstTick = Math.ceil(winStart / step) * step
    ctx.strokeStyle = '#3A3A45'
    ctx.fillStyle = '#8A8A95'
    ctx.font = '9px monospace'
    ctx.lineWidth = 1
    for (let t = firstTick; t <= winEnd; t += step) {
      const x = ((t - winStart) / (winEnd - winStart)) * width
      ctx.beginPath()
      ctx.moveTo(x, RULER_H - 5)
      ctx.lineTo(x, RULER_H)
      ctx.stroke()
      const m = Math.floor(t / 60)
      const s = t % 60
      const label = t >= 3600
        ? `${Math.floor(t / 3600)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`
        : `${m}:${String(Math.floor(s)).padStart(2, '0')}`
      ctx.fillText(label, x + 2, RULER_H - 6)
    }

    // Subtitle-line spans — drawn first (behind the waveform shape itself)
    // so the amplitude bars stay legible on top of them. Iterated in array
    // order so a later (higher) index paints over an earlier one where two
    // overlapping (`is_overlap`) lines share a time range — matches the
    // same "last wins" order hitTestAt below uses for picking one to drag.
    for (let i = 0; i < lines.length; i++) {
      const [startS, endS] = effectiveRangeSec(i)
      if (endS < winStart || startS > winEnd) continue
      const x1 = ((startS - winStart) / (winEnd - winStart)) * width
      const x2 = ((endS - winStart) / (winEnd - winStart)) * width
      const isActive = i === activeIndex
      const base = lines[i].is_overlap ? '139, 92, 246' : '229, 33, 40' // violet-500 / rh-accent
      ctx.fillStyle = `rgba(${base}, ${isActive ? 0.30 : 0.13})`
      ctx.fillRect(x1, contentTop, Math.max(1, x2 - x1), contentHeight)
    }

    // Computed once, here, and reused for BOTH the bars' played/unplayed
    // split below AND the playhead line drawn later — comparing pixel
    // positions (`x < playX`) instead of each bar independently re-deriving
    // a time (`t = i/samples.length*duration`) and comparing that to
    // `currentTime`. The two are mathematically equivalent at zoom 1, but a
    // real, reproducible drift between the red/gray split and the actual
    // white playhead line showed up live (confirmed 2026-08-16, screenshot:
    // red extending a good ~15s past the line) that this rules out by
    // construction — whatever caused it, "played" now literally means
    // "left of the same playX the line itself is drawn at," not "happens to
    // compute to the same pixel via a different formula."
    const playX = currentTime >= winStart && currentTime <= winEnd
      ? ((currentTime - winStart) / (winEnd - winStart)) * width
      : null

    const samples = waveformData.current
    if (!samples || samples.length === 0) {
      const barCount = Math.floor(width / 3)
      for (let i = 0; i < barCount; i++) {
        const h = Math.random() * 0.3 * contentHeight * 0.5
        ctx.fillStyle = '#2A2A30'
        ctx.fillRect(i * 3, contentTop + contentHeight / 2 - h, 2, h * 2)
      }
    } else {
      const startIdx = Math.floor((winStart / duration) * samples.length)
      const endIdx = Math.max(startIdx + 1, Math.ceil((winEnd / duration) * samples.length))
      const visibleSamples = endIdx - startIdx

      const midY = contentTop + contentHeight / 2
      // Position and draw-width are DELIBERATELY separate. `rawBarWidth` is
      // the true, unclamped per-sample pixel spacing (2000 samples over a
      // panel usually well under 2000px wide, so this is normally sub-1px)
      // and is what `x` must be computed from — using a clamped-up width
      // for positioning too (as this used to) accumulates real drift as `i`
      // grows: each bar lands a fraction of a pixel further right than its
      // true time-proportional spot, adding up over 2000 samples into a
      // waveform shape visibly stretched rightward relative to the actual
      // timeline (confirmed live 2026-08-16 — red "played" coloring, and by
      // extension the whole waveform's horizontal shape, drifted well past
      // the actual playhead by the time-axis's higher end). `drawWidth`
      // only controls how many pixels wide each bar is painted — clamping
      // *that* to a visible minimum is fine and doesn't move anything.
      const rawBarWidth = width / visibleSamples
      const drawWidth = Math.max(1, rawBarWidth - 0.5)

      for (let i = startIdx; i < endIdx && i < samples.length; i++) {
        const amp = samples[i]
        // Clamped to half the content height regardless of how large amp
        // is — without this, a sample value at or past 1.0 (seen live: a
        // hot/clipped passage) drew bars taller than the canvas itself,
        // spilling the red peaks out past the container's own border.
        const barH = Math.min(contentHeight / 2, amp * (contentHeight / 2) * 0.9)
        const x = (i - startIdx) * rawBarWidth
        const isPlayed = playX != null && x + rawBarWidth / 2 < playX

        ctx.fillStyle = isPlayed ? '#E52128' : '#3A3A45'
        ctx.fillRect(x, midY - barH, drawWidth, barH * 2)
      }
    }

    // Edge handles — only for the line currently hovered or being dragged,
    // so every line isn't cluttered with handles at once.
    const highlightIndex = dragRef.current && dragRef.current.kind !== 'seek'
      ? dragRef.current.lineIndex
      : hover?.lineIndex
    if (highlightIndex != null && lines[highlightIndex]) {
      const [startS, endS] = effectiveRangeSec(highlightIndex)
      if (endS >= winStart && startS <= winEnd) {
        const x1 = ((startS - winStart) / (winEnd - winStart)) * width
        const x2 = ((endS - winStart) / (winEnd - winStart)) * width
        ctx.strokeStyle = '#F5F5F7'
        ctx.lineWidth = 2
        for (const x of [x1, x2]) {
          ctx.beginPath()
          ctx.moveTo(x, contentTop)
          ctx.lineTo(x, contentTop + contentHeight)
          ctx.stroke()
        }
      }
    }

    // Draw playhead (only if it's within the visible window) — reuses the
    // exact same `playX` the bars above just split played/unplayed on.
    if (playX != null) {
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(playX, contentTop)
      ctx.lineTo(playX, contentTop + contentHeight)
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
      ctx.moveTo(mx, contentTop)
      ctx.lineTo(mx, contentTop + contentHeight)
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = color
      ctx.font = '9px monospace'
      ctx.fillText(marker.reaper_name.substring(0, 8), mx + 2, contentTop + 11)
    }
  }, [currentTime, duration, markers, clampedScroll, visibleDuration, lines, activeIndex, hover, effectiveRangeSec])

  useEffect(() => {
    drawWaveform()
  }, [drawWaveform])

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => drawWaveform())
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [drawWaveform])

  // Shared by mousedown (drag start) and the hover-only mousemove below —
  // same tolerance/order logic either way. Iterates from the last line to
  // the first so a later (topmost-drawn, see drawWaveform) line wins a hit
  // in an overlapping region, matching how the spans themselves are drawn.
  const hitTestAt = useCallback((x: number, width: number, winStart: number, winEnd: number): HoverInfo | null => {
    if (winEnd <= winStart) return null
    for (let i = lines.length - 1; i >= 0; i--) {
      const [startS, endS] = effectiveRangeSec(i)
      if (endS < winStart || startS > winEnd) continue
      const x1 = ((startS - winStart) / (winEnd - winStart)) * width
      const x2 = ((endS - winStart) / (winEnd - winStart)) * width
      if (Math.abs(x - x1) <= EDGE_HIT_PX) return { lineIndex: i, edge: 'start' }
      if (Math.abs(x - x2) <= EDGE_HIT_PX) return { lineIndex: i, edge: 'end' }
      if (x > x1 && x < x2) return { lineIndex: i, edge: 'move' }
    }
    return null
  }, [lines, effectiveRangeSec])

  function timeAtX(x: number, width: number, winStart: number, winEnd: number): number {
    return winStart + (x / width) * (winEnd - winStart)
  }

  // Gesture mapping matches Aegisub's AudioTimingControllerDialogue::
  // OnLeftClick (audio_timing_dialogue.cpp) rather than a generic "drag body
  // to move, drag edge to resize" model:
  //  - Alt+drag on a line (edge or body) moves it wholesale.
  //  - A plain drag near an edge of ANY visible line resizes that marker —
  //    a deliberate generalization: Aegisub only arms this for the ACTIVE
  //    line's own markers, but letting any visible edge be grabbed directly
  //    is strictly more discoverable and doesn't conflict with anything else.
  //  - A plain drag starting inside the ACTIVE line's own body resizes
  //    whichever marker (start or end) is closer in TIME to the click —
  //    Aegisub does this instead of moving the line; Alt is what moves it.
  //  - A plain click inside an INACTIVE line's body just selects it (no
  //    drag-retime for a line that isn't active — matches clicking its row).
  //  - A plain click in truly empty space, with a line active, snaps that
  //    line's START to the click and immediately starts dragging its END —
  //    Aegisub's "far from both markers" branch, the gesture for re-timing
  //    a line from scratch by ear without first finding its exact edge.
  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const width = rect.width
    const winStart = clampedScroll
    const winEnd = clampedScroll + (visibleDuration || duration)
    const x = e.clientX - rect.left

    dragMovedRef.current = false

    if (!duration) {
      dragRef.current = { kind: 'seek' }
    } else {
      const hit = hitTestAt(x, width, winStart, winEnd)
      const clickMs = Math.round(timeAtX(x, width, winStart, winEnd) * 1000)

      if (hit && e.altKey) {
        const [startS, endS] = effectiveRangeSec(hit.lineIndex)
        const origStartMs = Math.round(startS * 1000)
        const origEndMs = Math.round(endS * 1000)
        const grabMs = clickMs
        dragRef.current = { kind: 'move', lineIndex: hit.lineIndex, origStartMs, origEndMs, grabOffsetMs: grabMs - origStartMs }
      } else if (hit && hit.edge !== 'move') {
        const [startS, endS] = effectiveRangeSec(hit.lineIndex)
        dragRef.current = {
          kind: hit.edge === 'start' ? 'resize-start' : 'resize-end',
          lineIndex: hit.lineIndex,
          origStartMs: Math.round(startS * 1000),
          origEndMs: Math.round(endS * 1000),
        }
      } else if (hit && hit.lineIndex === activeIndex) {
        const [startS, endS] = effectiveRangeSec(activeIndex)
        const origStartMs = Math.round(startS * 1000)
        const origEndMs = Math.round(endS * 1000)
        const nearerStart = Math.abs(clickMs - origStartMs) <= Math.abs(clickMs - origEndMs)
        dragRef.current = { kind: nearerStart ? 'resize-start' : 'resize-end', lineIndex: activeIndex, origStartMs, origEndMs }
      } else if (hit) {
        dragRef.current = { kind: 'activate-line', lineIndex: hit.lineIndex }
      } else if (activeIndex != null) {
        const [, endS] = effectiveRangeSec(activeIndex)
        const origEndMs = Math.max(Math.round(endS * 1000), clickMs + MIN_LINE_DURATION_MS)
        previewRef.current.set(activeIndex, { start_ms: Math.max(0, clickMs), end_ms: origEndMs })
        dragMovedRef.current = true
        dragRef.current = { kind: 'resize-end', lineIndex: activeIndex, origStartMs: clickMs, origEndMs }
        drawWaveform()
      } else {
        dragRef.current = { kind: 'seek' }
      }
    }

    const onMove = (ev: MouseEvent) => {
      const canvas = canvasRef.current
      const mode = dragRef.current
      if (!canvas || !mode || mode.kind === 'seek' || mode.kind === 'activate-line') return
      const r = canvas.getBoundingClientRect()
      const mx = ev.clientX - r.left
      const ms = Math.max(0, Math.round(timeAtX(mx, width, winStart, winEnd) * 1000))
      dragMovedRef.current = true

      if (mode.kind === 'resize-start') {
        const newStart = Math.max(0, Math.min(ms, mode.origEndMs - MIN_LINE_DURATION_MS))
        previewRef.current.set(mode.lineIndex, { start_ms: newStart, end_ms: mode.origEndMs })
      } else if (mode.kind === 'resize-end') {
        const newEnd = Math.max(ms, mode.origStartMs + MIN_LINE_DURATION_MS)
        previewRef.current.set(mode.lineIndex, { start_ms: mode.origStartMs, end_ms: newEnd })
      } else if (mode.kind === 'move') {
        const durationMs = mode.origEndMs - mode.origStartMs
        const newStart = Math.max(0, ms - mode.grabOffsetMs)
        previewRef.current.set(mode.lineIndex, { start_ms: newStart, end_ms: newStart + durationMs })
      }
      drawWaveform()
    }

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const mode = dragRef.current
      dragRef.current = null
      if (!mode) return

      if (mode.kind === 'seek') {
        const canvas = canvasRef.current
        if (canvas) {
          const r = canvas.getBoundingClientRect()
          const mx = ev.clientX - r.left
          onSeek(Math.max(0, timeAtX(mx, width, winStart, winEnd)))
        }
        drawWaveform()
        return
      }

      if (mode.kind === 'activate-line') {
        onLineActivate?.(mode.lineIndex)
        drawWaveform()
        return
      }

      if (dragMovedRef.current) {
        const preview = previewRef.current.get(mode.lineIndex)
        previewRef.current.delete(mode.lineIndex)
        if (preview) onLineTimingChange(mode.lineIndex, preview)
      } else {
        onLineActivate?.(mode.lineIndex)
      }
      drawWaveform()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Hover-only feedback (cursor + edge-handle highlight) — separate from
  // the window-level drag listener above, and inert while actually
  // dragging (that path redraws itself directly).
  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (dragRef.current) return
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const width = rect.width
    const winStart = clampedScroll
    const winEnd = clampedScroll + (visibleDuration || duration)
    const x = e.clientX - rect.left
    setHover(hitTestAt(x, width, winStart, winEnd))
  }

  function handleMouseLeave() {
    if (dragRef.current) return
    setHover(null)
  }

  // Body hover over the active line resizes on plain drag (Aegisub's model
  // — see handleMouseDown), not moves; the move-style grab cursor only
  // makes sense there when Alt is what's actually going to be held, which
  // hover state can't see coming, so a resize-flavored cursor over the
  // active line's own body is the less misleading default. A different
  // (inactive) line's body is just a click target, hence pointer.
  const cursorClass =
    hover?.edge === 'start' || hover?.edge === 'end' ? 'cursor-ew-resize' :
    hover?.edge === 'move' && hover.lineIndex === activeIndex ? 'cursor-ew-resize' :
    hover?.edge === 'move' ? 'cursor-pointer' :
    'cursor-crosshair'

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
        <span className="text-xs text-rh-muted font-medium">{label}</span>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-rh-text-dim">Завантаження…</span>}
          {!audioPath && !loading && <span className="text-xs text-rh-muted">{emptyMessage}</span>}
          {audioPath && (
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
          className={`absolute inset-0 w-full h-full ${cursorClass}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onWheel={handleWheel}
        />
        {!audioPath && (
          <div className="absolute inset-0 flex items-center justify-center text-rh-muted text-xs">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  )
}
