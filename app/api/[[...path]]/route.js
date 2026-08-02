import { NextResponse } from 'next/server'

const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions'

// Cheapest capable models (fallback chain if one fails)
const MODEL_CHAIN = [
  'accounts/fireworks/models/llama-v3p1-8b-instruct',
  'accounts/fireworks/models/mixtral-8x7b-instruct',
  'accounts/fireworks/models/llama-v3p3-70b-instruct',
]

async function callFireworks(word, context) {
  const apiKey = process.env.FIREWORKS_API_KEY
  if (!apiKey) throw new Error('FIREWORKS_API_KEY missing')

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
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
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
      if (!res.ok) {
        lastError = `Fireworks ${model} → ${res.status}`
        continue
      }
      const data = await res.json()
      const content = data?.choices?.[0]?.message?.content
      if (!content) { lastError = 'empty content'; continue }
      const parsed = JSON.parse(content)
      return { ...parsed, model }
    } catch (e) {
      lastError = e.message
      continue
    }
  }
  throw new Error(`All models failed: ${lastError}`)
}

async function moreExamples(word, alreadyHave, context) {
  const apiKey = process.env.FIREWORKS_API_KEY
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

export async function GET(request, { params }) {
  const path = (await params)?.path || []
  const route = path.join('/')
  if (route === '' || route === 'health') {
    return NextResponse.json({ ok: true, service: "Daniela's Bookshelf API" })
  }
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}

export async function POST(request, { params }) {
  const path = (await params)?.path || []
  const route = path.join('/')
  try {
    if (route === 'define') {
      const { word, context } = await request.json()
      if (!word || typeof word !== 'string') {
        return NextResponse.json({ error: 'word_required' }, { status: 400 })
      }
      const cleaned = word.toLowerCase().replace(/[^a-z'-]/g, '').trim()
      if (!cleaned) return NextResponse.json({ error: 'invalid_word' }, { status: 400 })
      const result = await callFireworks(cleaned, context)
      return NextResponse.json(result)
    }
    if (route === 'more-examples') {
      const { word, have, context } = await request.json()
      const result = await moreExamples(word, have, context)
      return NextResponse.json(result)
    }
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch (e) {
    console.error('API error:', e)
    return NextResponse.json({ error: 'server_error', detail: e.message }, { status: 500 })
  }
}
