import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { SubtitleLine } from '../../types'

export interface VideoPlayerHandle {
  currentTime: () => number
  seek: (t: number) => void
  play: () => void
  pause: () => void
  duration: () => number
  isPaused: () => boolean
}

interface VideoPlayerProps {
  src: string | null
  vocalStemPath?: string | null
  subtitles: SubtitleLine[]
  activeSubIndex: number | null
  onTimeUpdate: (t: number) => void
  onDurationChange: (d: number) => void
}

// Parses just the leading {...} override-tag block our own SubtitleEditBox
// ever writes (\b1/\i1/\u1/\s1/\c&Hbbggrr&, see toggleTag/setColorTag there)
// into real CSS, plus \N line breaks — not a full ASS/libass implementation.
// Anything else (per-word tags, \pos, karaoke \k, drawing commands from a
// hand-authored/imported file) is silently stripped rather than rendered.
// Deliberate tradeoff: this replaced a full libass-via-WASM renderer
// (JASSUB) that, across several attempts, never reliably rendered anything
// in the packaged app (wrong file copied into public/jassub/, then a worker
// that loaded but whose own promise chain never resolved — confirmed live
// 2026-08-16 through three rounds of DevTools Network/Console inspection).
// A plain positioned <div> can't silently half-fail like a WASM worker can:
// either the text is here or it isn't, no async worker/wasm loading chain
// to go wrong. Good enough for a translator/timer checking their own text
// and basic emphasis against the picture — not a substitute for a real
// typesetting pass in Aegisub itself for anything with real positioning.
function parseAssText(raw: string): { bold: boolean; italic: boolean; underline: boolean; strike: boolean; color: string | null; lines: string[] } {
  const match = raw.match(/^\{([^}]*)\}/)
  const tags = match ? match[1] : ''
  const body = match ? raw.slice(match[0].length) : raw
  const colorMatch = tags.match(/\\c&H([0-9A-Fa-f]{6})&/)
  const clean = body.replace(/\{[^}]*\}/g, '')
  return {
    bold: /\\b1/.test(tags),
    italic: /\\i1/.test(tags),
    underline: /\\u1/.test(tags),
    strike: /\\s1/.test(tags),
    color: colorMatch ? `#${colorMatch[1].slice(4, 6)}${colorMatch[1].slice(2, 4)}${colorMatch[1].slice(0, 2)}` : null,
    lines: clean.split(/\\N/i),
  }
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, vocalStemPath, subtitles, onTimeUpdate, onDurationChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null)
    const vocalAudioRef = useRef<HTMLAudioElement>(null)
    const [isPlaying, setIsPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [volume, setVolume] = useState(0.8)
    // A-B toggle between the video's own mixed audio and the instrumental
    // (vocal_stem_path — original vocal removed, the dubbing base track), for
    // reviewing separation quality — the stem plays through a second, hidden
    // <audio> element kept in lockstep with the video rather than swapping
    // the video's own audio track (different file entirely).
    const [audioSource, setAudioSource] = useState<'original' | 'vocal'>('original')
    // Was hardcoded to 8765 everywhere below (video/vocal stream URLs,
    // JASSUB's subUrl, the ass-content refetch) — silently pointed at the
    // wrong backend for any second instance run on a different port (e.g.
    // this session's own RH_BACKEND_PORT sandbox setup), even though every
    // other network call in the app already reads this from the store.
    const backendPort = useAppStore((s) => s.backendPort)

    useImperativeHandle(ref, () => ({
      currentTime: () => videoRef.current?.currentTime ?? 0,
      seek: (t) => { if (videoRef.current) videoRef.current.currentTime = t },
      play: () => videoRef.current?.play(),
      pause: () => videoRef.current?.pause(),
      duration: () => videoRef.current?.duration ?? 0,
      isPaused: () => videoRef.current?.paused ?? true,
    }))

    const videoUrl = src ? `http://localhost:${backendPort}/api/stream?path=${encodeURIComponent(src)}` : null
    const vocalUrl = vocalStemPath ? `http://localhost:${backendPort}/api/stream?path=${encodeURIComponent(vocalStemPath)}` : null

    useEffect(() => {
      const v = videoRef.current
      if (!v) return
      const onTime = () => {
        setCurrentTime(v.currentTime)
        onTimeUpdate(v.currentTime)
        // Two independently-`.play()`-ed HTMLMediaElements (this <video> and
        // the instrumental <audio>) aren't guaranteed to stay locked step —
        // small decode/buffering differences accumulate over real playback
        // time, not just around seeks. Only re-syncing on 'seeked' (below)
        // left the instrumental audibly racing ahead of the seek bar during
        // plain uninterrupted playback (confirmed live). Correcting on every
        // timeupdate tick, but only past a small tolerance, fixes the drift
        // without audibly stuttering the instrumental on every frame.
        const a = vocalAudioRef.current
        if (a && Math.abs(a.currentTime - v.currentTime) > 0.2) {
          a.currentTime = v.currentTime
        }
      }
      const onDur = () => {
        setDuration(v.duration)
        onDurationChange(v.duration)
      }
      // Read vocalAudioRef.current fresh on every event rather than closing
      // over it once — the vocal stem (and its <audio> element) only exists
      // once separation finishes, which is always *after* this effect's
      // first run (videoUrl becomes non-null as soon as the episode loads,
      // well before vocalUrl does), so a closed-over reference would stay
      // null forever and the vocal track would silently never play.
      const onPlay = () => { setIsPlaying(true); vocalAudioRef.current?.play().catch(() => {}) }
      const onPause = () => { setIsPlaying(false); vocalAudioRef.current?.pause() }
      // Hard-resync the vocal track on every seek — letting both elements
      // free-run independently drifts them apart within a few seconds.
      const onSeeked = () => { if (vocalAudioRef.current) vocalAudioRef.current.currentTime = v.currentTime }
      v.addEventListener('timeupdate', onTime)
      v.addEventListener('durationchange', onDur)
      v.addEventListener('play', onPlay)
      v.addEventListener('pause', onPause)
      v.addEventListener('seeked', onSeeked)
      return () => {
        v.removeEventListener('timeupdate', onTime)
        v.removeEventListener('durationchange', onDur)
        v.removeEventListener('play', onPlay)
        v.removeEventListener('pause', onPause)
        v.removeEventListener('seeked', onSeeked)
      }
      // videoUrl is required here — the <video> element only renders once
      // the episode has actually loaded and videoUrl goes from null to a
      // real URL (episode data is fetched async, so this is the *normal*
      // case, not an edge case). Without it in the deps, this effect only
      // ever ran once on mount, while videoRef.current was still null (the
      // element hadn't rendered yet), attached zero listeners, and never
      // ran again — timeupdate/durationchange silently never fired at all,
      // which is exactly why duration/currentTime stayed frozen at 0.
    }, [onTimeUpdate, onDurationChange, videoUrl])

    // Re-sync immediately on toggling which track is audible, so the one
    // that was silently muted (and may have drifted or never started) snaps
    // back in step rather than waiting for the next seek/timeupdate.
    useEffect(() => {
      const v = videoRef.current
      const a = vocalAudioRef.current
      if (!v || !a) return
      a.currentTime = v.currentTime
      if (!v.paused) a.play().catch(() => {})
    }, [audioSource, vocalUrl])

    // Active line(s) for the plain overlay below — every subtitle whose
    // range covers the current playhead, not just one, since dialogue and
    // an overlapping sign/overlay line can legitimately be simultaneous
    // (SubtitleLine.is_overlap). Recomputed from `subtitles` directly (not
    // the `activeSubIndex` prop) so it updates on every timeupdate tick
    // rather than only when the grid's own selection changes.
    const activeLines = subtitles.filter(
      (l) => currentTime * 1000 >= l.start_ms && currentTime * 1000 <= l.end_ms
    )

    useEffect(() => {
      if (videoRef.current) videoRef.current.volume = volume
      if (vocalAudioRef.current) vocalAudioRef.current.volume = volume
    }, [volume])

    function togglePlay() {
      if (!videoRef.current) return
      if (videoRef.current.paused) videoRef.current.play()
      else videoRef.current.pause()
    }

    function formatTime(s: number) {
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = Math.floor(s % 60)
      if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
      return `${m}:${String(sec).padStart(2,'0')}`
    }

    function onSeekBarInput(e: React.ChangeEvent<HTMLInputElement>) {
      const t = parseFloat(e.target.value)
      if (videoRef.current) videoRef.current.currentTime = t
      setCurrentTime(t)
    }

    return (
      <div className="flex flex-col bg-black rounded-lg overflow-hidden h-full">
        {/* Video frame */}
        <div className="flex-1 relative bg-black min-h-0">
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                muted={audioSource === 'vocal'}
                className="w-full h-full object-contain"
                preload="metadata"
              />
              {vocalUrl && (
                <audio ref={vocalAudioRef} src={vocalUrl} muted={audioSource === 'original'} preload="auto" />
              )}
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-rh-muted">
              <div className="flex flex-col items-center gap-2">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                <span className="text-xs">Відео відсутнє</span>
              </div>
            </div>
          )}

          {/* Plain HTML/CSS subtitle overlay — see parseAssText's comment for
              why this replaced a libass/WASM (JASSUB) renderer. */}
          {videoUrl && activeLines.length > 0 && (
            <div className="absolute inset-x-0 bottom-3 flex flex-col items-center gap-1 px-6 pointer-events-none">
              {activeLines.map((line) => {
                const parsed = parseAssText(line.text)
                if (!parsed.lines.some((l) => l.trim())) return null
                return (
                  <div
                    key={line.id}
                    className="text-center px-2 py-0.5 max-w-full"
                    style={{
                      color: parsed.color ?? '#FFFFFF',
                      fontWeight: parsed.bold ? 700 : 500,
                      fontStyle: parsed.italic ? 'italic' : 'normal',
                      textDecoration: [parsed.underline && 'underline', parsed.strike && 'line-through'].filter(Boolean).join(' ') || 'none',
                      fontSize: '1.05rem',
                      lineHeight: 1.35,
                      textShadow: '0 1px 3px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.9), -1px -1px 0 rgba(0,0,0,0.9)',
                    }}
                  >
                    {parsed.lines.map((l, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <br />}
                        {l}
                      </React.Fragment>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="bg-[#0A0A0C] px-3 py-2 space-y-1.5">
          {/* Seek bar */}
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={currentTime}
            onChange={onSeekBarInput}
            className="w-full h-1 accent-rh-accent cursor-pointer"
          />

          {/* Controls row */}
          <div className="flex items-center gap-2">
            <button
              onClick={togglePlay}
              className="text-white hover:text-rh-accent transition-colors"
            >
              {isPlaying ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              )}
            </button>

            <span className="text-xs text-rh-muted font-mono tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            {vocalUrl && (
              <div className="flex rounded-md border border-rh-border overflow-hidden ml-2">
                <button
                  onClick={() => setAudioSource('original')}
                  className={`px-2 py-0.5 text-[10.5px] font-semibold transition-colors ${
                    audioSource === 'original' ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-white'
                  }`}
                >
                  Оригінал
                </button>
                <button
                  onClick={() => setAudioSource('vocal')}
                  title="Інструментал — оригінальний вокал видалено"
                  className={`px-2 py-0.5 text-[10.5px] font-semibold transition-colors ${
                    audioSource === 'vocal' ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-white'
                  }`}
                >
                  Інструментал
                </button>
              </div>
            )}

            <div className="ml-auto flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6B6B7A" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 010 7.07"/>
              </svg>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="w-16 h-1 accent-rh-accent cursor-pointer"
              />
            </div>
          </div>
        </div>
      </div>
    )
  }
)

VideoPlayer.displayName = 'VideoPlayer'
