/**
 * Project Gutenberg helpers: Gutendex search, reading-ease scrape, Flesch fallback.
 */

export function fleschToDifficulty(score) {
  const s = Number(score)
  if (!Number.isFinite(s)) return 3
  if (s >= 90) return 1
  if (s >= 80) return 1.5
  if (s >= 70) return 2
  if (s >= 60) return 2.5
  if (s >= 50) return 3
  if (s >= 30) return 4
  return 5
}

export function computeFleschEase(text) {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  const sentences = Math.max(1, (cleaned.match(/[.!?]+/g) || []).length)
  const words = cleaned.split(/\s+/).filter(Boolean)
  const wordCount = Math.max(1, words.length)
  let syllables = 0
  for (const w of words) {
    syllables += countSyllables(w)
  }
  return 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount)
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return 1
  if (w.length <= 3) return 1
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g)
  return Math.max(1, groups ? groups.length : 1)
}

/**
 * Search Project Gutenberg. Prefer gutenberg.org catalog search (same as the
 * website) — Gutendex often misses title phrases like "hansel and gretel".
 */
export async function searchGutenberg(query, { signal } = {}) {
  const q = (query || '').trim()
  if (!q) return { count: 0, results: [] }

  try {
    const fromSite = await searchGutenbergSite(q, { signal })
    // Trust gutenberg.org even when empty — Gutendex misses many title phrases
    return fromSite
  } catch (e) {
    if (e.name === 'AbortError') throw e
    console.warn('Gutenberg site search failed, trying Gutendex', e)
  }

  return searchGutendex(q, { signal })
}

async function searchGutenbergSite(query, { signal } = {}) {
  // Same-origin API (next dev / Node host)
  try {
    const res = await fetch(
      `/api/gutenberg-search?q=${encodeURIComponent(query)}`,
      { signal }
    )
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data.results) && data.results.length) {
        return {
          count: data.count || data.results.length,
          results: data.results.map(normalizeSiteHit),
          source: 'gutenberg.org',
        }
      }
      if (res.ok && Array.isArray(data.results)) {
        return { count: 0, results: [], source: 'gutenberg.org' }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e
  }

  // Static / GH Pages: scrape via CORS proxy
  const searchUrl =
    `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(query)}`
  const html = await fetchHtml(searchUrl)
  const hits = parseGutenbergSearchHtml(html)
  return {
    count: hits.length,
    results: hits.map(normalizeSiteHit),
    source: 'gutenberg.org',
  }
}

async function searchGutendex(query, { signal } = {}) {
  const url =
    `https://gutendex.com/books?search=${encodeURIComponent(query)}&languages=en`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Gutendex ${res.status}`)
  const data = await res.json()
  return {
    count: data.count || 0,
    next: data.next,
    results: (data.results || []).map(normalizeBook),
    source: 'gutendex',
  }
}

function normalizeSiteHit(hit) {
  const id = hit.id
  const epubUrls = collectEpubUrls(hit.formats || {}, id)
  const cover =
    hit.coverUrl ||
    (hit.formats && (hit.formats['image/jpeg'] || null)) ||
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`
  const author =
    hit.author ||
    (hit.authors || []).map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean).join(', ') ||
    'Unknown Author'
  return {
    id,
    title: hit.title,
    authors: Array.isArray(hit.authors)
      ? hit.authors.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean)
      : author === 'Unknown Author' ? [] : [author],
    author,
    downloadCount: hit.download_count || hit.downloadCount || 0,
    epubUrl: epubUrls[0] || null,
    epubUrls,
    coverUrl: cover,
    subjects: hit.subjects || [],
  }
}

/** Parse gutenberg.org /ebooks/search HTML into hit objects. */
export function parseGutenbergSearchHtml(html) {
  const blocks = html.match(/<li\s+class="booklink">[\s\S]*?<\/li>/gi) || []
  const results = []
  const seen = new Set()

  for (const block of blocks) {
    const idMatch = block.match(/\/ebooks\/(\d+)/)
    if (!idMatch) continue
    const id = Number(idMatch[1])
    if (seen.has(id)) continue
    seen.add(id)

    const title = decodeHtmlEntities(pickSpanClass(block, 'title')) || `Book ${id}`
    const author = decodeHtmlEntities(pickSpanClass(block, 'subtitle')) || 'Unknown Author'
    const extra = pickSpanClass(block, 'extra') || ''
    const downloads =
      Number((extra.match(/([\d,]+)\s*downloads?/i) || [])[1]?.replace(/,/g, '')) || 0
    const coverRel =
      (block.match(/class="cover-thumb"[^>]*src="([^"]+)"/i) ||
        block.match(/src="(\/cache\/epub\/[^"]+\.jpe?g)"/i) ||
        [])[1]
    const coverUrl = coverRel
      ? coverRel.startsWith('http')
        ? coverRel
        : `https://www.gutenberg.org${coverRel}`
      : `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`

    results.push({
      id,
      title,
      author,
      authors: author === 'Unknown Author' ? [] : [author],
      download_count: downloads,
      coverUrl,
    })
  }
  return results
}

function pickSpanClass(html, className) {
  const re = new RegExp(`class="${className}"[^>]*>\\s*([^<]+)`, 'i')
  const m = html.match(re)
  return m ? m[1].trim() : ''
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** Prefer real .epub file URLs over redirect endpoints like *.epub3.images */
export function collectEpubUrls(formats, gutenbergId) {
  const entries = Object.entries(formats || {})
  const scored = []

  for (const [mime, href] of entries) {
    if (!href || !/epub/i.test(mime + href)) continue
    let score = 0
    if (/\.epub(\?|$)/i.test(href)) score += 50
    if (/cache\/epub/i.test(href)) score += 40
    if (/images/i.test(href) && /\.epub/i.test(href)) score += 10
    if (/\.epub3?\.images\/?$/i.test(href) || /\.epub\.images\/?$/i.test(href)) score -= 30
    if (/noimages/i.test(href)) score -= 5
    scored.push({ href, score })
  }

  scored.sort((a, b) => b.score - a.score)
  const urls = scored.map((s) => s.href)

  if (gutenbergId) {
    const id = String(gutenbergId)
    const cache = [
      `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images-3.epub`,
      `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.epub`,
      `https://www.gutenberg.org/cache/epub/${id}/pg${id}.epub`,
    ]
    for (const u of cache) {
      if (!urls.includes(u)) urls.push(u)
    }
  }

  return [...new Set(urls)]
}

function normalizeBook(b) {
  const formats = b.formats || {}
  const epubUrls = collectEpubUrls(formats, b.id)
  const cover =
    formats['image/jpeg'] ||
    Object.entries(formats).find(([k]) => /image\//i.test(k))?.[1] ||
    null
  return {
    id: b.id,
    title: b.title,
    authors: (b.authors || []).map((a) => a.name).filter(Boolean),
    author: (b.authors || []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown Author',
    downloadCount: b.download_count || 0,
    epubUrl: epubUrls[0] || null,
    epubUrls,
    coverUrl: cover,
    subjects: b.subjects || [],
  }
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (res.ok) return await res.text()
  } catch { /* cors */ }

  const proxies = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ]
  for (const make of proxies) {
    try {
      const res = await fetch(make(url))
      if (res.ok) return await res.text()
    } catch { /* try next */ }
  }
  throw new Error('Could not fetch Gutenberg page')
}

export async function fetchReadingEase(gutenbergId) {
  const html = await fetchHtml(`https://www.gutenberg.org/ebooks/${gutenbergId}`)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table#about_book_table')
  if (table) {
    const rows = [...table.querySelectorAll('tr')]
    let target = rows.find((tr) => /reading\s*level/i.test(tr.textContent || ''))
    if (!target && rows[5]) target = rows[5]
    const text = target?.textContent || ''
    const m = text.match(/reading\s*ease\s*score:\s*([\d.]+)/i) || text.match(/([\d.]+)\s*\(/)
    if (m) return Number(m[1])
  }
  const m2 = html.match(/Reading ease score:\s*([\d.]+)/i)
  if (m2) return Number(m2[1])
  return null
}

export async function rateBookDifficulty(gutenbergId, fallbackText) {
  try {
    const ease = await fetchReadingEase(gutenbergId)
    if (ease != null) return { difficulty: fleschToDifficulty(ease), ease, source: 'gutenberg' }
  } catch { /* fall through */ }
  if (fallbackText) {
    const ease = computeFleschEase(fallbackText)
    if (ease != null) return { difficulty: fleschToDifficulty(ease), ease, source: 'flesch' }
  }
  return { difficulty: 3, ease: null, source: 'default' }
}

function looksLikeEpub(buf) {
  if (!buf || buf.byteLength < 4) return false
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf)
  return u8[0] === 0x50 && u8[1] === 0x4b // ZIP magic "PK"
}

async function fetchAsArrayBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  if (!looksLikeEpub(buf)) throw new Error('Not an EPUB file')
  return buf
}

/**
 * Download an EPUB through same-origin proxy first (avoids Gutenberg CORS),
 * then fall back to public CORS proxies / alternate cache URLs.
 */
export async function downloadEpub(epubUrl, title = 'book.epub', { gutenbergId, epubUrls } = {}) {
  const candidates = []
  if (Array.isArray(epubUrls)) candidates.push(...epubUrls)
  if (epubUrl) candidates.push(epubUrl)
  if (gutenbergId) {
    candidates.push(...collectEpubUrls({}, gutenbergId))
  }
  const urls = [...new Set(candidates.filter(Boolean))]
  if (!urls.length) throw new Error('No EPUB URL')

  const errors = []

  for (const url of urls) {
    // 1) Local Next.js proxy (works on localhost / non-static hosts)
    try {
      const proxyPath = `/api/proxy-epub?url=${encodeURIComponent(url)}`
      const buf = await fetchAsArrayBuffer(proxyPath)
      return bufferToFile(buf, title)
    } catch (e) {
      errors.push(`proxy:${e.message}`)
    }

    // 2) Direct (rarely works in browser due to CORS)
    try {
      const buf = await fetchAsArrayBuffer(url)
      return bufferToFile(buf, title)
    } catch (e) {
      errors.push(`direct:${e.message}`)
    }

    // 3) Public CORS relays
    const relays = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
    ]
    for (const relay of relays) {
      try {
        const buf = await fetchAsArrayBuffer(relay)
        return bufferToFile(buf, title)
      } catch (e) {
        errors.push(`relay:${e.message}`)
      }
    }
  }

  throw new Error(`Download failed — Gutenberg blocks browser downloads. (${errors.slice(0, 3).join('; ')})`)
}

function bufferToFile(buf, title) {
  const blob = new Blob([buf], { type: 'application/epub+zip' })
  const safe = (title || 'book').replace(/[^\w\s.-]+/g, '').trim().slice(0, 80) || 'book'
  return new File([blob], `${safe}.epub`, { type: 'application/epub+zip' })
}

export function sampleTextFromChapters(chapters, maxWords = 3000) {
  const parts = []
  let count = 0
  for (const ch of chapters || []) {
    for (const p of ch.paragraphs || []) {
      const t = typeof p === 'string' ? p : p?.content
      if (!t || p?.type === 'image') continue
      const words = t.split(/\s+/)
      parts.push(t)
      count += words.length
      if (count >= maxWords) return parts.join(' ')
    }
  }
  return parts.join(' ')
}
