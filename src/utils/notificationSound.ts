// No raccoon audio asset ships with the app, so this synthesizes a short
// chittering "trill" (a handful of quick pitch-rising blips) purely via the
// Web Audio API instead of embedding a real sample — no license/asset to
// manage, and it plays instantly on the very first call.
export function playRaccoonChirp() {
  try {
    const AudioCtxCls = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtxCls()
    const now = ctx.currentTime
    const chirpStarts = [0, 0.09, 0.16, 0.26, 0.33]

    chirpStarts.forEach((offset) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sawtooth'
      const baseFreq = 900 + Math.random() * 300
      osc.frequency.setValueAtTime(baseFreq, now + offset)
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.6, now + offset + 0.05)
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.15, now + offset + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.07)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + offset)
      osc.stop(now + offset + 0.08)
    })

    setTimeout(() => ctx.close(), 600)
  } catch {
    // Sound is a nice-to-have notification cue — never let it block or
    // break the actual consent popup if the browser denies audio (e.g. no
    // prior user gesture in this window yet).
  }
}
