export const dynamic = 'force-static'

export function generateStaticParams() {
  return [{}]
}

export async function GET() {
  return new Response(JSON.stringify({
    name: "Danini's Bookshelf",
    short_name: 'Bookshelf',
    description: 'A cozy reading app for learning English, one word at a time.',
    start_url: '.',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#F5E6D3',
    theme_color: '#D4A574',
    icons: [
      { src: 'android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: 'android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }), {
    headers: { 'Content-Type': 'application/manifest+json' },
  })
}
