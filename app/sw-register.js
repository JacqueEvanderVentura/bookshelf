'use client'

import { useEffect } from 'react'

export default function SWRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const swPath = location.pathname.startsWith('/bookshelf') ? '/bookshelf/sw.js' : '/sw.js'
    navigator.serviceWorker.register(swPath).catch(() => {})
  }, [])
  return null
}
