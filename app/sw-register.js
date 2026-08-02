'use client'

import { useEffect } from 'react'

export default function SWRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

    const swPath = location.hostname.includes('github.io') ? '/bookshelf/sw.js' : '/sw.js'
    let refreshing = false
    let registration = null
    let interval = null

    const onControllerChange = () => {
      // New SW took over after a deploy — reload once to pick up fresh assets
      if (refreshing) return
      refreshing = true
      window.location.reload()
    }

    const checkForUpdate = () => {
      registration?.update().catch(() => {})
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    navigator.serviceWorker
      .register(swPath, { updateViaCache: 'none' })
      .then((reg) => {
        registration = reg

        // If a new worker is already waiting (previous visit), activate it
        if (reg.waiting) {
          reg.waiting.postMessage('SKIP_WAITING')
        }

        reg.addEventListener('updatefound', () => {
          const worker = reg.installing
          if (!worker) return
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              worker.postMessage('SKIP_WAITING')
            }
          })
        })

        // Check immediately, on focus/visibility, and periodically while open
        checkForUpdate()
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', checkForUpdate)
        interval = setInterval(checkForUpdate, 60_000)
      })
      .catch(() => {})

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', checkForUpdate)
      if (interval) clearInterval(interval)
    }
  }, [])

  return null
}
