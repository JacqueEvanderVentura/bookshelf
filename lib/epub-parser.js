import JSZip from 'jszip'

function pathJoin(dir, href) {
  if (!dir) return href
  if (href.startsWith('/')) return href.slice(1)
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

async function htmlSectionToChapter(html, zip, opfDir) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, nav, header, footer').forEach(n => n.remove())

  const titleEl = doc.querySelector('h1, h2, h3, title')
  const chapterTitle = cleanText(titleEl?.textContent) || ''

  // Extract images before we strip them
  const imgs = doc.querySelectorAll('img[src]')
  const imageUrls = new Map()
  const imageData = []

  // Collect unique image src paths
  imgs.forEach((img, idx) => {
    const src = img.getAttribute('src')
    if (src && !imageUrls.has(src)) {
      imageUrls.set(src, { el: img, refs: [] })
    }
    if (src) imageUrls.get(src).refs.push(idx)
  })

  // Load each image from the ZIP
  for (const [src, { el }] of imageUrls) {
    try {
      const imgPath = pathJoin(opfDir, src.split('#')[0])
      const imgFile = zip.file(imgPath)
      if (imgFile) {
        const blob = await imgFile.async('blob')
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.readAsDataURL(blob)
        })
        el.setAttribute('src', dataUrl)
      }
    } catch { /* image not found */ }
  }

  // Now extract paragraphs from the HTML body
  const paragraphs = []
  const seen = new Set()

  // Walk child nodes in order: text paragraphs + images
  function walkChildren(parent, list) {
    parent.childNodes.forEach(node => {
      if (node.nodeType === 1) { // Element
        const tag = node.tagName.toLowerCase()
        if (tag === 'img' && node.getAttribute('src')) {
          list.push({
            type: 'image',
            src: node.getAttribute('src'),
            alt: node.getAttribute('alt') || '',
          })
          return
        }
        if (tag === 'p') {
          const text = cleanText(node.textContent)
          if (text.length >= 2 && !seen.has(text)) {
            seen.add(text)
            list.push({ type: 'text', content: text })
          }
          return
        }
        // Recurse into other containers
        if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'blockquote' || tag === 'body') {
          walkChildren(node, list)
          return
        }
        // Headings of level h2+ become section breaks, not paragraphs
        if (/^h[2-6]$/.test(tag)) {
          const heading = cleanText(node.textContent)
          if (heading.length >= 2) list.push({ type: 'heading', content: heading })
          return
        }
        // Other elements: check for inline content
        const text = cleanText(node.textContent)
        if (text.length >= 2 && !seen.has(text)) {
          seen.add(text)
          list.push({ type: 'text', content: text })
        }
      }
    })
  }

  walkChildren(doc.body || doc.documentElement, paragraphs)

  // If walkChildren didn't find anything, fall back to simple p extraction
  if (paragraphs.length === 0) {
    doc.querySelectorAll('p').forEach(p => {
      const text = cleanText(p.textContent)
      if (text.length >= 2 && !seen.has(text)) {
        seen.add(text)
        paragraphs.push({ type: 'text', content: text })
      }
    })
  }

  // Ultimate fallback: split body text
  if (paragraphs.length === 0 && doc.body) {
    const raw = doc.body.textContent || ''
    raw.split(/\n{2,}|\r\n{2,}/).forEach(chunk => {
      const t = cleanText(chunk)
      if (t.length >= 4 && !seen.has(t)) {
        seen.add(t)
        paragraphs.push({ type: 'text', content: t })
      }
    })
  }

  return { title: chapterTitle, paragraphs }
}

export async function parseEpub(file, folderName = 'My Books') {
  const zip = await JSZip.loadAsync(file)

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
      const chapter = await htmlSectionToChapter(html, zip, opfDir)
      if (chapter.paragraphs.length > 0) {
        if (!chapter.title) chapter.title = `Chapter ${chapters.length + 1}`
        chapters.push(chapter)
      }
    } catch (e) {
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
