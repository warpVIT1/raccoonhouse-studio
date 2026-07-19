import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react'
import type { SubtitleLine } from '../../types'

export interface VideoPlayerHandle {
  currentTime: () => number
  seek: (t: number) => void
  play: () => void
  pause: () => void
  duration: () => number
}

interface VideoPlayerProps {
  src: string | null
  subtitles: SubtitleLine[]
  activeSubIndex: number | null
  onTimeUpdate: (t: number) => void
  onDurationChange: (d: number) => void
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, subtitles, activeSubIndex, onTimeUpdate, onDurationChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null)
    const [isPlaying, setIsPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [volume, setVolume] = useState(0.8)

    useImperativeHandle(ref, () => ({
      currentTime: () => videoRef.current?.currentTime ?? 0,
      seek: (t) => { if (videoRef.current) videoRef.current.currentTime = t },
      play: () => videoRef.current?.play(),
      pause: () => videoRef.current?.pause(),
      duration: () => videoRef.current?.duration ?? 0,
    }))

    useEffect(() => {
      const v = videoRef.current
      if (!v) return
      const onTime = () => {
        setCurrentTime(v.currentTime)
        onTimeUpdate(v.currentTime)
      }
      const onDur = () => {
        setDuration(v.duration)
        onDurationChange(v.duration)
      }
      const onPlay = () => setIsPlaying(true)
      const onPause = () => setIsPlaying(false)
      v.addEventListener('timeupdate', onTime)
      v.addEventListener('durationchange', onDur)
      v.addEventListener('play', onPlay)
      v.addEventListener('pause', onPause)
      return () => {
        v.removeEventListener('timeupdate', onTime)
        v.removeEventListener('durationchange', onDur)
        v.removeEventListener('play', onPlay)
        v.removeEventListener('pause', onPause)
      }
    }, [onTimeUpdate, onDurationChange])

    useEffect(() => {
      if (videoRef.current) videoRef.current.volume = volume
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

    const videoUrl = src ? `http://localhost:8765/stream?path=${encodeURIComponent(src)}` : null

    return (
      <div className="flex flex-col bg-black rounded-lg overflow-hidden h-full">
        {/* Video frame */}
        <div className="flex-1 relative bg-black min-h-0">
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              className="w-full h-full object-contain"
              preload="metadata"
            />
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

          {/* Subtitle overlay */}
          {activeSub && (
            <div className="absolute bottom-10 left-0 right-0 flex justify-center pointer-events-none px-4">
              <div className="bg-black/80 text-white text-sm px-3 py-1.5 rounded text-center max-w-xl leading-snug">
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
