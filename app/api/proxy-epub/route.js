import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ALLOWED = /^https:\/\/([\w.-]+\.)?gutenberg\.org\//i

/**
 * Same-origin EPUB proxy so the browser can download Gutenberg files
 * without hitting CORS (works in `next dev` / non-static deploys).
 */
export async function GET(request) {
  const url = request.nextUrl.searchParams.get('url')
  if (!url || !ALLOWED.test(url)) {
    return NextResponse.json({ error: 'Invalid or disallowed URL' }, { status: 400 })
  }

  try {
    const upstream = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'DaniniBookshelf/1.0 (educational; local reader)',
        Accept: 'application/epub+zip,application/octet-stream,*/*',
      },
    })

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Upstream ${upstream.status}` },
        { status: upstream.status === 404 ? 404 : 502 }
      )
    }

    const buf = await upstream.arrayBuffer()
    // Sanity: EPUB is a zip (PK..)
    const head = new Uint8Array(buf.slice(0, 2))
    if (head[0] !== 0x50 || head[1] !== 0x4b) {
      return NextResponse.json({ error: 'Upstream did not return an EPUB' }, { status: 502 })
    }

    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/epub+zip',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Proxy failed' }, { status: 502 })
  }
}
