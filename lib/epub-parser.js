// Lightweight EPUB parser: unzip → OPF metadata → spine HTML → paragraphs
import JSZip from 'jszip'

function pathJoin(dir, href) {
  if (!dir) return href
  if (href.startsWith('/')) return href.slice(1)
  // resolve simple ../ segments
  const parts = (dir + href).split('/')
  const out = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return out.join('/')
}

function cleanText(t) {
  return (t || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim()
}

function htmlSectionToChapter(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // Remove script/style/nav
  doc.querySelectorAll('script, style, nav, header, footer').forEach(n => n.remove())

  const titleEl = doc.querySelector('h1, h2, h3, title')
  const chapterTitle = cleanText(titleEl?.textContent) || ''

  const paragraphs = []
  const seen = new Set()

  // Prefer explicit <p> blocks
  doc.querySelectorAll('p').forEach(p => {
    const text = cleanText(p.textContent)
    if (text.length >= 15 && !seen.has(text)) {
      seen.add(text)
      paragraphs.push(text)
    }
  })

  // Fallback: div/li leaf nodes if no <p>
  if (paragraphs.length === 0) {
    doc.querySelectorAll('div, li').forEach(el => {
      if (el.querySelector('p, li, div')) return
      const text = cleanText(el.textContent)
      if (text.length >= 20 && !seen.has(text)) {
        seen.add(text)
        paragraphs.push(text)
      }
    })
  }

  // Ultimate fallback: split body text by double newline
  if (paragraphs.length === 0 && doc.body) {
    const raw = doc.body.textContent || ''
    raw.split(/\n{2,}|\r\n{2,}/).forEach(chunk => {
      const t = cleanText(chunk)
      if (t.length >= 20 && !seen.has(t)) {
        seen.add(t)
        paragraphs.push(t)
      }
    })
  }

  return { title: chapterTitle, paragraphs }
}

export async function parseEpub(file, folderName = 'My Books') {
  const zip = await JSZip.loadAsync(file)

  // 1) container.xml → OPF path
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('Invalid EPUB (no container.xml)')
  const container = await containerFile.async('string')
  const opfMatch = container.match(/full-path=["']([^"']+)["']/i)
  if (!opfMatch) throw new Error('Invalid EPUB (no OPF path)')
  const opfPath = opfMatch[1]
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : ''

  const opfFile = zip.file(opfPath)
  if (!opfFile) throw new Error('Invalid EPUB (OPF missing)')
  const opf = await opfFile.async('string')

  // 2) Parse OPF for metadata + manifest + spine
  const opfDoc = new DOMParser().parseFromString(opf, 'application/xml')
  const title =
    cleanText(opfDoc.querySelector('metadata title, dc\\:title')?.textContent) ||
    file.name.replace(/\.epub$/i, '')
  const author =
    cleanText(opfDoc.querySelector('metadata creator, dc\\:creator')?.textContent) ||
    'Unknown Author'

  const manifest = {}
  opfDoc.querySelectorAll('manifest > item').forEach(item => {
    manifest[item.getAttribute('id')] = {
      href: item.getAttribute('href'),
      mediaType: item.getAttribute('media-type') || item.getAttribute('mediaType'),
    }
  })

  const spineIds = []
  opfDoc.querySelectorAll('spine > itemref').forEach(ref => {
    spineIds.push(ref.getAttribute('idref'))
  })

  // 3) Load each spine section
  const chapters = []
  for (let i = 0; i < spineIds.length; i++) {
    const id = spineIds[i]
    const item = manifest[id]
    if (!item) continue
    if (item.mediaType && !/html|xhtml|xml/i.test(item.mediaType)) continue
    const fullPath = pathJoin(opfDir, item.href.split('#')[0])
    const sectionFile = zip.file(fullPath)
    if (!sectionFile) continue
    try {
      const html = await sectionFile.async('string')
      const chapter = htmlSectionToChapter(html)
      if (chapter.paragraphs.length > 0) {
        if (!chapter.title) chapter.title = `Chapter ${chapters.length + 1}`
        chapters.push(chapter)
      }
    } catch (e) {
      // skip bad sections
      console.warn('Skipping section', fullPath, e)
    }
  }

  if (chapters.length === 0) throw new Error('No readable content found in EPUB')

  return { title, author, chapters, category: folderName }
}

const COVER_CLASSES = [
  'cover-gradient-1', 'cover-gradient-2', 'cover-gradient-3',
  'cover-gradient-4', 'cover-gradient-5', 'cover-gradient-6',
]

export function randomCover(seed) {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash) + seed.charCodeAt(i)
  return COVER_CLASSES[Math.abs(hash) % COVER_CLASSES.length]
}
