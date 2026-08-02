'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BookOpen, ArrowLeft, Bookmark, BookmarkCheck, Volume2,
  Play, Pause, Sparkles, Loader2, X, Plus,
  ChevronRight, Coffee, Heart, Type
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { toast } from 'sonner'
import { SAMPLE_BOOKS } from '@/lib/sample-books'

const STORAGE_KEYS = {
  PROGRESS: 'cozy_progress_v1',
  BOOKMARKS: 'cozy_bookmarks_v1',
  DEF_CACHE: 'cozy_def_cache_v1',
  SETTINGS: 'cozy_settings_v1',
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

// ============================================================
// MAIN APP
// ============================================================
function App() {
  const [view, setView] = useState('shelf') // shelf | reader | bookmarks
  const [activeBook, setActiveBook] = useState(null)
  const [progress, setProgress] = useState({})
  const [bookmarks, setBookmarks] = useState([])
  const [defCache, setDefCache] = useState({})
  const [selectedWord, setSelectedWord] = useState(null)

  useEffect(() => {
    setProgress(loadLS(STORAGE_KEYS.PROGRESS, {}))
    setBookmarks(loadLS(STORAGE_KEYS.BOOKMARKS, []))
    setDefCache(loadLS(STORAGE_KEYS.DEF_CACHE, {}))
    // Warm up voices on iOS
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.getVoices()
    }
  }, [])

  const openBook = (book) => {
    setActiveBook(book)
    setView('reader')
    window.scrollTo(0, 0)
  }
  const closeBook = () => {
    setActiveBook(null)
    setView('shelf')
  }

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

  return (
    <div className="min-h-screen bg-background">
      <AnimatePresence mode="wait">
        {view === 'shelf' && (
          <motion.div key="shelf" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <BookshelfView
              progress={progress}
              onOpenBook={openBook}
              onOpenBookmarks={() => setView('bookmarks')}
              bookmarkCount={bookmarks.length}
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
                const book = SAMPLE_BOOKS.find(b => b.id === bookId)
                if (book) openBook(book)
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
      />
    </div>
  )
}

// ============================================================
// BOOKSHELF VIEW
// ============================================================
function BookshelfView({ progress, onOpenBook, onOpenBookmarks, bookmarkCount }) {
  const grouped = useMemo(() => {
    const g = {}
    SAMPLE_BOOKS.forEach(b => {
      if (!g[b.category]) g[b.category] = []
      g[b.category].push(b)
    })
    return g
  }, [])

  const continueReading = useMemo(() => {
    return Object.entries(progress)
      .map(([id, p]) => ({ book: SAMPLE_BOOKS.find(b => b.id === id), progress: p }))
      .filter(x => x.book)
      .sort((a, b) => (b.progress.lastRead || 0) - (a.progress.lastRead || 0))
      .slice(0, 3)
  }, [progress])

  return (
    <div className="min-h-screen">
      <header className="safe-top px-5 pb-4 pt-6 sticky top-0 z-30 backdrop-blur-md bg-background/85 border-b border-border/40">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-primary/25 grid place-items-center">
              <BookOpen className="w-5 h-5 text-secondary" strokeWidth={2.2} />
            </div>
            <div>
              <h1 className="font-serif-cozy text-xl font-semibold text-foreground leading-none">Daniela&apos;s Bookshelf</h1>
              <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                <Heart className="w-2.5 h-2.5 fill-current text-primary/70" /> one word at a time
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full h-11 w-11 hover:bg-primary/15 relative"
            onClick={onOpenBookmarks}
            aria-label="Bookmarks"
          >
            <Bookmark className="w-5 h-5 text-secondary" />
            {bookmarkCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-secondary text-white text-[10px] font-semibold rounded-full min-w-[18px] h-[18px] px-1 grid place-items-center">
                {bookmarkCount > 99 ? '99+' : bookmarkCount}
              </span>
            )}
          </Button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 pb-24 pt-2 safe-bottom">
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

        {Object.entries(grouped).map(([category, books]) => (
          <section key={category} className="mb-8">
            <h2 className="font-serif-cozy text-sm font-medium text-muted-foreground uppercase tracking-widest mb-4 px-1">
              {category}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {books.map(book => (
                <BookCard key={book.id} book={book} progress={progress[book.id]} onOpen={() => onOpenBook(book)} />
              ))}
            </div>
          </section>
        ))}

        <div className="mt-12 text-center text-muted-foreground/80">
          <Sparkles className="w-5 h-5 mx-auto mb-2 text-primary/60" />
          <p className="font-serif-cozy italic text-sm">Tap any word while reading to discover its meaning.</p>
        </div>
      </main>
    </div>
  )
}

function BookCard({ book, progress, onOpen }) {
  const percent = progress?.percent || 0
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onOpen}
      className="text-left group focus:outline-none"
    >
      <div className={`aspect-[2/3] rounded-2xl ${book.coverClass} shadow-md relative overflow-hidden`}>
        <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-black/20" />
        <div className="absolute inset-0 p-3 flex flex-col justify-between text-white">
          <div className="text-[10px] uppercase tracking-widest opacity-70 font-medium">{book.category}</div>
          <div>
            <div className="font-serif-cozy text-base leading-tight font-semibold drop-shadow">{book.title}</div>
            <div className="text-[11px] opacity-85 mt-1">{book.author}</div>
          </div>
        </div>
        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-black/25" />
        {percent > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <div className="text-sm font-medium leading-tight line-clamp-1">{book.title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{book.author}</div>
      </div>
    </motion.button>
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
function ReaderView({ book, progress, onUpdateProgress, onClose, onSelectWord, bookmarks }) {
  const [chapterIdx] = useState(progress?.chapter || 0)
  const [fontSize, setFontSize] = useState(loadLS(STORAGE_KEYS.SETTINGS, {})?.fontSize || 20)
  const [readingAloud, setReadingAloud] = useState(false)
  const [speakingWord, setSpeakingWord] = useState(null)
  const scrollRef = useRef(null)
  const chapter = book.chapters[chapterIdx]

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
    let timer
    const onScroll = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const total = el.scrollHeight - el.clientHeight
        const percent = total > 0 ? Math.min(100, Math.round((el.scrollTop / total) * 100)) : 0
        onUpdateProgress({ chapter: chapterIdx, scroll: el.scrollTop, percent })
      }, 350)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); clearTimeout(timer) }
  }, [chapterIdx, onUpdateProgress])

  const startReadAloud = useCallback(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()

    const allWords = []
    chapter.paragraphs.forEach((para, pIdx) => {
      const tokens = tokenize(para)
      let wIdx = 0
      tokens.forEach(t => {
        if (t.type === 'word') {
          allWords.push({ paraIdx: pIdx, wordIdx: wIdx })
          wIdx++
        }
      })
    })

    setReadingAloud(true)
    const fullText = chapter.paragraphs.join('\n\n')
    const utter = new SpeechSynthesisUtterance(fullText)
    utter.rate = 0.9
    utter.pitch = 1.0
    utter.lang = 'en-US'

    const voices = window.speechSynthesis.getVoices()
    const preferred = voices.find(v => /Samantha|Karen|Google US English|Microsoft Aria/i.test(v.name)) || voices.find(v => v.lang?.startsWith('en'))
    if (preferred) utter.voice = preferred

    let wordCount = 0
    utter.onboundary = (e) => {
      if (e.name === 'word' && allWords[wordCount]) {
        setSpeakingWord({ paraIdx: allWords[wordCount].paraIdx, wordIdx: allWords[wordCount].wordIdx })
        const el = document.querySelector(`[data-p="${allWords[wordCount].paraIdx}"][data-w="${allWords[wordCount].wordIdx}"]`)
        if (el && scrollRef.current) {
          const rect = el.getBoundingClientRect()
          const containerRect = scrollRef.current.getBoundingClientRect()
          if (rect.top < containerRect.top + 100 || rect.bottom > containerRect.bottom - 100) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }
        wordCount++
      }
    }
    utter.onend = () => { setReadingAloud(false); setSpeakingWord(null) }
    utter.onerror = () => { setReadingAloud(false); setSpeakingWord(null) }
    window.speechSynthesis.speak(utter)
  }, [chapter])

  const stopReadAloud = () => {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
    setReadingAloud(false)
    setSpeakingWord(null)
  }

  useEffect(() => () => { if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel() }, [])

  const percent = progress?.percent || 0

  const handleWordTap = (word, paraIdx, wordIdx, paraText) => {
    onSelectWord({
      word,
      context: paraText,
      bookId: book.id,
      bookTitle: book.title,
      chapterIdx,
      paraIdx,
      wordIdx,
    })
  }

  const changeFontSize = (delta) => {
    const s = Math.max(15, Math.min(28, fontSize + delta))
    setFontSize(s)
    saveLS(STORAGE_KEYS.SETTINGS, { ...loadLS(STORAGE_KEYS.SETTINGS, {}), fontSize: s })
  }

  return (
    <div className="fixed inset-0 bg-background flex flex-col">
      <header className="safe-top px-4 pb-3 pt-4 border-b border-border/40 bg-background/95 backdrop-blur-md z-20">
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full h-10 w-10 -ml-1 hover:bg-primary/15">
            <ArrowLeft className="w-5 h-5 text-secondary" />
          </Button>
          <div className="flex-1 text-center overflow-hidden">
            <div className="font-serif-cozy text-sm font-semibold text-foreground truncate flex items-center justify-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 flex-shrink-0" />
              {book.title}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {chapter.title.split(' — ')[0]} · {percent}% complete
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => changeFontSize(1)} className="rounded-full h-9 w-9 hover:bg-primary/15" aria-label="Bigger text">
              <Type className="w-4 h-4 text-secondary" />
            </Button>
            <Button
              variant={readingAloud ? 'default' : 'ghost'}
              size="icon"
              onClick={readingAloud ? stopReadAloud : startReadAloud}
              className={`rounded-full h-10 w-10 ${readingAloud ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-primary/15'}`}
              aria-label={readingAloud ? 'Stop reading' : 'Read aloud'}
            >
              {readingAloud ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-secondary" />}
            </Button>
          </div>
        </div>
        <div className="mt-2.5 h-0.5 bg-muted/60 rounded-full overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto safe-bottom">
        <article className="max-w-2xl mx-auto px-6 py-8 pb-32">
          <header className="mb-8 text-center">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground/80">{book.author}</div>
            <h2 className="font-serif-cozy text-2xl font-semibold mt-1 leading-tight">{chapter.title}</h2>
            <div className="mt-4 h-px w-16 bg-primary/50 mx-auto" />
          </header>

          <div className="reader-text space-y-6" style={{ fontSize: `${fontSize}px` }}>
            {chapter.paragraphs.map((para, pIdx) => (
              <Paragraph
                key={pIdx}
                text={para}
                paraIdx={pIdx}
                onWordTap={(w, wIdx) => handleWordTap(w, pIdx, wIdx, para)}
                speakingWord={speakingWord}
                bookmarkedWords={bookmarkedWords}
              />
            ))}
          </div>

          <footer className="mt-16 text-center text-muted-foreground/70">
            <div className="flex items-center justify-center gap-2">
              <div className="h-px w-8 bg-primary/40" />
              <Sparkles className="w-3.5 h-3.5" />
              <div className="h-px w-8 bg-primary/40" />
            </div>
            <p className="font-serif-cozy italic text-sm mt-3">End of excerpt</p>
          </footer>
        </article>
      </div>
    </div>
  )
}

function Paragraph({ text, paraIdx, onWordTap, speakingWord, bookmarkedWords }) {
  const tokens = useMemo(() => tokenize(text), [text])
  let wIdx = -1
  return (
    <p className="text-foreground/90">
      {tokens.map((t, i) => {
        if (t.type === 'space') return <span key={i}>{t.text}</span>
        wIdx++
        const currentWIdx = wIdx
        const isSpeaking = speakingWord?.paraIdx === paraIdx && speakingWord?.wordIdx === currentWIdx
        const isBookmarked = bookmarkedWords.has(t.text.toLowerCase())
        return (
          <span
            key={i}
            data-p={paraIdx}
            data-w={currentWIdx}
            className={`word ${isSpeaking ? 'word-speaking' : ''} ${isBookmarked ? 'font-medium' : ''}`}
            onClick={() => onWordTap(t.text, currentWIdx)}
            style={isBookmarked ? { textDecoration: 'underline', textDecorationColor: 'hsl(28 51% 65% / 0.55)', textDecorationThickness: '2px', textUnderlineOffset: '3px' } : undefined}
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
function DefinitionPanel({ selection, onClose, cache, onCache, onBookmark, bookmarks }) {
  const [loading, setLoading] = useState(false)
  const [def, setDef] = useState(null)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const word = selection?.word
  const wordLower = word?.toLowerCase()
  const isBookmarked = !!bookmarks.find(b => b.word === wordLower && b.bookId === selection?.bookId)

  useEffect(() => {
    if (!selection) { setDef(null); setError(null); return }
    const lower = word.toLowerCase()

    if (cache[lower]) {
      setDef(cache[lower])
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    setDef(null)

    fetch('/api/define', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: lower, context: selection.context?.slice(0, 400) || '' }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('Lookup failed')
        return r.json()
      })
      .then((data) => {
        setDef(data)
        onCache(lower, data)
      })
      .catch(() => {
        const fb = FALLBACK_DEFS[lower]
        if (fb) { setDef({ word: lower, ...fb }); setError(null) }
        else setError('Could not fetch definition. Check your connection.')
      })
      .finally(() => setLoading(false))
  }, [selection]) // eslint-disable-line

  const speak = useCallback((text) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 0.85
    u.lang = 'en-US'
    const voices = window.speechSynthesis.getVoices()
    const v = voices.find(vc => /Samantha|Karen|Google US English|Microsoft Aria/i.test(vc.name)) || voices.find(vc => vc.lang?.startsWith('en'))
    if (v) u.voice = v
    window.speechSynthesis.speak(u)
  }, [])

  const loadMoreExamples = useCallback(async () => {
    if (!def || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await fetch('/api/more-examples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: wordLower, have: def.examples || [], context: selection?.context || '' }),
      })
      const data = await r.json()
      if (data.examples?.length) {
        const updated = { ...def, examples: [...(def.examples || []), ...data.examples] }
        setDef(updated)
        onCache(wordLower, updated)
      }
    } catch { toast.error('Could not load more examples') }
    setLoadingMore(false)
  }, [def, loadingMore, wordLower, selection, onCache])

  const handleBookmark = () => {
    if (!def) return
    onBookmark({
      word: wordLower,
      definition: def.definition,
      phonetic: def.phonetic,
      partOfSpeech: def.partOfSpeech,
      examples: def.examples,
      context: selection.context,
      bookId: selection.bookId,
      bookTitle: selection.bookTitle,
    })
  }

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

            <div className="px-6 pt-3 pb-2 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-serif-cozy text-3xl font-semibold capitalize leading-tight">{word}</h3>
                  <Button
                    variant="ghost" size="icon"
                    className="h-9 w-9 rounded-full hover:bg-primary/20"
                    onClick={() => speak(word)}
                    aria-label="Pronounce word"
                  >
                    <Volume2 className="w-4 h-4 text-secondary" />
                  </Button>
                </div>
                {def && (
                  <div className="text-sm text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                    {def.phonetic && <span className="font-mono">{def.phonetic}</span>}
                    {def.partOfSpeech && <span className="italic">· {def.partOfSpeech}</span>}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost" size="icon"
                  className="h-10 w-10 rounded-full hover:bg-primary/20"
                  onClick={handleBookmark}
                  disabled={!def}
                  aria-label="Save bookmark"
                >
                  {isBookmarked
                    ? <BookmarkCheck className="w-5 h-5 text-secondary fill-secondary/30" />
                    : <Bookmark className="w-5 h-5 text-secondary" />}
                </Button>
                <Button variant="ghost" size="icon" onClick={onClose} className="h-10 w-10 rounded-full hover:bg-primary/20" aria-label="Close">
                  <X className="w-5 h-5 text-secondary" />
                </Button>
              </div>
            </div>

            <div className="px-6 pb-8 overflow-y-auto flex-1">
              {loading && (
                <div className="py-10 grid place-items-center text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  <p className="mt-3 font-serif-cozy italic text-sm">Looking it up...</p>
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
                    <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/80 mb-1.5">Meaning</div>
                    <p className="text-foreground leading-relaxed">{def.definition}</p>
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
                      className="mt-3 w-full rounded-full border-primary/40 hover:bg-primary/10 text-foreground/80"
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
        className="h-8 w-8 rounded-full hover:bg-primary/20 flex-shrink-0 mt-0.5"
        aria-label="Play example"
      >
        <Volume2 className="w-3.5 h-3.5 text-secondary" />
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
          <Button variant="ghost" size="icon" onClick={onBack} className="rounded-full h-10 w-10 hover:bg-primary/15">
            <ArrowLeft className="w-5 h-5 text-secondary" />
          </Button>
          <div>
            <h1 className="font-serif-cozy text-xl font-semibold leading-none">Your Bookmarks</h1>
            <p className="text-[11px] text-muted-foreground mt-1">{bookmarks.length} saved word{bookmarks.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 pt-6 pb-24 safe-bottom">
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
  const speak = () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(bookmark.word)
    u.rate = 0.85; u.lang = 'en-US'
    window.speechSynthesis.speak(u)
  }
  const date = new Date(bookmark.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return (
    <Card className="paper-texture border border-border/60 rounded-2xl p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-serif-cozy text-2xl font-semibold capitalize leading-none">{bookmark.word}</h3>
            <Button variant="ghost" size="icon" onClick={speak} className="h-7 w-7 rounded-full hover:bg-primary/15">
              <Volume2 className="w-3.5 h-3.5 text-secondary" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground mt-1.5 flex items-center gap-2 flex-wrap">
            {bookmark.phonetic && <span className="font-mono">{bookmark.phonetic}</span>}
            {bookmark.partOfSpeech && <span className="italic">· {bookmark.partOfSpeech}</span>}
          </div>
          <p className="text-sm mt-2.5 text-foreground/85 leading-relaxed">{bookmark.definition}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onRemove} className="h-8 w-8 rounded-full hover:bg-destructive/15 flex-shrink-0">
          <X className="w-4 h-4 text-muted-foreground" />
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
