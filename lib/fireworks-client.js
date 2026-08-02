const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions'

const MODEL_CHAIN = [
  'accounts/fireworks/models/deepseek-v4-flash',
  'accounts/fireworks/models/deepseek-v4-flash-0731',
  'accounts/fireworks/routers/glm-5p2-fast',
  'accounts/fireworks/models/gpt-oss-120b',
]

function getKey() {
  if (typeof window === 'undefined') return null
  return process.env.NEXT_PUBLIC_FIREWORKS_API_KEY || ''
}

export async function defineWord(word, context) {
  const apiKey = getKey()
  if (!apiKey) throw new Error('API key missing')

  const systemPrompt = `You are a friendly dictionary for English learners. Given a word and its context sentence, respond ONLY with valid JSON in this exact shape:
{
  "word": "the word (lowercased)",
  "phonetic": "IPA pronunciation e.g. /prɪns/",
  "partOfSpeech": "noun|verb|adjective|adverb|etc",
  "definition": "a clear, simple definition (max 20 words) suited for the given context",
  "examples": ["first natural example sentence", "second natural example sentence"]
}
Use simple English. No markdown. No prose outside the JSON.`

  const userPrompt = `Word: "${word}"\nContext: "${context || 'no extra context'}"`

  let lastError = null
  for (const model of MODEL_CHAIN) {
    try {
      const res = await fetch(FIREWORKS_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 400,
          temperature: 0.3,
        }),
      })
      if (!res.ok) { lastError = `Fireworks ${model} → ${res.status}`; continue }
      const data = await res.json()
      const content = data?.choices?.[0]?.message?.content
      if (!content) { lastError = 'empty content'; continue }
      return { ...JSON.parse(content), model }
    } catch (e) {
      lastError = e.message
      continue
    }
  }
  throw new Error(`All models failed: ${lastError}`)
}

export async function explainPhrase(phrase, context) {
  const apiKey = getKey()
  if (!apiKey) throw new Error('API key missing')

  const systemPrompt = `You are a warm English tutor helping a learner understand a phrase they highlighted in a book. Respond ONLY with valid JSON in this exact shape:
{
  "phrase": "the phrase as given (trimmed)",
  "type": "idiom" | "saying" | "proverb" | "expression" | "phrase" | "sentence",
  "meaning": "a clear, simple explanation of what this really means in context (max 45 words)",
  "literal": "if it's an idiom/saying whose meaning differs from the words, briefly say what the words literally describe. Otherwise null.",
  "examples": ["natural, simple example 1", "natural, simple example 2"]
}
Use short simple English suited for learners. No markdown. No prose outside JSON.`

  const userPrompt = `Highlighted phrase: "${phrase}"\nSurrounding context: "${context || ''}"`

  let lastError = null
  for (const model of MODEL_CHAIN) {
    try {
      const res = await fetch(FIREWORKS_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 500,
          temperature: 0.3,
        }),
      })
      if (!res.ok) { lastError = `Fireworks ${model} → ${res.status}`; continue }
      const data = await res.json()
      const content = data?.choices?.[0]?.message?.content
      if (!content) { lastError = 'empty content'; continue }
      return { ...JSON.parse(content), isPhrase: true, model }
    } catch (e) {
      lastError = e.message
      continue
    }
  }
  throw new Error(`All models failed: ${lastError}`)
}

export async function moreExamples(word, alreadyHave, context) {
  const apiKey = getKey()
  const systemPrompt = `You generate example sentences for English learners. Respond ONLY with JSON: {"examples": ["sentence1", "sentence2"]}. Use simple, natural English. Do NOT repeat any given sentences.`
  const userPrompt = `Word: "${word}"\nContext: "${context || ''}"\nAlready shown: ${JSON.stringify(alreadyHave || [])}\nGive 2 more fresh, simple example sentences.`
  const res = await fetch(FIREWORKS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_CHAIN[0],
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
      temperature: 0.7,
    }),
  })
  if (!res.ok) throw new Error(`Fireworks ${res.status}`)
  const data = await res.json()
  return JSON.parse(data.choices[0].message.content)
}
