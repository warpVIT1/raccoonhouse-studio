import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react'
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

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, vocalStemPath, subtitles, activeSubIndex, onTimeUpdate, onDurationChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null)
    const vocalAudioRef = useRef<HTMLAudioElement>(null)
    const [isPlaying, setIsPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [volume, setVolume] = useState(0.8)
    // A-B toggle between the video's own mixed audio and the isolated vocal
    // stem, for reviewing separation quality — the stem plays through a
    // second, hidden <audio> element kept in lockstep with the video rather
    // than swapping the video's own audio track (different file entirely).
    const [audioSource, setAudioSource] = useState<'original' | 'vocal'>('original')

    useImperativeHandle(ref, () => ({
      currentTime: () => videoRef.current?.currentTime ?? 0,
      seek: (t) => { if (videoRef.current) videoRef.current.currentTime = t },
      play: () => videoRef.current?.play(),
      pause: () => videoRef.current?.pause(),
      duration: () => videoRef.current?.duration ?? 0,
      isPaused: () => videoRef.current?.paused ?? true,
    }))

    const videoUrl = src ? `http://localhost:8765/api/stream?path=${encodeURIComponent(src)}` : null
    const vocalUrl = vocalStemPath ? `http://localhost:8765/api/stream?path=${encodeURIComponent(vocalStemPath)}` : null

    useEffect(() => {
      const v = videoRef.current
      if (!v) return
      const a = vocalAudioRef.current
      const onTime = () => {
        setCurrentTime(v.currentTime)
        onTimeUpdate(v.currentTime)
      }
      const onDur = () => {
        setDuration(v.duration)
        onDurationChange(v.duration)
      }
      const onPlay = () => { setIsPlaying(true); a?.play().catch(() => {}) }
      const onPause = () => { setIsPlaying(false); a?.pause() }
      // Hard-resync the vocal track on every seek — letting both elements
      // free-run independently drifts them apart within a few seconds.
      const onSeeked = () => { if (a) a.currentTime = v.currentTime }
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

    useEffect(() => {
      if (videoRef.current) videoRef.current.volume = volume
      if (vocalAudioRef.current) vocalAudioRef.current.volume = volume
    }, [volume])

    // Active subtitle text
    const activeSub = activeSubIndex != null ? subtitles[activeSubIndex] : null

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

          {/* Subtitle overlay — outlined text, no background box, matching
              Aegisub's own preview rendering rather than a solid caption bar */}
          {activeSub && (
            <div className="absolute bottom-10 left-0 right-0 flex justify-center pointer-events-none px-4">
              <div
                className="text-white text-base font-medium text-center max-w-2xl leading-snug whitespace-pre-line"
                style={{ textShadow: '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 0 4px rgba(0,0,0,0.8)' }}
              >
                {activeSub.text.replace(/\\N/gi, '\n').replace(/\{[^}]+\}/g, '')}
              </div>
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
                  className={`px-2 py-0.5 text-[10.5px] font-semibold transition-colors ${
                    audioSource === 'vocal' ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-white'
                  }`}
                >
                  Вокал
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
