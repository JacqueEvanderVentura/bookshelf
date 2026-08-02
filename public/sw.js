/* Auto-stamped on deploy — placeholder below is replaced by scripts/stamp-sw.js */
const BUILD_ID = '__BUILD_ID__'
const CACHE = 'bookshelf-__BUILD_ID__'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(['./', './site.webmanifest']).catch(() => {})
    )
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
  if (event.data === 'GET_BUILD_ID') {
    event.source?.postMessage({ type: 'BUILD_ID', buildId: BUILD_ID })
  }
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  // Always hit the network for the SW script itself
  if (url.pathname.endsWith('/sw.js')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }))
    return
  }

  const accept = event.request.headers.get('accept') || ''
  const isNavigate =
    event.request.mode === 'navigate' ||
    accept.includes('text/html')

  // Network-first for HTML so every deploy shows up
  if (isNavigate) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone()
            caches.open(CACHE).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
        .catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
    )
    return
  }

  // Stale-while-revalidate for static assets (offline-friendly)
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request)
      const networkPromise = fetch(event.request)
        .then((response) => {
          if (response && response.ok) cache.put(event.request, response.clone())
          return response
        })
        .catch(() => cached)
      return cached || networkPromise
    })
  )
})
