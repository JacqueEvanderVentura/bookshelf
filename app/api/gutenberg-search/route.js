import { NextResponse } from 'next/server'
import { parseGutenbergSearchHtml } from '@/lib/gutenberg'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Proxy Project Gutenberg's HTML catalog search (better relevance than Gutendex).
 */
export async function GET(request) {
  const q = (request.nextUrl.searchParams.get('q') || '').trim()
  if (!q) {
    return NextResponse.json({ count: 0, results: [] })
  }

  const start = Math.max(1, Number(request.nextUrl.searchParams.get('start')) || 1)
  const searchUrl =
    `https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(q)}` +
    (start > 1 ? `&start_index=${start}` : '')

  try {
    const upstream = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'DaniniBookshelf/1.0 (educational; local reader)',
        Accept: 'text/html',
      },
      redirect: 'follow',
    })
    if (!upstream.ok) {
      return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: 502 })
    }
    const html = await upstream.text()
    const results = parseGutenbergSearchHtml(html)
    return NextResponse.json({ count: results.length, results, source: 'gutenberg.org' })
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Search failed' }, { status: 502 })
  }
}
