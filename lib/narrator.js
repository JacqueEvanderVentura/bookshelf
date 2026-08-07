import {
  hasElevenLabsKey,
  synthesizeWithTimestamps,
  tokenizeWords,
  isElevenLabsDisabled,
} from './elevenlabs-client'

const FEMALE_VOICE_RE =
  /Samantha|Karen|Moira|Fiona|Tessa|Victoria|Google US English|Microsoft Aria|Microsoft Jenny|Microsoft Zira|Female|Woman|samantha|karen/i

/**
 * Flatten book chapters into a word index for seeking / highlighting.
 */
export function buildWordIndex(book) {
  const words = []
  if (!book?.chapters) return words
  book.chapters.forEach((ch, chapterIdx) => {
    ;(ch.paragraphs || []).forEach((item, paraIdx) => {
      const text = typeof item === 'string' ? item : (item?.content || '')
      if (!text || item?.type === 'image') return
      const tokens = tokenizeWords(text)
      let wordIdx = 0
      tokens.forEach((t) => {
        if (t.type === 'word') {
          words.push({ chapterIdx, paraIdx, wordIdx, text: t.text })
          wordIdx++
        }
      })
    })
  })
  return words
}

export function findWordIndex(words, chapterIdx, paraIdx, wordIdx) {
  return words.findIndex(
    (w) => w.chapterIdx === chapterIdx && w.paraIdx === paraIdx && w.wordIdx === wordIdx
  )
}

function waitForVoices() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      resolve([])
      return
    }
    const existing = window.speechSynthesis.getVoices()
    if (existing.length) {
      resolve(existing)
      return
    }
    const done = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', done)
      resolve(window.speechSynthesis.getVoices())
    }
    window.speechSynthesis.addEventListener('voiceschanged', done)
    // Safari sometimes never fires — timeout fallback
    setTimeout(done, 500)
  })
}

function pickFallbackVoiceSync() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null
  const voices = window.speechSynthesis.getVoices() || []
  const en = voices.filter((v) => /^en(-|_)/i.test(v.lang || '') || (v.lang || '').startsWith('en'))
  const pool = en.length ? en : voices
  return (
    pool.find((v) => FEMALE_VOICE_RE.test(v.name)) ||
    pool.find((v) => /female/i.test(v.name)) ||
    pool[0] ||
    null
  )
}

export function pickFallbackVoice() {
  const sync = pickFallbackVoiceSync()
  if (sync) return Promise.resolve(sync)
  return waitForVoices().then(() => pickFallbackVoiceSync())
}

export const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

function clampRate(r) {
  const n = Number(r)
  if (!Number.isFinite(n)) return 1
  // SpeechSynthesisUtterance.rate is typically 0.1–10; Audio.playbackRate similar
  return Math.min(2, Math.max(0.25, n))
}

function textFromWords(words, from, to) {
  const slice = words.slice(from, to)
  return slice.map((w) => w.text).join(' ')
}

/**
 * Create a narrator controller bound to a book.
 */
export function createNarrator({ book, onStatus, onSpeakingWord, onChapterNeeded, initialRate = 1 }) {
  const words = buildWordIndex(book)
  let wordIndex = 0
  let playing = false
  let paused = false
  let provider = hasElevenLabsKey() ? 'eleven' : 'webspeech'
  let audio = null
  let audioUrl = null
  let chunkTimings = []
  let chunkStartAbs = 0
  let rafId = null
  let utterance = null
  let destroyed = false
  let elevenFailed = isElevenLabsDisabled()
  let speechGen = 0 // ignore cancelled utterance callbacks during seek
  let rate = clampRate(initialRate)
  let loading = false // true while preparing / fetching TTS audio

  const emitStatus = () => {
    onStatus?.({
      playing,
      paused,
      loading,
      wordIndex,
      totalWords: words.length,
      provider: elevenFailed || !hasElevenLabsKey() ? 'webspeech' : provider,
      visible: playing || paused || loading,
      rate,
    })
  }

  const setLoading = (v) => {
    if (loading === v) return
    loading = v
    emitStatus()
  }

  const emitWord = (absIdx) => {
    const w = words[absIdx]
    if (!w) return
    onSpeakingWord?.(w)
    onChapterNeeded?.(w.chapterIdx)
  }

  const clearAudio = () => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.ontimeupdate = null
      try { audio.pause() } catch {}
      audio = null
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      audioUrl = null
    }
    chunkTimings = []
  }

  const stopSpeech = () => {
    speechGen += 1
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    utterance = null
  }

  const stop = () => {
    // Mark stopped BEFORE cancel/clear so in-flight chunks cannot revive playback
    playing = false
    paused = false
    loading = false
    speechGen += 1
    clearAudio()
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    utterance = null
    onSpeakingWord?.(null)
    emitStatus()
  }

  /** Build a synthesis chunk from abs word index — up to ~2200 chars or chapter end. */
  function nextChunkRange(fromAbs) {
    if (fromAbs >= words.length) return null
    const startChapter = words[fromAbs].chapterIdx
    let end = fromAbs
    let len = 0
    while (end < words.length && words[end].chapterIdx === startChapter && len < 2200) {
      len += words[end].text.length + 1
      end++
    }
    if (end === fromAbs) end = Math.min(words.length, fromAbs + 1)
    return { from: fromAbs, to: end }
  }

  function tickAudio() {
    if (!audio || !playing || paused) return
    const t = audio.currentTime
    let local = 0
    for (let i = 0; i < chunkTimings.length; i++) {
      if (chunkTimings[i].start <= t) local = i
      else break
    }
    const abs = chunkStartAbs + local
    if (abs !== wordIndex) {
      wordIndex = abs
      emitWord(abs)
      emitStatus()
    }
    rafId = requestAnimationFrame(tickAudio)
  }

  function canContinue() {
    return !destroyed && playing && !paused
  }

  /** Continue narration; never leave the player stranded on an API blip. */
  async function continueFrom(fromAbs) {
    if (!canContinue()) return
    if (fromAbs >= words.length) {
      stop()
      return
    }
    try {
      if (!elevenFailed && hasElevenLabsKey()) {
        provider = 'eleven'
        await playElevenChunk(fromAbs)
      } else {
        provider = 'webspeech'
        await playWebSpeech(fromAbs)
      }
    } catch (e) {
      if (!canContinue()) return
      console.warn('Narrator continue failed, trying device voice', e)
      elevenFailed = true
      try {
        provider = 'webspeech'
        await playWebSpeech(fromAbs)
      } catch (e2) {
        if (!canContinue()) return
        console.warn('Device voice also failed — skipping chunk', e2)
        const range = nextChunkRange(fromAbs)
        const next = range ? range.to : fromAbs + 1
        if (next < words.length && canContinue()) await continueFrom(next)
        else if (playing && !paused) stop()
      }
    }
  }

  async function fallbackToWebSpeech(fromAbs, reason) {
    console.warn('ElevenLabs fallback → device voice:', reason)
    elevenFailed = true
    provider = 'webspeech'
    clearAudio()
    if (!canContinue()) return
    await playWebSpeech(fromAbs)
  }

  async function playElevenChunk(fromAbs) {
    if (!canContinue()) return
    const range = nextChunkRange(fromAbs)
    if (!range) {
      stop()
      return
    }
    const text = textFromWords(words, range.from, range.to)
    setLoading(true)
    let result
    try {
      result = await synthesizeWithTimestamps(text)
    } catch (e) {
      if (!canContinue()) {
        setLoading(false)
        return
      }
      await fallbackToWebSpeech(fromAbs, e?.message || e)
      return
    }

    if (!canContinue()) {
      setLoading(false)
      return
    }

    clearAudio()
    if (!canContinue()) {
      setLoading(false)
      return
    }

    chunkStartAbs = range.from
    chunkTimings = result.wordTimings || []
    audioUrl = result.audioUrl
    audio = new Audio(audioUrl)
    audio.defaultPlaybackRate = rate
    audio.playbackRate = rate
    wordIndex = range.from
    provider = 'eleven'
    emitWord(wordIndex)

    audio.onended = () => {
      if (!canContinue()) return
      const next = range.to
      // Show loading while the next ElevenLabs chunk is fetched
      setLoading(true)
      continueFrom(next).catch((err) => {
        if (!canContinue()) return
        console.warn('Chunk continue error', err)
        fallbackToWebSpeech(next < words.length ? next : wordIndex, err?.message || err).catch(() => {
          if (playing && !paused) stop()
        })
      })
    }
    audio.onerror = () => {
      if (!canContinue()) return
      fallbackToWebSpeech(wordIndex || fromAbs, 'audio element error').catch(() => {
        if (playing && !paused) stop()
      })
    }
    audio.onplay = () => {
      setLoading(false)
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(tickAudio)
    }
    try {
      await audio.play()
      // Some browsers reset playbackRate on play() — re-apply after start
      audio.defaultPlaybackRate = rate
      audio.playbackRate = rate
      setLoading(false)
      if (!canContinue()) {
        try { audio.pause() } catch {}
        return
      }
      emitStatus()
    } catch (e) {
      if (!canContinue()) {
        setLoading(false)
        return
      }
      await fallbackToWebSpeech(fromAbs, e?.message || 'audio.play failed')
    }
  }

  async function playWebSpeech(fromAbs) {
    if (!canContinue()) return
    setLoading(true)
    clearAudio()
    const myGen = ++speechGen
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    utterance = null
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      setLoading(false)
      stop()
      return
    }
    if (!canContinue()) {
      setLoading(false)
      return
    }

    const range = nextChunkRange(fromAbs)
    if (!range) {
      setLoading(false)
      stop()
      return
    }
    const text = textFromWords(words, range.from, range.to)
    const localWords = words.slice(range.from, range.to)
    const voice = pickFallbackVoiceSync()

    const utter = new SpeechSynthesisUtterance(text)
    utter.rate = rate
    utter.pitch = 1.0
    utter.lang = 'en-US'
    if (voice) utter.voice = voice

    let boundaryCount = 0
    wordIndex = range.from
    provider = 'webspeech'
    utterance = utter
    emitWord(wordIndex)

    utter.onboundary = (e) => {
      if (myGen !== speechGen || !canContinue()) return
      if (e.name === 'word' && localWords[boundaryCount]) {
        wordIndex = range.from + boundaryCount
        emitWord(wordIndex)
        emitStatus()
        boundaryCount++
      }
    }
    utter.onend = () => {
      if (destroyed || myGen !== speechGen) return
      if (!canContinue()) return
      if (range.to < words.length) {
        continueFrom(range.to).catch(() => {
          if (playing && !paused) stop()
        })
      } else {
        stop()
      }
    }
    utter.onerror = (e) => {
      if (destroyed || myGen !== speechGen) return
      const typ = e?.error || ''
      if (typ === 'interrupted' || typ === 'canceled' || typ === 'cancelled') return
      if (!canContinue()) return
      console.warn('Web Speech error, skipping chunk', typ)
      if (range.to < words.length) {
        continueFrom(range.to).catch(() => {
          if (playing && !paused) stop()
        })
      } else {
        stop()
      }
    }
    try { window.speechSynthesis.resume() } catch {}
    await new Promise((r) => setTimeout(r, 40))
    if (destroyed || myGen !== speechGen || !canContinue()) {
      setLoading(false)
      return
    }
    window.speechSynthesis.speak(utter)
    setLoading(false)
    emitStatus()
  }

  async function playFromAbs(absIdx) {
    if (destroyed) return
    if (!words.length) return
    const idx = Math.max(0, Math.min(words.length - 1, absIdx | 0))
    playing = true
    paused = false
    loading = true
    wordIndex = idx
    emitWord(wordIndex)
    emitStatus()
    try { window.speechSynthesis?.resume?.() } catch {}
    stopSpeech()
    clearAudio()
    playing = true
    paused = false
    loading = true
    emitStatus()
    await continueFrom(idx)
    // continueFrom / play* clear loading when audio actually starts
    if (!playing) setLoading(false)
  }

  function pause() {
    if (!playing || paused) return
    paused = true
    loading = false
    if (audio) {
      try { audio.pause() } catch {}
    }
    // Web Speech pause() is unreliable — cancel utterance, keep session paused at wordIndex
    if (provider === 'webspeech' || !audio) {
      speechGen += 1
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
      utterance = null
    }
    emitStatus()
  }

  function resume() {
    if (!playing || !paused) return
    paused = false
    emitStatus()
    if (provider === 'eleven' && audio) {
      audio.play().catch(() => {
        setLoading(true)
        continueFrom(wordIndex)
      })
      rafId = requestAnimationFrame(tickAudio)
      return
    }
    setLoading(true)
    continueFrom(wordIndex)
  }

  async function seekByWords(delta) {
    const next = Math.max(0, Math.min(words.length - 1, wordIndex + delta))
    if (provider === 'eleven' && audio && chunkTimings.length) {
      const local = next - chunkStartAbs
      if (local >= 0 && local < chunkTimings.length) {
        wordIndex = next
        audio.currentTime = chunkTimings[local].start
        emitWord(wordIndex)
        emitStatus()
        if (!paused && audio.paused) {
          audio.play().catch(() => {})
        }
        return
      }
    }
    const wasPaused = paused
    await playFromAbs(next)
    if (wasPaused) pause()
  }

  async function speakWordOnly(text) {
    if (!text?.trim()) return
    try {
      if (!elevenFailed && hasElevenLabsKey()) {
        const { audioUrl: url } = await synthesizeWithTimestamps(text)
        await new Promise((resolve, reject) => {
          const a = new Audio(url)
          a.defaultPlaybackRate = rate
          a.playbackRate = rate
          a.onended = () => { URL.revokeObjectURL(url); resolve() }
          a.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
          a.play()
            .then(() => { a.defaultPlaybackRate = rate; a.playbackRate = rate })
            .catch(reject)
        })
        return
      }
    } catch (e) {
      if (e.message === 'ELEVENLABS_402') elevenFailed = true
    }
    const voice = await pickFallbackVoice()
    const utter = new SpeechSynthesisUtterance(text)
    utter.rate = rate
    utter.lang = 'en-US'
    if (voice) utter.voice = voice
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utter)
  }

  function applyAudioRate(el, value) {
    if (!el) return
    const r = clampRate(value)
    try {
      el.defaultPlaybackRate = r
      el.playbackRate = r
    } catch { /* ignore */ }
  }

  function setRate(next) {
    rate = clampRate(next)
    emitStatus()

    if (audio && (provider === 'eleven' || audio.src)) {
      applyAudioRate(audio, rate)
      // Stubborn engines (esp. mobile): nudge currentTime so the new rate sticks mid-play
      if (playing && !paused) {
        try {
          const t = audio.currentTime
          if (Math.abs((audio.playbackRate || 1) - rate) > 0.01) {
            audio.pause()
            applyAudioRate(audio, rate)
            audio.currentTime = t
            audio.play().then(() => applyAudioRate(audio, rate)).catch(() => {})
          } else {
            // Even when it reports the right rate, re-assign after a microtask
            queueMicrotask(() => applyAudioRate(audio, rate))
          }
        } catch {
          applyAudioRate(audio, rate)
        }
      }
      return
    }

    // Web Speech must rebuild the utterance to pick up a new rate
    if (provider === 'webspeech' && playing && !paused) {
      playFromAbs(wordIndex)
    }
  }

  return {
    words,
    getWordIndex: () => wordIndex,
    getRate: () => rate,
    setRate,
    playFromAbs,
    playFromPosition: (chapterIdx, paraIdx, wordIdx) => {
      const i = findWordIndex(words, chapterIdx, paraIdx, wordIdx)
      return playFromAbs(i >= 0 ? i : 0)
    },
    playFromChapterStart: (chapterIdx) => {
      const i = words.findIndex((w) => w.chapterIdx === chapterIdx)
      return playFromAbs(i >= 0 ? i : 0)
    },
    pause,
    resume,
    stop,
    seekByWords,
    speakWordOnly,
    togglePlayPause: () => {
      if (!playing) return playFromAbs(wordIndex || 0)
      if (paused) resume()
      else pause()
    },
    destroy: () => {
      destroyed = true
      stop()
    },
    emitStatus,
  }
}
