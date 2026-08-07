const DISABLED_KEY = 'cozy_elevenlabs_disabled'
const VOICE_CACHE_KEY = 'cozy_elevenlabs_voice_id'
/** Carla — Sweet, Soft and Meditative (preferred narrating voice) */
const CARLA_VOICE_ID = 'l32B8XDoylOsZKiSdfhE'
/** Premade Rachel — free-tier fallback if Carla is blocked on the plan */
const FREE_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
/** Flash model is cheapest and works with free monthly credits */
const MODEL_ID = 'eleven_flash_v2_5'

export function isElevenLabsDisabled() {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(DISABLED_KEY) === '1'
}

export function disableElevenLabs(reason) {
  if (typeof window === 'undefined') return reason
  localStorage.setItem(DISABLED_KEY, '1')
  return reason || 'ElevenLabs quota exceeded'
}

export function clearElevenLabsDisabled() {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(DISABLED_KEY)
    // Drop stale cached voices so we pick Carla again
    localStorage.removeItem(VOICE_CACHE_KEY)
  } catch { /* ignore */ }
}

function getApiKey() {
  if (typeof window === 'undefined') return ''
  return process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY || ''
}

export function hasElevenLabsKey() {
  return !!getApiKey() && !isElevenLabsDisabled()
}

function isQuotaExhausted(status, bodyText) {
  if (status !== 402) return false
  const t = (bodyText || '').toLowerCase()
  // Only permanently disable when ElevenLabs explicitly blames credits/quota.
  // Empty 402s are often "voice not on your plan" — those should retry another voice.
  return /quota|credit|payment|billing|exceeded|insufficient|out of|limit_reached|subscription/i.test(t)
}

function isVoiceAccessError(status, bodyText) {
  const t = (bodyText || '').toLowerCase()
  return (status === 402 || status === 403 || status === 400) &&
    /voice|access|not allowed|permission|does not have|cannot use/i.test(t)
}

/** Prefer Carla (Sweet, Soft and Meditative). Env override wins. */
function resolveVoiceId() {
  return process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_ID || CARLA_VOICE_ID
}

export function tokenizeWords(text) {
  const parts = []
  const regex = /([A-Za-z][A-Za-z'-]*)|([^A-Za-z]+)/g
  let m
  while ((m = regex.exec(text || '')) !== null) {
    if (m[1]) parts.push({ type: 'word', text: m[1] })
    else parts.push({ type: 'space', text: m[2] })
  }
  return parts
}

export function alignmentToWordTimings(text, alignment) {
  const starts = alignment?.character_start_times_seconds || []
  const ends = alignment?.character_end_times_seconds || []
  if (!starts.length) return []

  const tokens = tokenizeWords(text)
  const remapped = []
  let pos = 0
  for (const tok of tokens) {
    if (tok.type !== 'word') {
      pos += tok.text.length
      continue
    }
    const s = starts[Math.min(pos, starts.length - 1)] ?? 0
    const e = ends[Math.min(pos + tok.text.length - 1, ends.length - 1)] ?? s
    remapped.push({ text: tok.text, start: s, end: e })
    pos += tok.text.length
  }
  return remapped
}

export function estimateWordTimings(text, durationSec) {
  const words = tokenizeWords(text).filter((t) => t.type === 'word')
  if (!words.length || !durationSec || !Number.isFinite(durationSec)) return []
  const slot = durationSec / words.length
  return words.map((w, i) => ({
    text: w.text,
    start: i * slot,
    end: (i + 1) * slot,
  }))
}

function b64ToAudioUrl(b64, mime = 'audio/mpeg') {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

async function audioDuration(url) {
  return new Promise((resolve) => {
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : 0)
    a.onerror = () => resolve(0)
    a.src = url
  })
}

async function postSpeech(apiKey, voiceId, text, withTimestamps) {
  const path = withTimestamps
    ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`
    : `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`

  return fetch(path, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: withTimestamps ? 'application/json' : 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  })
}

/**
 * Prefer with-timestamps; fall back to plain TTS + estimated word timings.
 * Retries a free default voice when the chosen voice is not allowed on the plan.
 */
export async function synthesizeWithTimestamps(text) {
  if (!hasElevenLabsKey()) throw new Error('ELEVENLABS_UNAVAILABLE')
  if (!text?.trim()) throw new Error('EMPTY_TEXT')

  const apiKey = getApiKey()
  let voiceId = resolveVoiceId()
  const tried = new Set()

  async function attempt(vid, withTimestamps) {
    const key = `${vid}:${withTimestamps ? 1 : 0}`
    if (tried.has(key)) return null
    tried.add(key)
    const res = await postSpeech(apiKey, vid, text, withTimestamps)
    if (res.ok) return { ok: true, res, withTimestamps, voiceId: vid }
    const errBody = await res.text().catch(() => '')
    return { ok: false, res, errBody, withTimestamps, voiceId: vid }
  }

  let result = await attempt(voiceId, true)

  // If Carla isn't allowed on this plan, fall back to free Rachel for this request only
  if (result && !result.ok && isVoiceAccessError(result.res.status, result.errBody) && voiceId !== FREE_DEFAULT_VOICE_ID) {
    voiceId = FREE_DEFAULT_VOICE_ID
    result = await attempt(voiceId, true)
  }

  if (result && !result.ok && !isQuotaExhausted(result.res.status, result.errBody)) {
    result = await attempt(voiceId, false) || result
    if (!result.ok && voiceId !== FREE_DEFAULT_VOICE_ID) {
      voiceId = FREE_DEFAULT_VOICE_ID
      result = await attempt(voiceId, false) || result
    }
  }

  if (!result?.ok) {
    if (result && isQuotaExhausted(result.res.status, result.errBody)) {
      disableElevenLabs('402')
      throw new Error('ELEVENLABS_402')
    }
    const status = result?.res?.status || '?'
    const body = (result?.errBody || '').slice(0, 160)
    throw new Error(`ElevenLabs ${status}: ${body}`)
  }

  if (result.withTimestamps) {
    const data = await result.res.json()
    const b64 = data.audio_base64
    if (!b64) throw new Error('No audio_base64 in response')
    const audioUrl = b64ToAudioUrl(b64)
    const alignment = data.alignment || data.normalized_alignment || {}
    let wordTimings = alignmentToWordTimings(text, alignment)
    if (!wordTimings.length) {
      wordTimings = estimateWordTimings(text, await audioDuration(audioUrl))
    }
    return { audioUrl, wordTimings, provider: 'eleven', voiceId: result.voiceId }
  }

  const blob = await result.res.blob()
  const audioUrl = URL.createObjectURL(blob)
  return {
    audioUrl,
    wordTimings: estimateWordTimings(text, await audioDuration(audioUrl)),
    provider: 'eleven',
    voiceId: result.voiceId,
  }
}

export async function speakOnceEleven(text) {
  const { audioUrl } = await synthesizeWithTimestamps(text)
  return new Promise((resolve, reject) => {
    const audio = new Audio(audioUrl)
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl)
      resolve()
    }
    audio.onerror = (e) => {
      URL.revokeObjectURL(audioUrl)
      reject(e)
    }
    audio.play().catch(reject)
  })
}
