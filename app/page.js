'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BookOpen, ArrowLeft, Bookmark, BookmarkCheck, Volume2,
  Play, Pause, Sparkles, Loader2, X, Plus,
  ChevronRight, ChevronLeft, Coffee, Heart, Type, FolderOpen, FileUp, Trash2,
  Library, Book, Settings2, Star, Flame, Check, Tag, RefreshCw, List,
  Compass, Square, Ear
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { toast } from 'sonner'
import { SAMPLE_BOOKS } from '@/lib/sample-books'
import { parseEpub, randomCover, PARSER_VERSION } from '@/lib/epub-parser'
import { saveBook, getAllBooks, deleteBook } from '@/lib/library-store'
import { getWatchConfig, saveWatchConfig, updateKnownFiles, clearWatchConfig, saveDirHandle, getDirHandle } from '@/lib/watch-store'
import { defineWord, explainPhrase, moreExamples } from '@/lib/fireworks-client'
import { createNarrator, pickFallbackVoice, SPEED_OPTIONS } from '@/lib/narrator'
import { clearElevenLabsDisabled } from '@/lib/elevenlabs-client'
import ExploreView from '@/components/explore-view'

const STORAGE_KEYS = {
  PROGRESS: 'cozy_progress_v1',
  BOOKMARKS: 'cozy_bookmarks_v1',
  DEF_CACHE: 'cozy_def_cache_v1',
  SETTINGS: 'cozy_settings_v1',
  LAST_BOOK: 'cozy_last_book_v1',
  BOOK_META: 'cozy_book_meta_v1',
  CATEGORIES: 'cozy_categories_v1',
  STATS: 'cozy_stats_v1',
}

// -------------- LocalStorage helpers --------------
const loadLS = (k, fallback) => {
  if (typeof window === 'undefined') return fallback
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
const saveLS = (k, v) => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(k, JSON.stringify(v)) } catch {}
}

// -------------- Fallback offline mini-dictionary --------------
const FALLBACK_DEFS = {
  the: { phonetic: '/ðə/', partOfSpeech: 'article', definition: 'used before a noun to refer to a specific thing.', examples: ['The book is on the table.', 'She saw the moon.'] },
  a: { phonetic: '/ə/', partOfSpeech: 'article', definition: 'used before a noun to refer to any one of a kind.', examples: ['I saw a bird.', 'He bought a car.'] },
}

// -------------- Word tokenizer for tap-to-define --------------
function tokenize(text) {
  const parts = []
  const regex = /([A-Za-z][A-Za-z'-]*)|([^A-Za-z]+)/g
  let m
  while ((m = regex.exec(text)) !== null) {
    if (m[1]) parts.push({ type: 'word', text: m[1] })
    else parts.push({ type: 'space', text: m[2] })
  }
  return parts
}

function normalizePhraseRange(sel) {
  if (!sel) return null
  const { pA, wA, pF, wF } = sel
  if (pF < pA || (pF === pA && wF < wA)) return { pMin: pF, wMin: wF, pMax: pA, wMax: wA }
  return { pMin: pA, wMin: wA, pMax: pF, wMax: wF }
}

function wordInPhraseRange(p, w, range) {
  if (!range) return false
  const { pMin, wMin, pMax, wMax } = range
  if (p < pMin || p > pMax) return false
  if (p === pMin && p === pMax) return w >= wMin && w <= wMax
  if (p === pMin) return w >= wMin
  if (p === pMax) return w <= wMax
  return true
}

/** Paint phrase highlight via DOM so React doesn't re-render (and break pointer capture) on every move. */
function paintPhraseHighlight(root, sel) {
  if (!root) return
  const range = normalizePhraseRange(sel)
  root.querySelectorAll('[data-p][data-w]').forEach((el) => {
    const p = parseInt(el.dataset.p, 10)
    const w = parseInt(el.dataset.w, 10)
    if (wordInPhraseRange(p, w, range)) el.setAttribute('data-phrase-on', '1')
    else el.removeAttribute('data-phrase-on')
  })
  root.querySelectorAll('[data-phrase-space]').forEach((el) => {
    const p = parseInt(el.dataset.p, 10)
    const wBefore = parseInt(el.dataset.wBefore, 10)
    const on =
      range &&
      wordInPhraseRange(p, wBefore, range) &&
      wordInPhraseRange(p, wBefore + 1, range)
    if (on) el.setAttribute('data-phrase-on', '1')
    else el.removeAttribute('data-phrase-on')
  })
}

// ============================================================
// MAIN APP
// ============================================================
function App() {
  const [view, setView] = useState('shelf') // shelf | reader | bookmarks | explore
  const [activeBook, setActiveBook] = useState(null)
  const [progress, setProgress] = useState({})
  const [bookmarks, setBookmarks] = useState([])
  const [defCache, setDefCache] = useState({})
  const [selectedWord, setSelectedWord] = useState(null)
  const [narrateRequest, setNarrateRequest] = useState(null) // { chapterIdx, paraIdx, wordIdx }
  const narrateApiRef = useRef(null)
  const [userBooks, setUserBooks] = useState([])
  const userBooksRef = useRef([])
  const [scanning, setScanning] = useState(null) // { total, done, current }
  const [lastBookId, setLastBookId] = useState(null)
  const [bookMeta, setBookMeta] = useState({}) // { bookId: { category, rating, difficulty } }
  const [customCategories, setCustomCategories] = useState([])
  const [metaEditingBook, setMetaEditingBook] = useState(null) // book being edited
  const watchDirRef = useRef(null) // live FileSystemDirectoryHandle
  const knownFilesRef = useRef({}) // { path: lastModified }
  const pollTimerRef = useRef(null)
  const importedKeysRef = useRef(new Set()) // 'title|author' → skip duplicates
  const [watchFolderName, setWatchFolderName] = useState(null)
  const [watchPolling, setWatchPolling] = useState(false)
  const [newBooksDetected, setNewBooksDetected] = useState(0)
  const [stats, setStats] = useState(() => {
    const today = new Date().toISOString().slice(0, 10)
    return loadLS(STORAGE_KEYS.STATS, { streak: 0, lastReadDate: null, booksStarted: [], todayMinutes: 0, todayDate: today })
  })
  const readingTimerRef = useRef(null)

  useEffect(() => {
    userBooksRef.current = userBooks
  }, [userBooks])

  useEffect(() => {
    setProgress(loadLS(STORAGE_KEYS.PROGRESS, {}))
    setBookmarks(loadLS(STORAGE_KEYS.BOOKMARKS, []))
    setDefCache(loadLS(STORAGE_KEYS.DEF_CACHE, {}))
    setLastBookId(loadLS(STORAGE_KEYS.LAST_BOOK, null))
    setBookMeta(loadLS(STORAGE_KEYS.BOOK_META, {}))
    setCustomCategories(loadLS(STORAGE_KEYS.CATEGORIES, []))
    // Load user's imported books from IndexedDB
    getAllBooks().then(books => {
      setUserBooks(books || [])
      importedKeysRef.current = new Set((books || []).map(b => `${b.title.toLowerCase()}|${b.author.toLowerCase()}`))
    })
    // Warm up voices on iOS
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.getVoices()
    }
    // Load watch folder config from IndexedDB and resume watching
    (async () => {
      const cfg = await getWatchConfig()
      if (!cfg || !cfg.folderName) return
      knownFilesRef.current = cfg.knownFiles || {}
      setWatchFolderName(cfg.folderName)
      const handle = await getDirHandle()
      if (!handle) return
      try {
        const perm = await handle.queryPermission({ mode: 'read' })
        if (perm === 'granted' || perm === 'prompt') {
          if (perm === 'prompt') await handle.requestPermission({ mode: 'read' })
          watchDirRef.current = handle
          startPolling(handle)
        }
      } catch { /* handle no longer valid */ }
    })()
  }, [])

  // Merge original book with user overrides (category/rating/difficulty)
  const applyMeta = useCallback((book) => {
    const meta = bookMeta[book.id]
    if (!meta) return book
    return { ...book, category: meta.category || book.category, rating: meta.rating, difficulty: meta.difficulty }
  }, [bookMeta])

  const saveBookMeta = useCallback((bookId, patch) => {
    setBookMeta(prev => {
      const next = { ...prev, [bookId]: { ...(prev[bookId] || {}), ...patch } }
      // Prune empty entries
      Object.keys(next[bookId]).forEach(k => { if (next[bookId][k] === null || next[bookId][k] === undefined || next[bookId][k] === '') delete next[bookId][k] })
      if (Object.keys(next[bookId]).length === 0) delete next[bookId]
      saveLS(STORAGE_KEYS.BOOK_META, next)
      return next
    })
  }, [])

  const addCategory = useCallback((name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    setCustomCategories(prev => {
      if (prev.some(c => c.toLowerCase() === trimmed.toLowerCase())) return prev
      const next = [...prev, trimmed]
      saveLS(STORAGE_KEYS.CATEGORIES, next)
      return next
    })
  }, [])

  // Collect .epub files from either a DirectoryHandle (Chrome) or FileList (Safari)
  const collectEpubFiles = async (source) => {
    const results = []
    if (source instanceof FileList || Array.isArray(source)) {
      for (const f of source) {
        if (/\.epub$/i.test(f.name)) {
          // Try to derive folder name from webkitRelativePath (from webkitdirectory input)
          const rel = f.webkitRelativePath || ''
          const parts = rel.split('/')
          const folder = parts.length >= 2 ? parts[parts.length - 2] : 'My Books'
          results.push({ file: f, folder })
        }
      }
      return results
    }
    // Directory handle (File System Access API) — recursive scan
    async function walk(dirHandle, path = '') {
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file' && /\.epub$/i.test(entry.name)) {
          const file = await entry.getFile()
          const folder = path.split('/').pop() || dirHandle.name || 'My Books'
          results.push({ file, folder })
        } else if (entry.kind === 'directory') {
          await walk(entry, path ? `${path}/${entry.name}` : entry.name)
        }
      }
    }
    await walk(source)
    return results
  }

  const upsertParsedBook = async (parsed, folder, existingBooks) => {
    const key = `${parsed.title.toLowerCase()}|${parsed.author.toLowerCase()}`
    const titleKey = parsed.title.toLowerCase()
    const shelfMatch = existingBooks.find(
      (b) => b.title.toLowerCase() === titleKey &&
        b.author.toLowerCase() === parsed.author.toLowerCase()
    ) || existingBooks.find(
      (b) => b.title.toLowerCase() === titleKey &&
        (!b.author || b.author === 'Unknown Author' || parsed.author === 'Unknown Author')
    )

    if (shelfMatch) {
      const updated = {
        ...shelfMatch,
        title: parsed.title,
        author: parsed.author,
        category: parsed.category || folder || shelfMatch.category,
        chapters: parsed.chapters,
        coverDataUrl: parsed.coverDataUrl || shelfMatch.coverDataUrl || null,
        parserVersion: parsed.parserVersion || PARSER_VERSION,
        updatedAt: Date.now(),
      }
      await saveBook(updated)
      importedKeysRef.current.add(key)
      return { book: updated, mode: 'updated' }
    }

    if (importedKeysRef.current.has(key)) return null

    importedKeysRef.current.add(key)
    const id = `user_${crypto.randomUUID()}`
    const book = {
      id,
      title: parsed.title,
      author: parsed.author,
      category: parsed.category || folder,
      coverClass: randomCover(id),
      coverDataUrl: parsed.coverDataUrl || null,
      chapters: parsed.chapters,
      parserVersion: parsed.parserVersion || PARSER_VERSION,
      addedAt: Date.now(),
      source: 'user',
    }
    await saveBook(book)
    return { book, mode: 'added' }
  }

  const importFromSource = async (source) => {
    try {
      const files = await collectEpubFiles(source)
      if (files.length === 0) {
        toast.error('No .epub files found in that folder')
        return
      }
      setScanning({ total: files.length, done: 0, current: files[0].file.name })
      const imported = []
      const updated = []
      for (let i = 0; i < files.length; i++) {
        const { file, folder } = files[i]
        setScanning({ total: files.length, done: i, current: file.name })
        try {
          const parsed = await parseEpub(file, folder)
          const result = await upsertParsedBook(parsed, folder, userBooksRef.current)
          if (!result) continue
          if (result.mode === 'updated') updated.push(result.book)
          else imported.push(result.book)
        } catch (e) {
          console.warn('Skipping', file.name, e)
          toast.error(`Could not read "${file.name}"`)
        }
      }
      setScanning(null)
      if (imported.length > 0 || updated.length > 0) {
        const merged = [...updated, ...imported]
        setUserBooks((prev) => {
          const byId = new Map(prev.map((b) => [b.id, b]))
          for (const b of merged) byId.set(b.id, b)
          return Array.from(byId.values())
        })
        setActiveBook((prev) => {
          if (!prev) return prev
          return merged.find((b) => b.id === prev.id) || prev
        })
        const parts = []
        if (imported.length) parts.push(`added ${imported.length}`)
        if (updated.length) parts.push(`updated ${updated.length}`)
        toast.success(`Library ${parts.join(', ')}`)
      }
    } catch (e) {
      setScanning(null)
      console.error(e)
      toast.error('Import failed: ' + (e.message || 'unknown'))
    }
  }

  const pickDirectory = async () => {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) {
      toast.error('Folder picker not supported on this browser. Use "Pick book" instead.')
      return
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' })
      await importFromSource(handle)
      startWatching(handle)
    } catch (e) {
      if (e.name !== 'AbortError') toast.error('Could not open folder')
    }
  }

  const pickFiles = (files) => {
    if (files && files.length) importFromSource(files)
  }

  const removeUserBook = async (id) => {
    const book = userBooks.find(b => b.id === id)
    if (book) importedKeysRef.current.delete(`${book.title.toLowerCase()}|${book.author.toLowerCase()}`)
    await deleteBook(id)
    setUserBooks(prev => prev.filter(b => b.id !== id))
    toast.success('Book removed')
  }

  // Helper: recursively walk a dir handle and populate knownFiles map
  const walkDirForTimestamps = async (dirHandle) => {
    const map = {}
    async function walk(dh, prefix = '') {
      for await (const entry of dh.values()) {
        if (entry.kind === 'file' && /\.epub$/i.test(entry.name)) {
          const file = await entry.getFile()
          map[prefix + entry.name] = file.lastModified
        } else if (entry.kind === 'directory') {
          await walk(entry, prefix + entry.name + '/')
        }
      }
    }
    await walk(dirHandle)
    return map
  }

  // Start a 30-second polling cycle; returns a cleanup function
  const startPolling = useCallback((handle) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    const runScan = async () => {
      setWatchPolling(true)
      try {
        const known = { ...knownFilesRef.current }
        const found = []
        async function walk(dirHandle, prefix = '') {
          for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file' && /\.epub$/i.test(entry.name)) {
              const file = await entry.getFile()
              const key = prefix + entry.name
              if (!known[key] || known[key] !== file.lastModified) {
                const folderName = prefix ? prefix.replace(/\/$/, '').split('/').pop() : handle.name
                found.push({ file, folder: folderName })
              }
              known[key] = file.lastModified
            } else if (entry.kind === 'directory') {
              await walk(entry, prefix + entry.name + '/')
            }
          }
        }
        await walk(handle)
        knownFilesRef.current = known
        updateKnownFiles(known)

        if (found.length > 0) {
          setNewBooksDetected(prev => prev + found.length)
          setScanning({ total: found.length, done: 0, current: found[0].file.name })
          const imported = []
          const updated = []
          for (let i = 0; i < found.length; i++) {
            const { file, folder } = found[i]
            setScanning({ total: found.length, done: i, current: file.name })
            try {
              const parsed = await parseEpub(file, folder)
              const result = await upsertParsedBook(parsed, folder, userBooksRef.current || [])
              if (!result) continue
              if (result.mode === 'updated') updated.push(result.book)
              else imported.push(result.book)
            } catch (e) {
              console.warn('Skipping', file.name, e)
            }
          }
          setScanning(null)
          if (imported.length > 0 || updated.length > 0) {
            setUserBooks((prev) => {
              const byId = new Map(prev.map((b) => [b.id, b]))
              for (const b of updated) byId.set(b.id, b)
              for (const b of imported) byId.set(b.id, b)
              return Array.from(byId.values())
            })
            const parts = []
            if (imported.length) parts.push(`added ${imported.length}`)
            if (updated.length) parts.push(`updated ${updated.length}`)
            toast.success(`From "${handle.name}": ${parts.join(', ')}`)
          }
        }
      } catch (e) {
        console.warn('Watch scan error:', e)
      }
      setWatchPolling(false)
    }
    pollTimerRef.current = setInterval(runScan, 30000)
    runScan() // Immediate first scan
  }, [])

  const startWatching = useCallback(async (handle) => {
    watchDirRef.current = handle
    knownFilesRef.current = await walkDirForTimestamps(handle)
    await saveWatchConfig({ folderName: handle.name, knownFiles: knownFilesRef.current })
    await saveDirHandle(handle)
    setWatchFolderName(handle.name)
    setNewBooksDetected(0)
    startPolling(handle)
    toast.success(`Now watching "${handle.name}" for new books`)
  }, [startPolling])

  const setupWatchFolder = useCallback(async () => {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) {
      toast.error('Folder watching is only supported in Chrome or Edge')
      return
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' })
      await startWatching(handle)
    } catch (e) {
      if (e.name !== 'AbortError') toast.error('Could not open folder')
    }
  }, [startWatching])

  const scanNow = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = setInterval(async () => {
        if (!watchDirRef.current) return
        setWatchPolling(true)
        try {
          const known = { ...knownFilesRef.current }
          const found = []
          async function walk(dirHandle, prefix = '') {
            for await (const entry of dirHandle.values()) {
              if (entry.kind === 'file' && /\.epub$/i.test(entry.name)) {
                const file = await entry.getFile()
                const key = prefix + entry.name
                if (!known[key] || known[key] !== file.lastModified) {
                  found.push({ file, folder: prefix ? prefix.replace(/\/$/, '').split('/').pop() : watchDirRef.current.name })
                }
                known[key] = file.lastModified
              } else if (entry.kind === 'directory') {
                await walk(entry, prefix + entry.name + '/')
              }
            }
          }
          await walk(watchDirRef.current)
          knownFilesRef.current = known
          updateKnownFiles(known)
          if (found.length > 0) {
            setNewBooksDetected(prev => prev + found.length)
            setScanning({ total: found.length, done: 0, current: found[0].file.name })
            const imported = []
            const updated = []
            for (let i = 0; i < found.length; i++) {
              const { file, folder } = found[i]
              setScanning({ total: found.length, done: i, current: file.name })
              try {
                const parsed = await parseEpub(file, folder)
                const result = await upsertParsedBook(parsed, folder, userBooksRef.current)
                if (!result) continue
                if (result.mode === 'updated') updated.push(result.book)
                else imported.push(result.book)
              } catch (e) { console.warn('Skipping', file.name, e) }
            }
            setScanning(null)
            if (imported.length > 0 || updated.length > 0) {
              setUserBooks((prev) => {
                const byId = new Map(prev.map((b) => [b.id, b]))
                for (const b of updated) byId.set(b.id, b)
                for (const b of imported) byId.set(b.id, b)
                return Array.from(byId.values())
              })
              const parts = []
              if (imported.length) parts.push(`added ${imported.length}`)
              if (updated.length) parts.push(`updated ${updated.length}`)
              toast.success(`From "${watchDirRef.current.name}": ${parts.join(', ')}`)
            }
          }
        } catch (e) { console.warn('Watch scan error:', e) }
        setWatchPolling(false)
      }, 30000)
    }
  }, [])

  const stopWatching = useCallback(async () => {
    watchDirRef.current = null
    knownFilesRef.current = {}
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null }
    setWatchFolderName(null)
    setNewBooksDetected(0)
    setWatchPolling(false)
    await clearWatchConfig()
    toast.success('Stopped watching folder')
  }, [])


  // Stats helper
  const bumpStats = useCallback((bookId) => {
    setStats(prev => {
      const today = new Date().toISOString().slice(0, 10)
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

      let streak = prev.streak || 0
      const last = prev.lastReadDate
      if (last === today) { /* already read today, streak unchanged */ }
      else if (last === yesterday) streak += 1
      else streak = 1

      const booksStarted = prev.booksStarted || []
      const newBooksStarted = booksStarted.includes(bookId) ? booksStarted : [...booksStarted, bookId]

      const todayMinutes = prev.todayDate === today ? (prev.todayMinutes || 0) : 0

      const next = { streak, lastReadDate: today, booksStarted: newBooksStarted, todayMinutes, todayDate: today }
      saveLS(STORAGE_KEYS.STATS, next)
      return next
    })
  }, [])

  const openBook = (book) => {
    setActiveBook(book)
    setView('reader')
    setLastBookId(book.id)
    saveLS(STORAGE_KEYS.LAST_BOOK, book.id)
    bumpStats(book.id)
    window.scrollTo(0, 0)
  }
  const closeBook = () => {
    setActiveBook(null)
    setView('shelf')
  }

  // Bottom nav "Read" handler
  const goToReader = useCallback(() => {
    const all = [...userBooks, ...SAMPLE_BOOKS]
    if (all.length === 0) {
      // No books yet — just go to the shelf so the empty state prompts to add
      setView('shelf')
      return
    }
    let book = lastBookId ? all.find(b => b.id === lastBookId) : null
    if (!book) {
      const sorted = Object.entries(progress)
        .map(([id, p]) => ({ book: all.find(b => b.id === id), p }))
        .filter(x => x.book)
        .sort((a, b) => (b.p.lastRead || 0) - (a.p.lastRead || 0))
      if (sorted.length) book = sorted[0].book
    }
    if (!book) book = all[0]
    if (book) openBook(book)
  }, [lastBookId, userBooks, progress]) // eslint-disable-line

  const updateProgress = useCallback((bookId, patch) => {
    setProgress(prev => {
      const next = { ...prev, [bookId]: { ...(prev[bookId] || {}), ...patch, lastRead: Date.now() } }
      saveLS(STORAGE_KEYS.PROGRESS, next)
      return next
    })
  }, [])

  const addBookmark = useCallback((bm) => {
    setBookmarks(prev => {
      const filtered = prev.filter(b => !(b.word === bm.word && b.bookId === bm.bookId))
      const next = [{ ...bm, id: crypto.randomUUID(), createdAt: Date.now() }, ...filtered]
      saveLS(STORAGE_KEYS.BOOKMARKS, next)
      return next
    })
    toast.success(`Saved "${bm.word}" to your bookmarks`, { duration: 1800 })
  }, [])

  const removeBookmark = useCallback((id) => {
    setBookmarks(prev => {
      const next = prev.filter(b => b.id !== id)
      saveLS(STORAGE_KEYS.BOOKMARKS, next)
      return next
    })
  }, [])

  const cacheDef = useCallback((word, def) => {
    setDefCache(prev => {
      const next = { ...prev, [word.toLowerCase()]: { ...def, cachedAt: Date.now() } }
      saveLS(STORAGE_KEYS.DEF_CACHE, next)
      return next
    })
  }, [])

  const allBooks = useMemo(() => {
    const raw = [...userBooks, ...SAMPLE_BOOKS]
    return raw.map(applyMeta)
  }, [userBooks, applyMeta])

  // All categories present in books (original + overrides) plus custom ones the user created
  const allCategories = useMemo(() => {
    const set = new Set()
    allBooks.forEach(b => set.add(b.category))
    customCategories.forEach(c => set.add(c))
    return Array.from(set)
  }, [allBooks, customCategories])

  // Reading timer: tick every minute while in reader view
  useEffect(() => {
    if (view !== 'reader') return
    readingTimerRef.current = setInterval(() => {
      setStats(prev => {
        const today = new Date().toISOString().slice(0, 10)
        const base = prev.todayDate === today ? (prev.todayMinutes || 0) : 0
        const next = { ...prev, todayMinutes: base + 1, todayDate: today }
        saveLS(STORAGE_KEYS.STATS, next)
        return next
      })
    }, 60000)
    return () => { if (readingTimerRef.current) clearInterval(readingTimerRef.current) }
  }, [view])

  return (
    <div className="min-h-screen bg-background">
      <AnimatePresence mode="wait">
        {view === 'shelf' && (
          <motion.div key="shelf" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <BookshelfView
              books={allBooks}
              progress={progress}
              onOpenBook={openBook}
              bookmarkCount={bookmarks.length}
              stats={stats}
              onPickDirectory={pickDirectory}
              onPickFiles={pickFiles}
              onRemoveBook={removeUserBook}
              scanning={scanning}
              onEditMeta={setMetaEditingBook}
              watchConfig={watchFolderName}
              watchPolling={watchPolling}
              newBooksDetected={newBooksDetected}
              onSetupWatch={setupWatchFolder}
              onStopWatch={stopWatching}
              onScanNow={scanNow}
            />
          </motion.div>
        )}
        {view === 'reader' && activeBook && (
          <motion.div key="reader" initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'tween', duration: 0.3 }}>
            <ReaderView
              book={activeBook}
              progress={progress[activeBook.id]}
              onUpdateProgress={(patch) => updateProgress(activeBook.id, patch)}
              onClose={closeBook}
              onSelectWord={setSelectedWord}
              bookmarks={bookmarks}
              narrateRequest={narrateRequest}
              onNarrateRequestHandled={() => setNarrateRequest(null)}
              narrateApiRef={narrateApiRef}
            />
          </motion.div>
        )}
        {view === 'bookmarks' && (
          <motion.div key="bookmarks" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <BookmarksView
              bookmarks={bookmarks}
              onBack={() => setView('shelf')}
              onRemove={removeBookmark}
              onOpenBook={(bookId) => {
                const book = allBooks.find(b => b.id === bookId)
                if (book) openBook(book)
              }}
            />
          </motion.div>
        )}
        {view === 'explore' && (
          <motion.div key="explore" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <ExploreView
              existingBooks={userBooks}
              onImported={async ({ parsed, difficulty }) => {
                const result = await upsertParsedBook(parsed, 'Gutenberg', userBooksRef.current)
                if (!result) {
                  toast.message('Already on your shelf')
                  return
                }
                const book = result.book
                setUserBooks((prev) => {
                  const byId = new Map(prev.map((b) => [b.id, b]))
                  byId.set(book.id, book)
                  return Array.from(byId.values())
                })
                if (typeof difficulty === 'number') {
                  saveBookMeta(book.id, {
                    category: 'Gutenberg',
                    difficulty,
                    rating: bookMeta[book.id]?.rating ?? null,
                  })
                }
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <DefinitionPanel
        selection={selectedWord}
        onClose={() => setSelectedWord(null)}
        cache={defCache}
        onCache={cacheDef}
        onBookmark={addBookmark}
        bookmarks={bookmarks}
        onReadFromHere={(sel) => {
          const chapterIdx = sel.chapterIdx ?? 0
          const paraIdx = sel.paraIdx ?? 0
          const wordIdx = sel.wordIdx ?? 0
          // Start narration BEFORE closing the panel (same user gesture). Closing the panel
          // must not tear down the narrator (see ReaderView effect deps).
          const played = narrateApiRef.current?.playFromPosition?.(chapterIdx, paraIdx, wordIdx)
          if (!played) {
            setNarrateRequest({ chapterIdx, paraIdx, wordIdx, nonce: Date.now() })
          }
          setSelectedWord(null)
        }}
      />

      <BookMetaSheet
        book={metaEditingBook}
        onClose={() => setMetaEditingBook(null)}
        onSave={(patch) => {
          if (metaEditingBook) saveBookMeta(metaEditingBook.id, patch)
        }}
        allCategories={allCategories}
        onAddCategory={addCategory}
      />

      {/* Bottom nav + FAB (hidden while reading) */}
      {view !== 'reader' && (
        <>
          <AddFab onPickDirectory={pickDirectory} onPickFiles={pickFiles} />
          <BottomNav
          current={view}
          onGoShelf={() => setView('shelf')}
          onGoRead={goToReader}
          onGoBookmarks={() => setView('bookmarks')}
          onGoExplore={() => setView('explore')}
          hasLastBook={!!lastBookId || Object.keys(progress).length > 0}
          bookmarkCount={bookmarks.length}
        />
        </>
      )}
    </div>
  )
}

// ============================================================
// BOTTOM NAV BAR
// ============================================================
function AddFab({ onPickDirectory, onPickFiles }) {
  const [open, setOpen] = useState(false)
  const filesRef = useRef(null)

  const handlePickFiles = () => {
    setOpen(false)
    filesRef.current?.click()
  }

  const handlePickFolder = () => {
    setOpen(false)
    onPickDirectory()
  }

  return (
    <>
      <input
        ref={filesRef}
        type="file"
        accept=".epub,application/epub+zip"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { onPickFiles(e.target.files); e.target.value = '' }}
        suppressHydrationWarning
      />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="fixed bottom-40 right-5 z-40 flex flex-col items-end gap-2"
          >
            <button
              onClick={handlePickFolder}
              className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-card border border-border shadow-lg hover:bg-primary/10 transition-colors"
            >
              <div className="w-9 h-9 rounded-full bg-primary/20 grid place-items-center">
                <FolderOpen className="w-4 h-4 text-secondary" />
              </div>
              <span className="text-sm font-medium whitespace-nowrap">Choose folder</span>
            </button>
            <button
              onClick={handlePickFiles}
              className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-card border border-border shadow-lg hover:bg-primary/10 transition-colors"
            >
              <div className="w-9 h-9 rounded-full bg-primary/20 grid place-items-center">
                <FileUp className="w-4 h-4 text-secondary" />
              </div>
              <span className="text-sm font-medium whitespace-nowrap">Pick book</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={() => setOpen(prev => !prev)}
        className={`fixed bottom-[5.5rem] right-5 z-40 w-14 h-14 rounded-full bg-secondary text-white grid place-items-center shadow-lg hover:shadow-xl transition-shadow ${open ? 'rotate-45' : ''}`}
        aria-label="Add books"
      >
        <Plus className="w-6 h-6 transition-transform duration-200" style={{ transform: open ? 'rotate(0deg)' : 'rotate(0deg)' }} />
      </motion.button>
    </>
  )
}

function BottomNav({ current, onGoShelf, onGoRead, onGoBookmarks, onGoExplore, hasLastBook, bookmarkCount }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 safe-bottom border-t border-border/60 bg-background/95 backdrop-blur-md">
      <div className="max-w-md mx-auto flex items-stretch justify-around px-1 pt-1 pb-1">
        <NavTab
          active={current === 'shelf'}
          onClick={onGoShelf}
          icon={<Library className="w-6 h-6" strokeWidth={2.2} />}
          label="Bookshelf"
        />
        <NavTab
          active={current === 'reader'}
          onClick={onGoRead}
          icon={<Book className="w-6 h-6" strokeWidth={2.2} />}
          label={hasLastBook ? 'Read' : 'Start'}
        />
        <NavTab
          active={current === 'explore'}
          onClick={onGoExplore}
          icon={<Compass className="w-6 h-6" strokeWidth={2.2} />}
          label="Explore"
        />
        <NavTab
          active={current === 'bookmarks'}
          onClick={onGoBookmarks}
          icon={<Bookmark className="w-6 h-6" strokeWidth={2.2} />}
          label="Words"
          badge={bookmarkCount > 0 ? bookmarkCount : null}
        />
      </div>
    </nav>
  )
}

function NavTab({ active, onClick, icon, label, badge }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[52px] py-2 px-1 rounded-xl transition-colors relative ${
        active ? 'text-secondary' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <div className={`relative ${active ? 'scale-110 transition-transform' : ''}`}>
        {icon}
        {badge != null && (
          <span className="absolute -top-1.5 -right-2 bg-secondary text-white text-[9px] font-semibold rounded-full min-w-[16px] h-[16px] px-1 grid place-items-center">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </div>
      <span className={`text-[10.5px] font-medium tracking-tight ${active ? 'text-secondary' : ''}`}>{label}</span>
      {active && (
        <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-secondary" />
      )}
    </button>
  )
}

// ============================================================
// BOOKSHELF VIEW
// ============================================================
function BookshelfView({ books, progress, onOpenBook, bookmarkCount, onPickDirectory, onPickFiles, onRemoveBook, scanning, onEditMeta, watchConfig: watchFolderName, watchPolling, newBooksDetected, onSetupWatch, onStopWatch, onScanNow, stats }) {
  const [showAddSheet, setShowAddSheet] = useState(false)
  const [scanAnimating, setScanAnimating] = useState(false)
  const filesInputRef = useRef(null)
  const folderInputRef = useRef(null)

  const grouped = useMemo(() => {
    const g = {}
    books.forEach(b => {
      const key = b.category || 'Uncategorized'
      if (!g[key]) g[key] = []
      g[key].push(b)
    })
    return g
  }, [books])

  const continueReading = useMemo(() => {
    return Object.entries(progress)
      .map(([id, p]) => ({ book: books.find(b => b.id === id), progress: p }))
      .filter(x => x.book)
      .sort((a, b) => (b.progress.lastRead || 0) - (a.progress.lastRead || 0))
      .slice(0, 3)
  }, [progress, books])

  const hasFSA = typeof window !== 'undefined' && !!window.showDirectoryPicker

  return (
    <div className="min-h-screen">
      <header className="safe-top px-5 pb-4 pt-6 sticky top-0 z-30 backdrop-blur-md bg-background/85 border-b border-border/40">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-primary/25 grid place-items-center">
              <BookOpen className="w-5 h-5 text-secondary" strokeWidth={2.2} />
            </div>
            <div>
              <h1 className="font-serif-cozy text-xl font-semibold text-foreground leading-none">Danini&apos;s Bookshelf</h1>
              <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                <Heart className="w-2.5 h-2.5 fill-current text-primary/70" /> one word at a time
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 pb-32 pt-2 safe-bottom">
        {watchFolderName && (
          <div className="mt-3 mb-1 flex flex-col sm:flex-row sm:items-center gap-2 text-xs text-muted-foreground bg-primary/5 rounded-xl px-4 py-2.5 border border-primary/15">
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${watchPolling ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
              <span className="font-medium">Watching </span>
              <span className="text-foreground font-semibold truncate max-w-[160px] sm:hidden">{watchFolderName}</span>
            </div>
            <span className="text-foreground font-semibold truncate max-w-[200px] hidden sm:inline">{watchFolderName}</span>
            <span className="text-muted-foreground/60">— new .epub files are auto-imported</span>
            <div className="sm:ml-auto flex items-center gap-2">
              <button
                onClick={() => {
                  setScanAnimating(true)
                  onScanNow()
                  setTimeout(() => setScanAnimating(false), 1500)
                }}
                disabled={watchPolling}
                className="flex items-center gap-1 text-secondary hover:underline disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${scanAnimating ? 'animate-spin' : ''}`} />
                Scan now
              </button>
              <button
                onClick={onStopWatch}
                className="px-2.5 py-1 rounded-full text-[11px] font-medium border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
              >
                Stop watching
              </button>
            </div>
          </div>
        )}
        {newBooksDetected > 0 && !scanning && (
          <div className="mt-2 mb-1 text-xs text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 rounded-xl px-4 py-2 border border-emerald-200 dark:border-emerald-800/50">
            {newBooksDetected} new book{newBooksDetected !== 1 ? 's' : ''} auto-imported — scroll to find them below!
          </div>
        )}
        {books.length > 0 && stats && (
          <section className="mt-4 mb-6">
            <h2 className="font-serif-cozy text-sm font-medium text-muted-foreground uppercase tracking-widest mb-3 px-1 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> Your stats
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="paper-texture rounded-2xl border border-border/60 p-4 text-center">
                <div className="text-3xl font-serif-cozy font-bold text-secondary">{typeof stats.streak === 'number' ? stats.streak : 0}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">Day streak</div>
              </div>
              <div className="paper-texture rounded-2xl border border-border/60 p-4 text-center">
                <div className="text-3xl font-serif-cozy font-bold text-secondary">{stats.booksStarted?.length || 0}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">Books started</div>
              </div>
              <div className="paper-texture rounded-2xl border border-border/60 p-4 text-center">
                <div className="text-3xl font-serif-cozy font-bold text-secondary">{bookmarkCount}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">Words saved</div>
              </div>
              <div className="paper-texture rounded-2xl border border-border/60 p-4 text-center">
                <div className="text-3xl font-serif-cozy font-bold text-secondary">{stats.todayMinutes || 0}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">Min read today</div>
              </div>
            </div>
          </section>
        )}
        {books.length === 0 && !scanning && (
          <div className="mt-16 text-center">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
              className="w-20 h-20 mx-auto rounded-full bg-primary/20 grid place-items-center mb-5"
            >
              <BookOpen className="w-9 h-9 text-secondary" strokeWidth={1.8} />
            </motion.div>
            <h2 className="font-serif-cozy text-2xl font-semibold">Your shelf is waiting</h2>
            <p className="text-sm text-muted-foreground mt-2 max-w-xs mx-auto leading-relaxed">
              Add a few <span className="font-medium text-secondary">.epub</span> books to start reading — everything stays on your device.
            </p>
            <Button
              onClick={() => setShowAddSheet(true)}
              className="mt-6 rounded-full bg-secondary hover:bg-secondary/90 text-white px-6 h-11 font-medium"
            >
              <Plus className="w-4 h-4 mr-1.5" /> Add your first book
            </Button>
            <div className="mt-10 flex items-center justify-center gap-2 text-muted-foreground/70">
              <div className="h-px w-8 bg-primary/40" />
              <Heart className="w-3.5 h-3.5 fill-current text-primary/70" />
              <div className="h-px w-8 bg-primary/40" />
            </div>
            <p className="font-serif-cozy italic text-xs text-muted-foreground/80 mt-3">
              made with love for Dani
            </p>
          </div>
        )}

        {continueReading.length > 0 && (
          <section className="mt-6 mb-8">
            <h2 className="font-serif-cozy text-sm font-medium text-muted-foreground uppercase tracking-widest mb-3 px-1 flex items-center gap-1.5">
              <Coffee className="w-3.5 h-3.5" /> Continue reading
            </h2>
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-5 px-5 snap-x">
              {continueReading.map(({ book, progress: p }) => (
                <ContinueCard key={book.id} book={book} progress={p} onOpen={() => onOpenBook(book)} />
              ))}
            </div>
          </section>
        )}

        {Object.entries(grouped).map(([category, categoryBooks]) => (
          <section key={category} className="mb-8">
            <h2 className="font-serif-cozy text-sm font-medium text-muted-foreground uppercase tracking-widest mb-4 px-1">
              {category}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {categoryBooks.map(book => (
                <BookCard
                  key={book.id}
                  book={book}
                  progress={progress[book.id]}
                  onOpen={() => onOpenBook(book)}
                  onEdit={() => onEditMeta(book)}
                  onRemove={book.source === 'user' ? () => onRemoveBook(book.id) : null}
                />
              ))}
            </div>
          </section>
        ))}

        <div className={`mt-12 text-center text-muted-foreground/80 ${books.length === 0 ? 'hidden' : ''}`}>
          <Sparkles className="w-5 h-5 mx-auto mb-2 text-primary/60" />
          <p className="font-serif-cozy italic text-sm">Tap any word while reading to discover its meaning.</p>
        </div>
      </main>

      {/* Hidden inputs for file/folder pickers */}
      <input
        ref={filesInputRef}
        type="file"
        accept=".epub,application/epub+zip"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { onPickFiles(e.target.files); e.target.value = ''; setShowAddSheet(false) }}
        suppressHydrationWarning
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        style={{ display: 'none' }}
        onChange={(e) => { onPickFiles(e.target.files); e.target.value = ''; setShowAddSheet(false) }}
        suppressHydrationWarning
      />

      {/* Add books sheet */}
      <AddBooksSheet
        open={showAddSheet}
        onClose={() => setShowAddSheet(false)}
        hasFSA={hasFSA}
        onPickDirectory={() => { setShowAddSheet(false); onPickDirectory() }}
        onPickFolderInput={() => folderInputRef.current?.click()}
        onPickFiles={() => filesInputRef.current?.click()}
      />

      {/* Scanning overlay */}
      <AnimatePresence>
        {scanning && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-foreground/40 z-50 grid place-items-center backdrop-blur-sm"
          >
            <Card className="paper-texture border border-border/60 rounded-2xl p-6 shadow-2xl max-w-xs w-[85%]">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <div className="flex-1 min-w-0">
                  <div className="font-serif-cozy text-sm font-semibold">Reading your books...</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{scanning.current}</div>
                </div>
              </div>
              <div className="mt-3 h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${(scanning.done / scanning.total) * 100}%` }} />
              </div>
              <div className="text-[11px] text-muted-foreground mt-1.5">{scanning.done} of {scanning.total}</div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================================
// BOOK META SHEET (category / rating / difficulty)
// ============================================================
function BookMetaSheet({ book, onClose, onSave, allCategories, onAddCategory }) {
  const [category, setCategory] = useState('')
  const [rating, setRating] = useState(0)
  const [difficulty, setDifficulty] = useState(1)
  const [newCat, setNewCat] = useState('')
  const [showNewCat, setShowNewCat] = useState(false)

  useEffect(() => {
    if (book) {
      setCategory(book.category || '')
      setRating(typeof book.rating === 'number' ? book.rating : 0)
      setDifficulty(typeof book.difficulty === 'number' ? book.difficulty : 1)
      setNewCat('')
      setShowNewCat(false)
    }
  }, [book])

  const handleSave = () => {
    onSave({
      category: category || null,
      rating: rating > 0 ? Math.round(rating * 10) / 10 : null,
      difficulty: difficulty > 0 ? Math.round(difficulty * 10) / 10 : null,
    })
    toast.success('Saved')
    onClose()
  }

  const handleAddCategory = () => {
    const t = newCat.trim()
    if (!t) return
    onAddCategory(t)
    setCategory(t)
    setNewCat('')
    setShowNewCat(false)
  }

  return (
    <AnimatePresence>
      {book && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-foreground/25 z-40 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.3 }}
            onDragEnd={(_, info) => { if (info.offset.y > 120 || info.velocity.y > 500) onClose() }}
            className="fixed left-0 right-0 bottom-0 z-50 paper-texture rounded-t-[28px] shadow-2xl border-t border-border/60 safe-bottom max-h-[90vh] flex flex-col"
          >
            <div className="pt-2.5 pb-1 grid place-items-center">
              <div className="w-11 h-1.5 rounded-full bg-muted-foreground/30" />
            </div>

            <div className="px-6 pt-2 pb-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground/80">Organize book</div>
                <h3 className="font-serif-cozy text-2xl font-semibold leading-tight mt-0.5 line-clamp-2">{book.title}</h3>
                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{book.author}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose} className="h-12 w-12 rounded-full hover:bg-primary/20 flex-shrink-0" aria-label="Close">
                <X className="w-5 h-5 text-secondary" />
              </Button>
            </div>

            <div className="px-6 pb-6 overflow-y-auto flex-1 space-y-6">
              {/* Category */}
              <section>
                <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/80 mb-2 flex items-center gap-1.5">
                  <Tag className="w-3 h-3" /> Category
                </div>
                <div className="flex flex-wrap gap-2">
                  {allCategories.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(c)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                        category === c
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card border-border/70 hover:bg-primary/10'
                      }`}
                    >
                      {category === c && <Check className="w-3 h-3 inline mr-1 -mt-0.5" />}
                      {c}
                    </button>
                  ))}
                  {!showNewCat && (
                    <button
                      type="button"
                      onClick={() => setShowNewCat(true)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium border border-dashed border-primary/60 text-secondary hover:bg-primary/10 flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" /> New
                    </button>
                  )}
                </div>
                {showNewCat && (
                  <div className="mt-3 flex gap-2">
                    <Input
                      autoFocus
                      value={newCat}
                      onChange={(e) => setNewCat(e.target.value)}
                      placeholder="e.g. Romance, Historical, Learning..."
                      onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
                      className="flex-1 rounded-full text-sm h-9"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleAddCategory}
                      disabled={!newCat.trim()}
                      className="rounded-full bg-primary hover:bg-primary/90"
                    >
                      Add
                    </Button>
                  </div>
                )}
              </section>

              {/* Rating slider */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/80 flex items-center gap-1.5">
                    <Star className="w-3 h-3" /> Your rating
                  </div>
                  <div className="flex items-center gap-1.5 text-secondary font-serif-cozy">
                    <StarRow value={rating} />
                    <span className="text-lg font-semibold min-w-[40px] text-right">
                      {rating > 0 ? rating.toFixed(1) : '—'}
                    </span>
                  </div>
                </div>
                <Slider
                  min={0}
                  max={5}
                  step={0.1}
                  value={[rating]}
                  onValueChange={(v) => setRating(v[0])}
                  className="mt-3"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5 font-medium">
                  <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
                </div>
              </section>

              {/* Difficulty slider */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/80 flex items-center gap-1.5">
                    <Flame className="w-3 h-3" /> Difficulty
                  </div>
                  <div className="flex items-center gap-1.5 text-secondary font-serif-cozy">
                    <FlameRow value={difficulty} />
                    <span className="text-lg font-semibold min-w-[40px] text-right">
                      {difficulty.toFixed(1)}
                    </span>
                  </div>
                </div>
                <Slider
                  min={1}
                  max={5}
                  step={0.1}
                  value={[difficulty]}
                  onValueChange={(v) => setDifficulty(v[0])}
                  className="mt-3"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5 font-medium">
                  <span>Very easy</span><span>Easy</span><span>Medium</span><span>Hard</span><span>Very hard</span>
                </div>
              </section>

              <Button
                onClick={handleSave}
                className="w-full rounded-full bg-secondary hover:bg-secondary/90 text-white h-11 font-medium"
              >
                Save changes
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// Filled/half/empty stars visualization for rating (0-5, 0.1 precision)
function StarRow({ value }) {
  const stars = []
  for (let i = 1; i <= 5; i++) {
    let fill = 0
    if (value >= i) fill = 100
    else if (value > i - 1) fill = Math.round((value - (i - 1)) * 100)
    stars.push(
      <span key={i} className="relative inline-block w-4 h-4">
        <Star className="absolute inset-0 w-4 h-4 text-muted-foreground/40" />
        <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill}%` }}>
          <Star className="w-4 h-4 text-primary fill-primary" />
        </span>
      </span>
    )
  }
  return <div className="flex gap-0.5">{stars}</div>
}

function FlameRow({ value }) {
  const flames = []
  for (let i = 1; i <= 5; i++) {
    let fill = 0
    if (value >= i) fill = 100
    else if (value > i - 1) fill = Math.round((value - (i - 1)) * 100)
    flames.push(
      <span key={i} className="relative inline-block w-4 h-4">
        <Flame className="absolute inset-0 w-4 h-4 text-muted-foreground/40" />
        <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill}%` }}>
          <Flame className="w-4 h-4 text-primary fill-primary/50" />
        </span>
      </span>
    )
  }
  return <div className="flex gap-0.5">{flames}</div>
}

function AddBooksSheet({ open, onClose, hasFSA, onPickDirectory, onPickFolderInput, onPickFiles, onSetupWatch }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-foreground/25 z-40 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="fixed left-0 right-0 bottom-0 z-50 paper-texture rounded-t-[28px] shadow-2xl border-t border-border/60 safe-bottom"
          >
            <div className="pt-2.5 pb-1 grid place-items-center">
              <div className="w-11 h-1.5 rounded-full bg-muted-foreground/30" />
            </div>
            <div className="px-6 pt-3 pb-8">
              <h2 className="font-serif-cozy text-2xl font-semibold leading-tight">Add your books</h2>
              <p className="text-sm text-muted-foreground mt-1">Where do you keep your <span className="font-medium">.epub</span> files?</p>

              <div className="mt-5 space-y-2.5">
                {hasFSA && (
                  <button
                    onClick={onPickDirectory}
                    className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl border border-border bg-card hover:bg-primary/10 transition-colors text-left"
                  >
                    <div className="w-11 h-11 rounded-full bg-primary/20 grid place-items-center flex-shrink-0">
                      <FolderOpen className="w-5 h-5 text-secondary" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-serif-cozy text-base font-semibold leading-tight">Choose a folder</div>
                      <div className="text-xs text-muted-foreground mt-0.5">Imports your books & watches for new ones automatically</div>
                    </div>
                  </button>
                )}
                {!hasFSA && (
                  <button
                    onClick={onPickFolderInput}
                    className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl border border-border bg-card hover:bg-primary/10 transition-colors text-left"
                  >
                    <div className="w-11 h-11 rounded-full bg-primary/20 grid place-items-center flex-shrink-0">
                      <FolderOpen className="w-5 h-5 text-secondary" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-serif-cozy text-base font-semibold leading-tight">Choose a folder</div>
                      <div className="text-xs text-muted-foreground mt-0.5">Desktop only — books group by subfolder</div>
                    </div>
                  </button>
                )}

                <button
                  onClick={onPickFiles}
                  className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl border border-border bg-card hover:bg-primary/10 transition-colors text-left"
                >
                  <div className="w-11 h-11 rounded-full bg-primary/20 grid place-items-center flex-shrink-0">
                    <FileUp className="w-5 h-5 text-secondary" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-serif-cozy text-base font-semibold leading-tight">Pick a book</div>
                    <div className="text-xs text-muted-foreground mt-0.5">Best on iPhone and iPad — tap to select .epub files</div>
                  </div>
                </button>
              </div>

              <p className="text-[11px] text-muted-foreground/80 mt-5 font-serif-cozy italic text-center">
                Your books stay on this device — nothing gets uploaded.
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function BookCard({ book, progress, onOpen, onEdit, onRemove }) {
  const percent = progress?.percent || 0
  const lastRead = progress?.lastRead
    ? new Date(progress.lastRead).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null
  const handleRemove = (e) => {
    e.stopPropagation()
    if (confirm(`Remove "${book.title}" from your shelf?`)) onRemove()
  }
  const handleEdit = (e) => {
    e.stopPropagation()
    onEdit()
  }
  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
  }
  const hasRating = typeof book.rating === 'number'
  const hasDifficulty = typeof book.difficulty === 'number'
  return (
    <motion.div
      whileTap={{ scale: 0.97 }}
      onClick={onOpen}
      onKeyDown={handleKey}
      role="button"
      tabIndex={0}
      className="text-left group focus:outline-none relative cursor-pointer"
    >
      <div className={`aspect-[2/3] rounded-2xl ${book.coverDataUrl ? 'bg-muted' : book.coverClass} shadow-md relative overflow-hidden`}>
        {book.coverDataUrl ? (
          <img src={book.coverDataUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-black/20" />
        )}
        <div className={`absolute inset-0 p-3 flex flex-col justify-between text-white ${book.coverDataUrl ? 'bg-gradient-to-t from-black/70 via-black/10 to-black/30' : ''}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="text-[10px] uppercase tracking-widest opacity-70 font-medium line-clamp-1">{book.category}</div>
          </div>
          <div>
            <div className="font-serif-cozy text-base leading-tight font-semibold drop-shadow line-clamp-3">{book.title}</div>
            <div className="text-[11px] opacity-85 mt-1 line-clamp-1">{book.author}</div>
          </div>
        </div>
        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-black/25" />
        {percent > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        )}
        {/* Top-right action icons */}
        <div className="absolute top-2 right-2 flex gap-1">
          <button
            type="button"
            onClick={handleEdit}
              className="w-12 h-12 rounded-full bg-black/40 hover:bg-black/60 grid place-items-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
              aria-label="Edit book"
            >
              <Settings2 className="w-6 h-6 text-white" />
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={handleRemove}
              className="w-12 h-12 rounded-full bg-black/40 hover:bg-black/60 grid place-items-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
              aria-label="Remove book"
            >
              <Trash2 className="w-6 h-6 text-white" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 px-0.5">
        <div className="text-sm font-medium leading-tight line-clamp-1">{book.title}</div>
        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{book.author}</div>
        {(hasRating || hasDifficulty) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {hasRating && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-secondary bg-primary/15 px-1.5 py-0.5 rounded-full">
                <Star className="w-3 h-3 fill-current" />
                {book.rating.toFixed(1)}
              </span>
            )}
            {hasDifficulty && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-secondary bg-accent/40 px-1.5 py-0.5 rounded-full">
                <Flame className="w-3 h-3" />
                {book.difficulty.toFixed(1)}
              </span>
            )}
          </div>
        )}
        {lastRead && (
          <div className="text-[10px] text-muted-foreground/70 mt-1">{lastRead}</div>
        )}
      </div>
    </motion.div>
  )
}

function ContinueCard({ book, progress, onOpen }) {
  const percent = progress?.percent || 0
  const lastRead = progress?.lastRead ? new Date(progress.lastRead).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onOpen}
      className="snap-start flex-shrink-0 w-[260px] text-left focus:outline-none"
    >
      <Card className="paper-texture border border-border/60 rounded-2xl overflow-hidden shadow-sm">
        <div className={`h-14 ${book.coverClass} relative`}>
          <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent" />
          <div className="absolute inset-0 px-4 grid place-items-center">
            <div className="text-white font-serif-cozy text-sm font-semibold drop-shadow line-clamp-1">{book.title}</div>
          </div>
        </div>
        <div className="p-4">
          <div className="font-serif-cozy text-base font-semibold leading-tight">{book.title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{book.author}</div>
          <div className="mt-3 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${percent}%` }} />
          </div>
          <div className="text-[11px] text-muted-foreground mt-1.5">Last read {lastRead}</div>
        </div>
      </Card>
    </motion.button>
  )
}

// ============================================================
// READER VIEW
// ============================================================
function ReaderView({ book, progress, onUpdateProgress, onClose, onSelectWord, bookmarks, narrateRequest, onNarrateRequestHandled, narrateApiRef }) {
  const [chapterIdx, setChapterIdx] = useState(progress?.chapter || 0)
  const [fontSize, setFontSize] = useState(loadLS(STORAGE_KEYS.SETTINGS, {})?.fontSize || 20)
  const [voiceRate, setVoiceRate] = useState(() => {
    const r = loadLS(STORAGE_KEYS.SETTINGS, {})?.voiceRate
    return SPEED_OPTIONS.includes(r) ? r : 1
  })
  const [player, setPlayer] = useState({ playing: false, paused: false, loading: false, visible: false, wordIndex: 0, totalWords: 0, provider: 'webspeech', rate: 1 })
  const [speakingWord, setSpeakingWord] = useState(null)
  const [selecting, setSelecting] = useState(false) // phrase drag active (highlights painted via DOM)
  const [tocOpen, setTocOpen] = useState(false)
  const scrollRef = useRef(null)
  const articleRef = useRef(null)
  const barRef = useRef(null)
  const percentTextRef = useRef(null)
  const longPressTimerRef = useRef(null)
  const pointerStartRef = useRef(null)
  const phraseSelRef = useRef(null) // { pA, wA, pF, wF } during drag — avoid React re-renders
  const autoScrollRafRef = useRef(null)
  const lastPointerYRef = useRef(0)
  const suppressClickRef = useRef(false)
  const narratorRef = useRef(null)
  const chapterIdxRef = useRef(chapterIdx)
  chapterIdxRef.current = chapterIdx
  const onUpdateProgressRef = useRef(onUpdateProgress)
  onUpdateProgressRef.current = onUpdateProgress
  const preparingVoice = !!player.loading
  const readingAloud = player.playing && !player.paused && !preparingVoice
  const playerVisible = player.visible
  useEffect(() => {
    if (chapterIdx >= book.chapters.length) {
      setChapterIdx(Math.max(0, book.chapters.length - 1))
    }
  }, [book.chapters.length, chapterIdx])

  const chapter = book.chapters[Math.min(chapterIdx, book.chapters.length - 1)] || book.chapters[0]
  const hasMultipleChapters = book.chapters.length > 1
  const chapterLabel = (ch, idx) => {
    const t = (ch?.title || '').trim()
    if (!t) return `Chapter ${idx + 1}`
    if (/^(chapter|part|book|dedication|front matter)\b/i.test(t)) return t
    if (/^[IVXLCDM]+$/i.test(t) || /^\d+$/.test(t)) return `Chapter ${t}`
    return t
  }

  // Helper: get text content from paragraph item (handles old string format too)
  const getParaText = useCallback((pIdx) => {
    const item = chapter.paragraphs[pIdx]
    if (!item) return ''
    return typeof item === 'string' ? item : (item.content || '')
  }, [chapter.paragraphs])

  // Cleanup long-press timer on unmount / chapter change
  useEffect(() => () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    if (autoScrollRafRef.current) cancelAnimationFrame(autoScrollRafRef.current)
  }, [])

  const clearPhraseUi = useCallback(() => {
    phraseSelRef.current = null
    setSelecting(false)
    paintPhraseHighlight(articleRef.current, null)
    if (scrollRef.current) scrollRef.current.style.touchAction = ''
    if (autoScrollRafRef.current) {
      cancelAnimationFrame(autoScrollRafRef.current)
      autoScrollRafRef.current = null
    }
  }, [])

  const finalizePhrase = useCallback(() => {
    const phraseSel = phraseSelRef.current
    if (!phraseSel) {
      clearPhraseUi()
      return
    }
    const range = normalizePhraseRange(phraseSel)
    const { pMin, wMin, pMax } = range
    const outParts = []
    for (let p = pMin; p <= pMax; p++) {
      const tokens = tokenize(getParaText(p))
      let wi = 0
      let text = ''
      let started = false
      let ended = false
      for (const t of tokens) {
        if (t.type === 'word') {
          const inRange = wordInPhraseRange(p, wi, range)
          if (inRange) {
            text += t.text
            started = true
          } else if (started) {
            ended = true
          }
          wi++
        } else if (started && !ended) {
          text += t.text
        }
      }
      outParts.push(text.replace(/[\s,;:.\-—–]+$/u, '').trim())
    }
    const phrase = outParts.filter(Boolean).join(' ')
    clearPhraseUi()
    if (phrase && phrase.length > 0) {
      const context = chapter.paragraphs
        .slice(pMin, pMax + 1)
        .map((item) => (typeof item === 'string' ? item : (item.content || '')))
        .join(' ')
      onSelectWord({
        word: phrase,
        isPhrase: phrase.trim().split(/\s+/).length > 1,
        context,
        bookId: book.id,
        bookTitle: book.title,
        chapterIdx,
        // Always the first word of the selection — "Read from here" starts here
        paraIdx: pMin,
        wordIdx: wMin,
      })
    }
  }, [clearPhraseUi, getParaText, chapter, book, chapterIdx, onSelectWord])

  const updatePhraseFocus = useCallback((pF, wF, clientY) => {
    const cur = phraseSelRef.current
    if (!cur) return
    if (pF !== cur.pF || wF !== cur.wF) {
      phraseSelRef.current = { ...cur, pF, wF }
      paintPhraseHighlight(articleRef.current, phraseSelRef.current)
    }
    if (clientY != null) lastPointerYRef.current = clientY
  }, [])

  const runEdgeAutoScroll = useCallback(() => {
    autoScrollRafRef.current = null
    if (!phraseSelRef.current) return
    const el = scrollRef.current
    if (!el) return
    const y = lastPointerYRef.current
    const rect = el.getBoundingClientRect()
    const edge = 64
    let dy = 0
    if (y < rect.top + edge) dy = -Math.max(8, (rect.top + edge - y) * 0.35)
    else if (y > rect.bottom - edge) dy = Math.max(8, (y - (rect.bottom - edge)) * 0.35)
    if (dy !== 0) {
      el.scrollTop += dy
      // Re-hit-test under finger after scroll
      const under = document.elementFromPoint(
        pointerStartRef.current?.lastX ?? rect.left + rect.width / 2,
        y
      )
      const wordEl = under?.closest?.('[data-p][data-w]')
      if (wordEl) {
        updatePhraseFocus(
          parseInt(wordEl.dataset.p, 10),
          parseInt(wordEl.dataset.w, 10),
          y
        )
      }
      autoScrollRafRef.current = requestAnimationFrame(runEdgeAutoScroll)
    }
  }, [updatePhraseFocus])

  // Block native scroll/gestures while selecting (non-passive)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !selecting) return
    const block = (e) => { e.preventDefault() }
    el.addEventListener('touchmove', block, { passive: false })
    return () => el.removeEventListener('touchmove', block)
  }, [selecting])

  // Pointer handlers on the article.
  // Mobile taps often jitter >10px. Cancelling long-press must NOT block opening
  // the definition panel, and we only suppress the click fallback when we already
  // handled the gesture (opened a word / finished a phrase).
  const handlePointerDown = useCallback((e) => {
    // Only left button / touch / pen
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const wordEl = e.target.closest?.('[data-p][data-w]')
    if (!wordEl) return
    const p = parseInt(wordEl.dataset.p, 10)
    const w = parseInt(wordEl.dataset.w, 10)
    pointerStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      p,
      w,
      pointerId: e.pointerId,
      scrolled: false,
    }
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      if (!pointerStartRef.current || pointerStartRef.current.scrolled) return
      const start = pointerStartRef.current
      phraseSelRef.current = { pA: start.p, wA: start.w, pF: start.p, wF: start.w }
      setSelecting(true)
      paintPhraseHighlight(articleRef.current, phraseSelRef.current)
      if (scrollRef.current) scrollRef.current.style.touchAction = 'none'
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(15)
      // Capture on the article (stable) — not the word span (React may replace it)
      try { articleRef.current?.setPointerCapture?.(start.pointerId) } catch {}
    }, 420)
  }, [])

  const handlePointerMove = useCallback((e) => {
    const LONG_PRESS_CANCEL = 12
    const TAP_SLOP = 22
    const start = pointerStartRef.current
    if (!start) return
    start.lastX = e.clientX
    start.lastY = e.clientY
    lastPointerYRef.current = e.clientY
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    const dist = Math.hypot(dx, dy)

    if (longPressTimerRef.current && dist > LONG_PRESS_CANCEL) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (dist > TAP_SLOP && !phraseSelRef.current) {
      start.scrolled = true
    }

    if (phraseSelRef.current) {
      e.preventDefault?.()
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const wordEl = el?.closest?.('[data-p][data-w]')
      if (wordEl) {
        updatePhraseFocus(
          parseInt(wordEl.dataset.p, 10),
          parseInt(wordEl.dataset.w, 10),
          e.clientY
        )
      } else {
        lastPointerYRef.current = e.clientY
      }
      if (!autoScrollRafRef.current) {
        autoScrollRafRef.current = requestAnimationFrame(runEdgeAutoScroll)
      }
    }
  }, [updatePhraseFocus, runEdgeAutoScroll])

  const openWordAt = useCallback((paraIdx, wordIdx) => {
    const paraText = getParaText(paraIdx)
    const tokens = tokenize(paraText)
    let wi = 0
    for (const t of tokens) {
      if (t.type === 'word') {
        if (wi === wordIdx) {
          onSelectWord({
            word: t.text,
            context: paraText,
            bookId: book.id,
            bookTitle: book.title,
            chapterIdx,
            paraIdx,
            wordIdx,
          })
          return
        }
        wi++
      }
    }
  }, [getParaText, onSelectWord, book.id, book.title, chapterIdx])

  const handlePointerUp = useCallback((e) => {
    const TAP_SLOP = 22
    const wasSelecting = !!phraseSelRef.current
    const start = pointerStartRef.current
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    try { articleRef.current?.releasePointerCapture?.(e.pointerId) } catch {}

    let handled = false
    if (wasSelecting) {
      finalizePhrase()
      handled = true
    } else if (start && !start.scrolled) {
      const dx = (e.clientX ?? start.x) - start.x
      const dy = (e.clientY ?? start.y) - start.y
      if (Math.hypot(dx, dy) <= TAP_SLOP) {
        openWordAt(start.p, start.w)
        handled = true
      }
    }

    if (handled) {
      suppressClickRef.current = true
      setTimeout(() => { suppressClickRef.current = false }, 450)
    }
    pointerStartRef.current = null
  }, [finalizePhrase, openWordAt])

  const handlePointerCancel = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    pointerStartRef.current = null
    // If we were selecting a phrase, keep what we have instead of wiping it
    if (phraseSelRef.current) {
      finalizePhrase()
    }
  }, [finalizePhrase])

  const goToChapter = useCallback((newIdx) => {
    if (newIdx < 0 || newIdx >= book.chapters.length) return
    narratorRef.current?.stop()
    setChapterIdx(newIdx)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    onUpdateProgress({ chapter: newIdx, scroll: 0, percent: 0 })
  }, [book.chapters.length, onUpdateProgress])

  const bookmarkedWords = useMemo(() => {
    return new Set(bookmarks.filter(b => b.bookId === book.id).map(b => b.word.toLowerCase()))
  }, [bookmarks, book.id])

  useEffect(() => {
    if (progress?.scroll && scrollRef.current) {
      setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = progress.scroll }, 80)
    }
  }, []) // eslint-disable-line

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let rafId = null
    let timer
    let lastPct = -1

    const paint = () => {
      rafId = null
      const total = el.scrollHeight - el.clientHeight
      const pct = total > 0 ? Math.min(100, (el.scrollTop / total) * 100) : 0
      if (barRef.current) barRef.current.style.width = pct + '%'
      const rounded = Math.round(pct)
      if (rounded !== lastPct && percentTextRef.current) {
        percentTextRef.current.textContent = rounded + '% complete'
        lastPct = rounded
      }
    }

    const onScroll = () => {
      if (rafId == null) rafId = requestAnimationFrame(paint)
      clearTimeout(timer)
      timer = setTimeout(() => {
        const total = el.scrollHeight - el.clientHeight
        const pct = total > 0 ? Math.min(100, Math.round((el.scrollTop / total) * 100)) : 0
        onUpdateProgress({ chapter: chapterIdx, scroll: el.scrollTop, percent: pct })
      }, 400)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    requestAnimationFrame(paint)
    return () => {
      el.removeEventListener('scroll', onScroll)
      clearTimeout(timer)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [chapterIdx, onUpdateProgress])

  // Narrator lifecycle — only recreate when the book changes.
  // Do NOT depend on onUpdateProgress identity: closing the def panel re-renders App,
  // which was destroying the narrator mid–ElevenLabs fetch (Read from here broke).
  useEffect(() => {
    clearElevenLabsDisabled()
    const warnedFallback = { current: false }
    let lastProvider = null
    const narrator = createNarrator({
      book,
      initialRate: voiceRate,
      onStatus: (s) => {
        setPlayer(s)
        if (
          s.playing &&
          lastProvider === 'eleven' &&
          s.provider === 'webspeech' &&
          !warnedFallback.current
        ) {
          warnedFallback.current = true
          toast.message('ElevenLabs hiccup — continuing with device voice')
        }
        lastProvider = s.provider
      },
      onSpeakingWord: (w) => {
        if (!w) {
          setSpeakingWord(null)
          return
        }
        setSpeakingWord({ paraIdx: w.paraIdx, wordIdx: w.wordIdx, chapterIdx: w.chapterIdx })
        if (w.chapterIdx !== chapterIdxRef.current) {
          setChapterIdx(w.chapterIdx)
          onUpdateProgressRef.current?.({ chapter: w.chapterIdx })
        }
        requestAnimationFrame(() => {
          if (w.chapterIdx !== chapterIdxRef.current) return
          const el = document.querySelector(`[data-p="${w.paraIdx}"][data-w="${w.wordIdx}"]`)
          if (el && scrollRef.current) {
            const rect = el.getBoundingClientRect()
            const containerRect = scrollRef.current.getBoundingClientRect()
            if (rect.top < containerRect.top + 100 || rect.bottom > containerRect.bottom - 120) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
          }
        })
      },
      onChapterNeeded: (idx) => {
        if (idx !== chapterIdxRef.current) {
          setChapterIdx(idx)
          onUpdateProgressRef.current?.({ chapter: idx })
        }
      },
    })
    narratorRef.current = narrator
    if (narrateApiRef) {
      narrateApiRef.current = {
        playFromPosition: (c, p, w) => {
          try {
            window.speechSynthesis?.resume?.()
            const warm = new Audio()
            warm.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
            warm.play().then(() => { warm.pause(); warm.src = '' }).catch(() => {})
          } catch {}
          if (!narratorRef.current) return false
          narrator.playFromPosition(c, p, w)
          return true
        },
      }
    }
    return () => {
      narrator.destroy()
      narratorRef.current = null
      if (narrateApiRef) narrateApiRef.current = null
    }
  }, [book.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep narrator rate in sync when user changes speed
  useEffect(() => {
    narratorRef.current?.setRate?.(voiceRate)
  }, [voiceRate])

  useEffect(() => {
    if (!narrateRequest || !narratorRef.current) return
    const { chapterIdx: c, paraIdx, wordIdx } = narrateRequest
    if (typeof c === 'number' && c !== chapterIdx) {
      setChapterIdx(c)
      onUpdateProgress({ chapter: c, scroll: 0 })
    }
    narratorRef.current.playFromPosition(c ?? chapterIdx, paraIdx ?? 0, wordIdx ?? 0)
    onNarrateRequestHandled?.()
  }, [narrateRequest]) // eslint-disable-line

  const startReadAloud = useCallback(() => {
    if (player.playing && player.paused) {
      narratorRef.current?.resume()
      return
    }
    if (player.playing && !player.paused) {
      narratorRef.current?.pause()
      return
    }
    narratorRef.current?.playFromChapterStart(chapterIdx)
  }, [player.playing, player.paused, chapterIdx])

  const stopReadAloud = useCallback(() => {
    narratorRef.current?.stop()
    setSpeakingWord(null)
  }, [])

  const initialPercent = progress?.percent || 0

  const changeFontSize = (delta) => {
    const s = Math.max(15, Math.min(28, fontSize + delta))
    setFontSize(s)
    saveLS(STORAGE_KEYS.SETTINGS, { ...loadLS(STORAGE_KEYS.SETTINGS, {}), fontSize: s })
  }

  const changeVoiceRate = (r) => {
    setVoiceRate(r)
    saveLS(STORAGE_KEYS.SETTINGS, { ...loadLS(STORAGE_KEYS.SETTINGS, {}), voiceRate: r })
    narratorRef.current?.setRate?.(r)
  }

  return (
    <div className="fixed inset-0 bg-background flex flex-col">
      <header className="safe-top px-4 pb-3 pt-4 border-b border-border/40 bg-background/95 backdrop-blur-md z-20">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full h-12 w-12 -ml-1 hover:bg-primary/15">
            <ArrowLeft className="w-6 h-6 text-secondary" />
          </Button>
          <div className="flex-1 text-center overflow-hidden">
            <div className="font-serif-cozy text-sm font-semibold text-foreground truncate flex items-center justify-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 flex-shrink-0" />
              {book.title}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {hasMultipleChapters
                ? `${chapterLabel(chapter, chapterIdx)} · ${chapterIdx + 1}/${book.chapters.length}`
                : chapterLabel(chapter, 0)} · <span ref={percentTextRef}>{initialPercent}% complete</span>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            {hasMultipleChapters && (
              <Button variant="ghost" size="icon" onClick={() => setTocOpen(true)} className="rounded-full h-12 w-12 hover:bg-primary/15" aria-label="Table of contents">
                <List className="w-6 h-6 text-secondary" />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => changeFontSize(-1)} className="rounded-full h-12 w-12 hover:bg-primary/15" aria-label="Smaller text" disabled={fontSize <= 15}>
              <span className="text-secondary font-serif-cozy text-[15px] font-semibold leading-none">A−</span>
            </Button>
            <Button variant="ghost" size="icon" onClick={() => changeFontSize(1)} className="rounded-full h-12 w-12 hover:bg-primary/15" aria-label="Bigger text" disabled={fontSize >= 28}>
              <span className="text-secondary font-serif-cozy text-[19px] font-semibold leading-none">A+</span>
            </Button>
            <Button
              variant={readingAloud || preparingVoice ? 'default' : 'ghost'}
              size="icon"
              onClick={startReadAloud}
              disabled={preparingVoice}
              className={`rounded-full h-12 w-12 ${readingAloud || preparingVoice ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-primary/15'}`}
              aria-label={preparingVoice ? 'Preparing voice' : readingAloud ? 'Pause reading' : 'Read aloud'}
            >
              {preparingVoice
                ? <Loader2 className="w-6 h-6 animate-spin" />
                : readingAloud
                  ? <Pause className="w-6 h-6" />
                  : <Play className="w-6 h-6 text-secondary" />}
            </Button>
          </div>
        </div>
        <div className="mt-2.5 h-0.5 bg-muted/60 rounded-full overflow-hidden">
          <div ref={barRef} className="h-full bg-primary" style={{ width: `${initialPercent}%` }} />
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <article
          ref={articleRef}
          className={`max-w-2xl mx-auto px-6 py-8 select-none ${playerVisible ? 'pb-56' : 'pb-32'} ${selecting ? 'is-phrase-selecting' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <header className="mb-8 text-center">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground/80">{book.author}</div>
            <h2 className="font-serif-cozy text-2xl font-semibold mt-1 leading-tight">{chapterLabel(chapter, chapterIdx)}</h2>
            <div className="mt-4 h-px w-16 bg-primary/50 mx-auto" />
          </header>

          <div className="reader-text space-y-6" style={{ fontSize: `${fontSize}px` }}>
            {chapter.paragraphs.map((item, pIdx) => {
              if (item.type === 'image') {
                return (
                  <figure key={pIdx} className="flex justify-center my-8">
                    <img
                      src={item.src}
                      alt={item.alt || ''}
                      className="max-w-full max-h-[70vh] h-auto object-contain"
                      loading="lazy"
                    />
                  </figure>
                )
              }
              if (item.type === 'heading') {
                if (pIdx === 0 && cleanHeadingMatch(item.content, chapter.title)) return null
                return (
                  <h3 key={pIdx} className="font-serif-cozy text-xl font-semibold text-center mt-8 mb-4">
                    {item.content}
                  </h3>
                )
              }
              return (
                <Paragraph
                  key={pIdx}
                  text={item.content || ''}
                  paraIdx={pIdx}
                  speakingWord={speakingWord?.chapterIdx === chapterIdx ? speakingWord : null}
                  bookmarkedWords={bookmarkedWords}
                  selecting={selecting}
                  onWordClick={(wIdx) => {
                    if (suppressClickRef.current) return
                    if (selecting) return
                    openWordAt(pIdx, wIdx)
                  }}
                />
              )
            })}
          </div>

          <footer className="mt-16 text-center text-muted-foreground/70">
            <div className="flex items-center justify-center gap-2">
              <div className="h-px w-8 bg-primary/40" />
              <Sparkles className="w-3.5 h-3.5" />
              <div className="h-px w-8 bg-primary/40" />
            </div>
            <p className="font-serif-cozy italic text-sm mt-3">End of chapter</p>

            {hasMultipleChapters && (
              <div className="mt-6 flex items-center justify-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToChapter(chapterIdx - 1)}
                  disabled={chapterIdx === 0}
                  className="rounded-full h-12 px-4 border-primary/40 hover:bg-primary/10"
                >
                  <ChevronLeft className="w-5 h-5 mr-1" /> Previous
                </Button>
                <button
                  type="button"
                  onClick={() => setTocOpen(true)}
                  className="text-xs text-muted-foreground/80 font-serif-cozy min-h-[44px] px-3 py-2 rounded-full hover:bg-primary/10"
                >
                  {chapterIdx + 1} / {book.chapters.length}
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToChapter(chapterIdx + 1)}
                  disabled={chapterIdx >= book.chapters.length - 1}
                  className="rounded-full h-12 px-4 border-primary/40 hover:bg-primary/10"
                >
                  Next <ChevronRight className="w-5 h-5 ml-1" />
                </Button>
              </div>
            )}
          </footer>
        </article>
      </div>

      {/* Sticky next-chapter control */}
      {hasMultipleChapters && chapterIdx < book.chapters.length - 1 && (
        <Button
          type="button"
          onClick={() => goToChapter(chapterIdx + 1)}
          className={`fixed right-4 z-30 h-14 rounded-full px-4 shadow-lg bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5 ${
            playerVisible ? 'bottom-48' : 'bottom-6'
          }`}
          style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
          aria-label="Next chapter"
        >
          <span className="font-medium text-sm">Next chapter</span>
          <ChevronRight className="w-5 h-5" />
        </Button>
      )}

      <AnimatePresence>
        {playerVisible && (
          <motion.div
            initial={{ y: '110%' }}
            animate={{ y: 0 }}
            exit={{ y: '110%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="fixed bottom-0 left-0 right-0 z-40 safe-bottom"
          >
            <div className="mx-auto max-w-md m-3 rounded-3xl border border-border/50 bg-background/95 backdrop-blur-md shadow-lg px-3 py-3">
              <div className="text-center text-[11px] text-muted-foreground mb-2 font-medium tabular-nums">
                {preparingVoice ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Preparing voice…
                  </span>
                ) : (
                  <>
                    Word {Math.min(player.wordIndex + 1, player.totalWords || 1)} of {player.totalWords || 0}
                    <span className="opacity-60 ml-2">· {player.provider === 'eleven' ? 'ElevenLabs' : 'Device voice'}</span>
                  </>
                )}
              </div>
              <div className="flex items-center justify-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-14 w-14 rounded-full hover:bg-primary/15 text-sm font-semibold text-secondary"
                  aria-label="Skip back 10 words"
                  disabled={preparingVoice}
                  onClick={() => narratorRef.current?.seekByWords(-10)}
                >
                  −10
                </Button>
                <Button
                  size="icon"
                  className="h-16 w-16 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-md"
                  aria-label={preparingVoice ? 'Preparing voice' : readingAloud ? 'Pause' : 'Play'}
                  disabled={preparingVoice}
                  onClick={() => {
                    if (!player.playing) narratorRef.current?.playFromChapterStart(chapterIdx)
                    else if (player.paused) narratorRef.current?.resume()
                    else narratorRef.current?.pause()
                  }}
                >
                  {preparingVoice
                    ? <Loader2 className="w-7 h-7 animate-spin" />
                    : readingAloud
                      ? <Pause className="w-7 h-7" />
                      : <Play className="w-7 h-7 ml-0.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-14 w-14 rounded-full hover:bg-primary/15 text-sm font-semibold text-secondary"
                  aria-label="Skip forward 10 words"
                  disabled={preparingVoice}
                  onClick={() => narratorRef.current?.seekByWords(10)}
                >
                  +10
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-14 w-14 rounded-full hover:bg-destructive/15"
                  aria-label="Stop"
                  onClick={stopReadAloud}
                >
                  <Square className="w-5 h-5 text-secondary fill-current" />
                </Button>
              </div>
              <div className="mt-3 flex items-center justify-center gap-1 overflow-x-auto px-1 pb-0.5">
                {SPEED_OPTIONS.map((r) => {
                  const active = (player.rate || voiceRate) === r
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => changeVoiceRate(r)}
                      className={`min-h-[44px] min-w-[44px] px-2 rounded-full text-[12px] font-semibold tabular-nums transition-colors ${
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'text-secondary hover:bg-primary/15'
                      }`}
                      aria-label={`Speed ${r}x`}
                      aria-pressed={active}
                    >
                      {r === 1 ? '1x' : `${r}x`}
                    </button>
                  )
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet open={tocOpen} onOpenChange={setTocOpen}>
        <SheetContent side="left" className="w-[min(100%,22rem)] p-0 flex flex-col">
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/50 text-left">
            <SheetTitle className="font-serif-cozy text-lg">Contents</SheetTitle>
            <p className="text-xs text-muted-foreground">{book.chapters.length} chapters · {book.title}</p>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {book.chapters.map((ch, idx) => (
              <button
                key={`${ch.title}-${idx}`}
                type="button"
                onClick={() => {
                  goToChapter(idx)
                  setTocOpen(false)
                }}
                className={`w-full text-left px-3 py-3 min-h-[48px] rounded-xl transition-colors ${
                  idx === chapterIdx ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/60 text-foreground/85'
                }`}
              >
                <div className="flex items-baseline gap-3">
                  <span className="text-[11px] tabular-nums text-muted-foreground w-6 flex-shrink-0">{idx + 1}</span>
                  <span className="font-serif-cozy text-sm leading-snug">{chapterLabel(ch, idx)}</span>
                </div>
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function cleanHeadingMatch(a, b) {
  const norm = (s) => cleanTextLike(s).toLowerCase()
  return norm(a) && norm(a) === norm(b)
}

function cleanTextLike(t) {
  return (t || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim()
}

function Paragraph({ text, paraIdx, speakingWord, bookmarkedWords, selecting, onWordClick }) {
  const tokens = useMemo(() => tokenize(text), [text])

  let wIdx = -1
  return (
    <p className="text-foreground/90">
      {tokens.map((t, i) => {
        if (t.type === 'space') {
          const prev = tokens[i - 1]
          const next = tokens[i + 1]
          if (prev?.type === 'word' && next?.type === 'word') {
            return (
              <span
                key={i}
                data-phrase-space=""
                data-p={paraIdx}
                data-w-before={wIdx}
              >
                {t.text}
              </span>
            )
          }
          return <span key={i}>{t.text}</span>
        }
        wIdx++
        const currentWIdx = wIdx
        const isSpeaking = speakingWord?.paraIdx === paraIdx && speakingWord?.wordIdx === currentWIdx
        const isBookmarked = bookmarkedWords.has(t.text.toLowerCase())
        return (
          <span
            key={i}
            role="button"
            tabIndex={0}
            data-p={paraIdx}
            data-w={currentWIdx}
            className={`word ${isSpeaking ? 'word-speaking' : ''} ${isBookmarked ? 'font-medium' : ''}`}
            style={isBookmarked ? { textDecoration: 'underline', textDecorationColor: 'hsl(28 51% 65% / 0.55)', textDecorationThickness: '2px', textUnderlineOffset: '3px' } : undefined}
            onClick={(e) => {
              if (selecting) return
              e.stopPropagation()
              onWordClick?.(currentWIdx)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onWordClick?.(currentWIdx)
              }
            }}
          >
            {t.text}
          </span>
        )
      })}
    </p>
  )
}

// ============================================================
// DEFINITION PANEL
// ============================================================
function DefinitionPanel({ selection, onClose, cache, onCache, onBookmark, bookmarks, onReadFromHere }) {
  const [loading, setLoading] = useState(false)
  const [def, setDef] = useState(null)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [startingRead, setStartingRead] = useState(false)

  const word = selection?.word
  const wordLower = word?.toLowerCase()
  const isPhraseMode = !!selection?.isPhrase || (word && word.trim().includes(' '))
  const cacheKey = isPhraseMode ? `p::${wordLower}` : wordLower
  const isBookmarked = !!bookmarks.find(b => b.word === wordLower && b.bookId === selection?.bookId)

  useEffect(() => {
    if (!selection) { setDef(null); setError(null); setStartingRead(false); return }

    if (cache[cacheKey]) {
      setDef(cache[cacheKey])
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    setDef(null)

    const promise = isPhraseMode
      ? explainPhrase(word, selection.context?.slice(0, 600) || '')
      : defineWord(wordLower, selection.context?.slice(0, 400) || '')

    promise
      .then((data) => {
        setDef(data)
        onCache(cacheKey, data)
      })
      .catch(() => {
        if (!isPhraseMode) {
          const fb = FALLBACK_DEFS[wordLower]
          if (fb) { setDef({ word: wordLower, ...fb }); setError(null); return }
        }
        setError(isPhraseMode
          ? 'Could not explain the phrase. Check your connection.'
          : 'Could not fetch definition. Check your connection.')
      })
      .finally(() => setLoading(false))
  }, [selection]) // eslint-disable-line

  const speak = useCallback(async (text) => {
    if (typeof window === 'undefined' || !window.speechSynthesis || !text) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 0.85
    u.lang = 'en-US'
    const v = await pickFallbackVoice()
    if (v) u.voice = v
    window.speechSynthesis.speak(u)
  }, [])

  const loadMoreExamples = useCallback(async () => {
    if (!def || loadingMore) return
    setLoadingMore(true)
    try {
      const data = await moreExamples(word, def.examples || [], selection?.context || '')
      if (data.examples?.length) {
        const updated = { ...def, examples: [...(def.examples || []), ...data.examples] }
        setDef(updated)
        onCache(cacheKey, updated)
      }
    } catch { toast.error('Could not load more examples') }
    setLoadingMore(false)
  }, [def, loadingMore, word, selection, onCache, cacheKey])

  const handleBookmark = () => {
    if (!def) return
    onBookmark({
      word: wordLower,
      definition: isPhraseMode ? def.meaning : def.definition,
      phonetic: def.phonetic || null,
      partOfSpeech: isPhraseMode ? def.type : def.partOfSpeech,
      examples: def.examples,
      literal: def.literal || null,
      isPhrase: isPhraseMode,
      context: selection.context,
      bookId: selection.bookId,
      bookTitle: selection.bookTitle,
    })
  }

  // Display strings
  const displayText = word || ''
  const meaning = def ? (isPhraseMode ? def.meaning : def.definition) : null
  const typeLabel = def ? (isPhraseMode ? def.type : def.partOfSpeech) : null

  return (
    <AnimatePresence>
      {selection && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-foreground/25 z-40 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.3 }}
            onDragEnd={(_, info) => { if (info.offset.y > 120 || info.velocity.y > 500) onClose() }}
            className="fixed left-0 right-0 bottom-0 z-50 paper-texture rounded-t-[28px] shadow-2xl border-t border-border/60 safe-bottom max-h-[85vh] flex flex-col"
          >
            <div className="pt-2.5 pb-1 grid place-items-center">
              <div className="w-11 h-1.5 rounded-full bg-muted-foreground/30" />
            </div>

            <div className="px-6 pt-3 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className={`font-serif-cozy font-semibold leading-tight ${isPhraseMode ? 'text-xl' : 'text-3xl capitalize'}`}>
                    {isPhraseMode ? `“${displayText}”` : displayText}
                  </h3>
                  {def && (
                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                      {def.phonetic && <span className="font-mono">{def.phonetic}</span>}
                      {typeLabel && <span className="italic">{def.phonetic ? '· ' : ''}{typeLabel}</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost" size="icon"
                    className="h-12 w-12 rounded-full hover:bg-primary/20"
                    onClick={handleBookmark}
                    disabled={!def}
                    aria-label="Save bookmark"
                  >
                    {isBookmarked
                      ? <BookmarkCheck className="w-6 h-6 text-secondary fill-secondary/30" />
                      : <Bookmark className="w-6 h-6 text-secondary" />}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={onClose} className="h-12 w-12 rounded-full hover:bg-primary/20" aria-label="Close">
                    <X className="w-6 h-6 text-secondary" />
                  </Button>
                </div>
              </div>

              {/* Always-visible listen / continue-reading actions */}
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 h-14 rounded-2xl border-primary/40 hover:bg-primary/10 gap-2"
                  onClick={() => speak(displayText)}
                  aria-label={isPhraseMode ? 'Hear phrase' : 'Hear word'}
                >
                  <Ear className="w-6 h-6 text-secondary" />
                  <span className="font-medium">Hear word</span>
                </Button>
                <Button
                  type="button"
                  className="flex-1 h-14 rounded-2xl gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
                  disabled={startingRead}
                  onClick={() => {
                    setStartingRead(true)
                    onReadFromHere?.(selection)
                  }}
                  aria-label="Read from here"
                >
                  {startingRead ? (
                    <Loader2 className="w-6 h-6 animate-spin" />
                  ) : (
                    <Play className="w-6 h-6" />
                  )}
                  <span className="font-medium">{startingRead ? 'Starting…' : 'Read from here'}</span>
                </Button>
              </div>
            </div>

            <div className="px-6 pb-8 overflow-y-auto flex-1">
              {loading && (
                <div className="py-10 grid place-items-center text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <p className="mt-3 font-serif-cozy italic text-sm">
                    {isPhraseMode ? 'Thinking about this phrase...' : 'Looking it up...'}
                  </p>
                </div>
              )}

              {error && !loading && (
                <div className="py-8 text-center text-muted-foreground">
                  <p className="text-sm">{error}</p>
                </div>
              )}

              {def && !loading && (
                <div className="space-y-5">
                  <div className="paper-texture rounded-2xl px-5 py-4 border border-border/40">
                    <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/80 mb-1.5">
                      {isPhraseMode ? 'What it means' : 'Meaning'}
                    </div>
                    <p className="text-foreground leading-relaxed">{meaning}</p>
                    {isPhraseMode && def.literal && (
                      <div className="mt-3 pt-3 border-t border-border/40">
                        <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/80 mb-1">Literally</div>
                        <p className="text-sm text-foreground/80 leading-relaxed italic">{def.literal}</p>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/80 mb-2.5 flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3" /> Examples
                    </div>
                    <div className="space-y-2">
                      {(def.examples || []).map((ex, i) => (
                        <ExampleRow key={i} text={ex} onPlay={() => speak(ex)} />
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadMoreExamples}
                      disabled={loadingMore}
                      className="mt-3 w-full h-12 rounded-full border-primary/40 hover:bg-primary/10 text-foreground/80"
                    >
                      {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Plus className="w-3.5 h-3.5 mr-1.5" />}
                      Show more examples
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function ExampleRow({ text, onPlay }) {
  return (
    <div className="flex items-start gap-3 bg-card rounded-xl px-4 py-3 border border-border/40">
      <Button
        variant="ghost" size="icon"
        onClick={onPlay}
        className="h-12 w-12 rounded-full hover:bg-primary/20 flex-shrink-0 mt-0.5"
        aria-label="Play example"
      >
        <Volume2 className="w-5 h-5 text-secondary" />
      </Button>
      <p className="font-serif-cozy text-[15px] leading-relaxed text-foreground/90 pt-0.5">{text}</p>
    </div>
  )
}

// ============================================================
// BOOKMARKS VIEW
// ============================================================
function BookmarksView({ bookmarks, onBack, onRemove, onOpenBook }) {
  return (
    <div className="min-h-screen">
      <header className="safe-top px-4 pb-4 pt-6 sticky top-0 z-30 backdrop-blur-md bg-background/85 border-b border-border/40">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="rounded-full h-12 w-12 hover:bg-primary/15">
            <ArrowLeft className="w-5 h-5 text-secondary" />
          </Button>
          <div>
            <h1 className="font-serif-cozy text-xl font-semibold leading-none">Your Bookmarks</h1>
            <p className="text-[11px] text-muted-foreground mt-1">{bookmarks.length} saved word{bookmarks.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 pt-6 pb-32 safe-bottom">
        {bookmarks.length === 0 ? (
          <div className="mt-20 text-center text-muted-foreground">
            <div className="w-16 h-16 mx-auto rounded-full bg-primary/15 grid place-items-center mb-4">
              <Bookmark className="w-7 h-7 text-secondary" />
            </div>
            <p className="font-serif-cozy text-lg">No bookmarks yet</p>
            <p className="text-sm mt-2 max-w-xs mx-auto">Tap any word while reading and press the bookmark icon to save it here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {bookmarks.map(bm => (
              <BookmarkCard key={bm.id} bookmark={bm} onRemove={() => onRemove(bm.id)} onOpen={() => onOpenBook(bm.bookId)} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function BookmarkCard({ bookmark, onRemove, onOpen }) {
  const speak = async () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(bookmark.word)
    u.rate = 0.85; u.lang = 'en-US'
    const v = await pickFallbackVoice()
    if (v) u.voice = v
    window.speechSynthesis.speak(u)
  }
  const date = new Date(bookmark.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const isPhrase = !!bookmark.isPhrase
  return (
    <Card className="paper-texture border border-border/60 rounded-2xl p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <h3 className={`font-serif-cozy font-semibold leading-tight ${isPhrase ? 'text-lg' : 'text-2xl capitalize'}`}>
              {isPhrase ? `“${bookmark.word}”` : bookmark.word}
            </h3>
            <Button variant="ghost" size="icon" onClick={speak} className="h-12 w-12 rounded-full hover:bg-primary/15 flex-shrink-0 mt-0.5">
              <Volume2 className="w-6 h-6 text-secondary" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-2 flex-wrap">
            {bookmark.phonetic && <span className="font-mono">{bookmark.phonetic}</span>}
            {bookmark.partOfSpeech && <span className="italic">{bookmark.phonetic ? '· ' : ''}{bookmark.partOfSpeech}</span>}
          </div>
          <p className="text-sm mt-2.5 text-foreground/85 leading-relaxed">{bookmark.definition}</p>
          {isPhrase && bookmark.literal && (
            <p className="text-xs mt-1.5 text-muted-foreground italic leading-relaxed">Literally: {bookmark.literal}</p>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onRemove} className="h-12 w-12 rounded-full hover:bg-destructive/15 flex-shrink-0">
          <X className="w-5 h-5 text-muted-foreground" />
        </Button>
      </div>
      <button onClick={onOpen} className="mt-3 pt-3 border-t border-border/50 w-full text-left flex items-center justify-between text-xs text-muted-foreground hover:text-foreground transition">
        <span className="flex items-center gap-1.5">
          <BookOpen className="w-3 h-3" /> {bookmark.bookTitle} · {date}
        </span>
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </Card>
  )
}

export default App
