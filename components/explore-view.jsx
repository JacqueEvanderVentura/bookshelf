'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Search, Loader2, Download, Flame, BookOpen, Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import {
  searchGutenberg,
  rateBookDifficulty,
  downloadEpub,
  sampleTextFromChapters,
} from '@/lib/gutenberg'
import { parseEpub } from '@/lib/epub-parser'

export default function ExploreView({ onImported, existingBooks = [] }) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [results, setResults] = useState([])
  const [ratings, setRatings] = useState({}) // id -> { difficulty, loading }
  const [addingId, setAddingId] = useState(null)
  const abortRef = useRef(null)

  const runSearch = useCallback(async (q) => {
    if (abortRef.current) abortRef.current.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setHasSearched(true)
    try {
      const data = await searchGutenberg(q, { signal: ac.signal })
      setResults(data.results)
      // Kick off difficulty ratings in parallel (bounded)
      const nextRatings = {}
      data.results.forEach((b) => { nextRatings[b.id] = { loading: true } })
      setRatings(nextRatings)
      data.results.slice(0, 12).forEach(async (b) => {
        try {
          const rated = await rateBookDifficulty(b.id)
          setRatings((prev) => ({ ...prev, [b.id]: { ...rated, loading: false } }))
        } catch {
          setRatings((prev) => ({ ...prev, [b.id]: { difficulty: 3, loading: false, source: 'default' } }))
        }
      })
    } catch (e) {
      if (e.name === 'AbortError') return
      console.error(e)
      toast.error('Search failed — check your connection')
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => () => { abortRef.current?.abort() }, [])

  const onSubmit = (e) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    runSearch(q)
  }

  const alreadyHave = (title, author) =>
    existingBooks.some(
      (b) => b.title.toLowerCase() === title.toLowerCase() &&
        b.author.toLowerCase() === (author || '').toLowerCase()
    )

  const handleAdd = async (book) => {
    if (!book.epubUrl) {
      toast.error('No EPUB available for this title')
      return
    }
    setAddingId(book.id)
    try {
      const file = await downloadEpub(book.epubUrl, book.title, {
        gutenbergId: book.id,
        epubUrls: book.epubUrls,
      })
      const parsed = await parseEpub(file, 'Gutenberg')
      let difficulty = ratings[book.id]?.difficulty
      if (difficulty == null || ratings[book.id]?.source === 'default') {
        const sample = sampleTextFromChapters(parsed.chapters)
        const rated = await rateBookDifficulty(book.id, sample)
        difficulty = rated.difficulty
        setRatings((prev) => ({ ...prev, [book.id]: { ...rated, loading: false } }))
      }
      await onImported({
        parsed: {
          ...parsed,
          category: 'Gutenberg',
          title: parsed.title || book.title,
          author: parsed.author || book.author,
        },
        difficulty,
        gutenbergId: book.id,
      })
      toast.success(`Added "${book.title}" to your shelf`)
    } catch (e) {
      console.error(e)
      toast.error(e.message || 'Could not download book')
    } finally {
      setAddingId(null)
    }
  }

  return (
    <div className="min-h-screen pb-28">
      <header className="safe-top px-5 pt-6 pb-4">
        <div className="flex items-center gap-2 text-secondary mb-1">
          <Compass className="w-5 h-5" />
          <span className="text-xs uppercase tracking-widest font-medium">Explore</span>
        </div>
        <h1 className="font-serif-cozy text-2xl font-semibold">Project Gutenberg</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Search free public-domain books — we rate difficulty and add them to your shelf.
        </p>
        <form onSubmit={onSubmit} className="mt-4 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Alice, Dickens, fairy tales…"
              className="pl-11 h-12 rounded-2xl bg-card border-border/60"
            />
          </div>
          <Button
            type="submit"
            disabled={loading || !query.trim()}
            className="h-12 px-5 rounded-2xl min-w-[3.5rem]"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Search'}
          </Button>
        </form>
      </header>

      <div className="px-5 space-y-3">
        {!loading && results.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-50" />
            {hasSearched ? (
              <>
                <p className="font-serif-cozy text-base">No books found with these params</p>
                <p className="text-sm mt-1 opacity-80">Try a shorter title, author name, or different spelling.</p>
              </>
            ) : (
              <p className="font-serif-cozy text-base">Search to discover books</p>
            )}
          </div>
        )}

        {results.map((book) => {
          const rating = ratings[book.id]
          const owned = alreadyHave(book.title, book.author)
          return (
            <motion.div
              key={book.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-border/50 bg-card/80 p-4 flex gap-3"
            >
              <div className="w-14 h-20 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                {book.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={book.coverUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full grid place-items-center text-muted-foreground">
                    <BookOpen className="w-6 h-6" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-serif-cozy font-semibold leading-snug line-clamp-2">{book.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{book.author}</div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <span className="text-[11px] text-muted-foreground">
                    {book.downloadCount.toLocaleString()} downloads
                  </span>
                  {rating?.loading ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin" /> rating…
                    </span>
                  ) : rating?.difficulty != null ? (
                    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-secondary bg-accent/40 px-1.5 py-0.5 rounded-full">
                      <Flame className="w-3 h-3" />
                      {Number(rating.difficulty).toFixed(1)}
                      {rating.ease != null && (
                        <span className="opacity-70 ml-0.5">· ease {Math.round(rating.ease)}</span>
                      )}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  disabled={!!addingId || owned || !book.epubUrl}
                  onClick={() => handleAdd(book)}
                  className="mt-3 h-12 min-w-[7rem] rounded-full px-4"
                >
                  {addingId === book.id ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : owned ? (
                    'On shelf'
                  ) : (
                    <>
                      <Download className="w-4 h-4 mr-1.5" /> Add
                    </>
                  )}
                </Button>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

