import JSZip from 'jszip'

/** Bump when chapter shape changes so imports can refresh stored books. */
export const PARSER_VERSION = 2

function pathJoin(baseDir, href) {
  if (!href) return ''
  if (/^(https?:|data:|blob:)/i.test(href)) return href
  const clean = href.split('#')[0]
  if (!clean) return ''
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '')
  const parts = `${baseDir || ''}${clean}`.split('/')
  const out = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p !== '.' && p !== '') out.push(p)
  }
  return out.join('/')
}

function dirOf(path) {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i + 1) : ''
}

function cleanText(t) {
  return (t || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim()
}

function xmlLocalName(el) {
  return (el.localName || el.tagName || '').replace(/^.*:/, '').toLowerCase()
}

function metaText(opfDoc, opfString, local) {
  const nodes = opfDoc.getElementsByTagName('*')
  for (let i = 0; i < nodes.length; i++) {
    if (xmlLocalName(nodes[i]) === local) {
      const t = cleanText(nodes[i].textContent)
      if (t) return t
    }
  }
  const named =
    opfDoc.getElementsByTagName(`dc:${local}`)[0] ||
    opfDoc.getElementsByTagName(local)[0]
  const fromNamed = cleanText(named?.textContent)
  if (fromNamed) return fromNamed

  const re = new RegExp(`<(?:\\w+:)?${local}[^>]*>([^<]+)</(?:\\w+:)?${local}>`, 'i')
  return cleanText(opfString.match(re)?.[1])
}

function findZipFile(zip, path) {
  if (!path) return null
  let file = zip.file(path)
  if (file) return file
  const lower = path.toLowerCase()
  const match = Object.keys(zip.files).find(k => !zip.files[k].dir && k.toLowerCase() === lower)
  return match ? zip.file(match) : null
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function guessMime(path) {
  const ext = path.split('.').pop()?.toLowerCase()
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp',
  })[ext] || 'image/jpeg'
}

async function loadImageDataUrl(zip, imgPath) {
  const file = findZipFile(zip, imgPath)
  if (!file) return null
  try {
    const bytes = await file.async('uint8array')
    const mime = guessMime(imgPath)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return `data:${mime};base64,${btoa(binary)}`
  } catch {
    try {
      const blob = await file.async('blob')
      return await blobToDataUrl(blob)
    } catch {
      return null
    }
  }
}

async function resolveImagesInDoc(doc, zip, sectionDir) {
  const imgs = [...doc.querySelectorAll('img[src]')]
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src')
    if (!src || src.startsWith('data:')) return
    const dataUrl = await loadImageDataUrl(zip, pathJoin(sectionDir, src))
    if (dataUrl) img.setAttribute('src', dataUrl)
  }))
}

function findByFragment(doc, hash) {
  if (!hash) return null
  try {
    const byId = doc.getElementById(hash)
    if (byId) return byId
  } catch { /* invalid id */ }
  try {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(hash) : hash.replace(/"/g, '\\"')
    return doc.querySelector(`[id="${escaped}"], a[name="${escaped}"]`)
  } catch {
    return null
  }
}

function extractBlocks(root) {
  const paragraphs = []
  const seen = new Set()

  const pushText = (text, type = 'text') => {
    const t = cleanText(text)
    if (t.length < 2) return
    if (type === 'text') {
      if (seen.has(t)) return
      seen.add(t)
    }
    paragraphs.push({ type, content: t })
  }

  const pushImage = (img) => {
    const src = img.getAttribute('src')
    if (!src) return
    paragraphs.push({
      type: 'image',
      src,
      alt: img.getAttribute('alt') || '',
    })
  }

  const emitMixed = (el) => {
    el.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const t = cleanText(child.textContent)
        if (t.length >= 2) pushText(t)
        return
      }
      if (child.nodeType !== 1) return
      const ct = child.tagName.toLowerCase()
      if (ct === 'img') {
        pushImage(child)
        return
      }
      if (ct === 'br' || ct === 'wbr') return
      if (child.querySelector?.('img')) emitMixed(child)
      else pushText(child.textContent)
    })
  }

  const walk = (node) => {
    if (!node || node.nodeType !== 1) return
    const tag = node.tagName.toLowerCase()

    if (tag === 'script' || tag === 'style' || tag === 'nav' || tag === 'header' || tag === 'footer') return

    if (tag === 'img') {
      pushImage(node)
      return
    }

    if (/^h[1-6]$/.test(tag)) {
      pushText(node.textContent, 'heading')
      return
    }

    if (tag === 'p' || tag === 'blockquote' || tag === 'li' || tag === 'td' || tag === 'th' || tag === 'figcaption' || tag === 'dt' || tag === 'dd') {
      if (node.querySelector('img')) emitMixed(node)
      else pushText(node.textContent)
      return
    }

    if (
      tag === 'div' || tag === 'section' || tag === 'article' || tag === 'body' ||
      tag === 'figure' || tag === 'main' || tag === 'aside' || tag === 'ul' ||
      tag === 'ol' || tag === 'table' || tag === 'tbody' || tag === 'thead' ||
      tag === 'tr' || tag === 'span' || tag === 'center'
    ) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 1) walk(child)
        else if (child.nodeType === 3) {
          const t = cleanText(child.textContent)
          if (t.length >= 4) pushText(t)
        }
      })
      return
    }

    if (node.querySelector?.('img, p, h1, h2, h3, h4, h5, h6')) {
      Array.from(node.children).forEach(walk)
    } else {
      pushText(node.textContent)
    }
  }

  Array.from(root.childNodes || []).forEach((child) => {
    if (child.nodeType === 1) walk(child)
  })

  return paragraphs
}

function cloneRange(startNode, endNode, body) {
  const fragment = body.ownerDocument.createElement('div')
  if (!startNode) {
    Array.from(body.childNodes).forEach((n) => fragment.appendChild(n.cloneNode(true)))
    return fragment
  }
  let node = startNode
  while (node && node !== endNode) {
    fragment.appendChild(node.cloneNode(true))
    node = node.nextSibling
  }
  return fragment
}

function parseNcxToc(ncxText) {
  const doc = new DOMParser().parseFromString(ncxText, 'application/xml')
  const points = []
  const navPoints = doc.getElementsByTagName('navPoint')
  for (let i = 0; i < navPoints.length; i++) {
    const np = navPoints[i]
    const labels = np.getElementsByTagName('navLabel')
    const texts = labels[0]?.getElementsByTagName('text')
    const label = cleanText(texts?.[0]?.textContent)
    const contents = np.getElementsByTagName('content')
    const src = contents[0]?.getAttribute('src')
    if (label && src) points.push({ label, src })
  }
  return points
}

function parseNavXhtmlToc(navHtml) {
  const doc = new DOMParser().parseFromString(navHtml, 'text/html')
  const nav =
    doc.querySelector('nav[*|type="toc"]') ||
    doc.querySelector('nav[epub\\:type="toc"]') ||
    doc.querySelector('nav#toc, nav.toc') ||
    doc.querySelector('nav')
  const root = nav || doc
  const points = []
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')
    const label = cleanText(a.textContent)
    if (label && href && !href.startsWith('http')) points.push({ label, src: href })
  })
  return points
}

function splitDocByHeadings(doc) {
  const body = doc.body || doc.documentElement
  const headings = [...body.querySelectorAll('h1, h2, h3')].filter((h) => cleanText(h.textContent).length > 0)
  if (headings.length < 2) {
    return [{ title: '', paragraphs: extractBlocks(body), start: null }]
  }

  const chapters = []
  const before = cloneRange(body.firstChild, headings[0], body)
  const beforeBlocks = extractBlocks(before)
  if (beforeBlocks.length > 0) {
    chapters.push({ title: 'Front matter', paragraphs: beforeBlocks })
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]
    const end = headings[i + 1] || null
    const fragment = cloneRange(start, end, body)
    const paragraphs = extractBlocks(fragment)
    if (paragraphs.length === 0) continue
    chapters.push({
      title: cleanText(start.textContent) || `Chapter ${chapters.length + 1}`,
      paragraphs,
    })
  }
  return chapters
}

async function loadHtmlDoc(zip, fullPath) {
  const file = findZipFile(zip, fullPath)
  if (!file) return null
  const html = await file.async('string')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  await resolveImagesInDoc(doc, zip, dirOf(fullPath))
  return doc
}

async function chaptersFromToc(zip, tocPoints, opfDir, spinePaths) {
  const entries = tocPoints.map((p) => {
    const [pathPart, hash] = (p.src || '').split('#')
    return {
      label: p.label,
      fullPath: pathJoin(opfDir, pathPart),
      hash: hash || null,
    }
  }).filter((e) => e.fullPath)

  if (entries.length === 0) return null

  const docCache = new Map()
  const getDoc = async (fullPath) => {
    if (docCache.has(fullPath)) return docCache.get(fullPath)
    const doc = await loadHtmlDoc(zip, fullPath)
    docCache.set(fullPath, doc)
    return doc
  }

  const chapters = []
  const tocPaths = new Set(entries.map((e) => e.fullPath))

  // Spine items not referenced by the TOC (title pages, etc.)
  for (const spinePath of spinePaths) {
    if (tocPaths.has(spinePath)) continue
    const doc = await getDoc(spinePath)
    if (!doc) continue
    const paragraphs = extractBlocks(doc.body || doc.documentElement)
    if (paragraphs.length === 0) continue
    const titleEl = doc.querySelector('h1, h2, title')
    chapters.push({
      title: cleanText(titleEl?.textContent) || 'Front matter',
      paragraphs,
    })
  }

  // Front matter inside the first TOC file, before the first anchor
  const first = entries[0]
  if (first?.hash) {
    const doc = await getDoc(first.fullPath)
    if (doc) {
      const body = doc.body || doc.documentElement
      const startNode = findByFragment(doc, first.hash)
      if (startNode && startNode !== body.firstChild) {
        const before = cloneRange(body.firstChild, startNode, body)
        const paragraphs = extractBlocks(before)
        if (paragraphs.length > 0) {
          chapters.push({ title: 'Dedication', paragraphs })
        }
      }
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i]
    const next = entries[i + 1]
    const doc = await getDoc(cur.fullPath)
    if (!doc) continue
    const body = doc.body || doc.documentElement

    let startNode = cur.hash ? findByFragment(doc, cur.hash) : body.firstChild
    if (!startNode) startNode = body.firstChild

    let endNode = null
    if (next && next.fullPath === cur.fullPath && next.hash) {
      endNode = findByFragment(doc, next.hash)
    }

    const fragment = cloneRange(startNode, endNode, body)
    const paragraphs = extractBlocks(fragment)
    if (paragraphs.length === 0) continue
    chapters.push({
      title: cur.label || `Chapter ${chapters.length + 1}`,
      paragraphs,
    })
  }

  return chapters.length > 0 ? chapters : null
}

async function extractCover(zip, opfDoc, manifest, opfDir) {
  const metaCover = opfDoc.querySelector('meta[name="cover"]')?.getAttribute('content')
  let href = metaCover ? manifest[metaCover]?.href : null

  if (!href) {
    const coverItem = Object.values(manifest).find((item) =>
      /cover/i.test(item.id || '') || /cover/i.test(item.href || '')
    )
    if (coverItem && /image/i.test(coverItem.mediaType || '')) href = coverItem.href
  }

  if (!href) {
    const firstImage = Object.values(manifest).find((item) => /image\//i.test(item.mediaType || ''))
    href = firstImage?.href
  }

  if (!href) return null
  return loadImageDataUrl(zip, pathJoin(opfDir, href))
}

export async function parseEpub(file, folderName = 'My Books') {
  const zip = await JSZip.loadAsync(file)

  const containerFile = findZipFile(zip, 'META-INF/container.xml')
  if (!containerFile) throw new Error('Invalid EPUB (no container.xml)')
  const container = await containerFile.async('string')
  const opfMatch = container.match(/full-path=["']([^"']+)["']/i)
  if (!opfMatch) throw new Error('Invalid EPUB (no OPF path)')
  const opfPath = opfMatch[1]
  const opfDir = dirOf(opfPath)

  const opfFile = findZipFile(zip, opfPath)
  if (!opfFile) throw new Error('Invalid EPUB (OPF missing)')
  const opf = await opfFile.async('string')
  const opfDoc = new DOMParser().parseFromString(opf, 'application/xml')

  const title = metaText(opfDoc, opf, 'title') || (file.name || 'Untitled').replace(/\.epub$/i, '')
  const author = metaText(opfDoc, opf, 'creator') || 'Unknown Author'

  const manifest = {}
  ;[...opfDoc.getElementsByTagName('item')].forEach((item) => {
    const id = item.getAttribute('id')
    if (!id) return
    manifest[id] = {
      id,
      href: item.getAttribute('href') || '',
      mediaType: item.getAttribute('media-type') || item.getAttribute('mediaType') || '',
      properties: item.getAttribute('properties') || '',
    }
  })

  const spinePaths = []
  ;[...opfDoc.getElementsByTagName('itemref')].forEach((ref) => {
    const id = ref.getAttribute('idref')
    const item = manifest[id]
    if (!item) return
    if (item.mediaType && !/html|xhtml|xml/i.test(item.mediaType)) return
    spinePaths.push(pathJoin(opfDir, item.href.split('#')[0]))
  })

  // Prefer NCX / EPUB3 nav TOC for real chapter boundaries
  let tocPoints = []
  const ncxItem = Object.values(manifest).find((item) =>
    /ncx/i.test(item.mediaType) || /\.ncx$/i.test(item.href)
  )
  if (ncxItem) {
    const ncxFile = findZipFile(zip, pathJoin(opfDir, ncxItem.href))
    if (ncxFile) tocPoints = parseNcxToc(await ncxFile.async('string'))
  }

  if (tocPoints.length === 0) {
    const navItem = Object.values(manifest).find((item) =>
      /\bnav\b/i.test(item.properties) || /nav\.xhtml?$/i.test(item.href)
    )
    if (navItem) {
      const navFile = findZipFile(zip, pathJoin(opfDir, navItem.href))
      if (navFile) tocPoints = parseNavXhtmlToc(await navFile.async('string'))
    }
  }

  let chapters = null
  if (tocPoints.length >= 2) {
    chapters = await chaptersFromToc(zip, tocPoints, opfDir, spinePaths)
  }

  // Fallback: spine files, splitting large single-file books by headings
  if (!chapters || chapters.length === 0) {
    chapters = []
    for (const fullPath of spinePaths) {
      const doc = await loadHtmlDoc(zip, fullPath)
      if (!doc) continue
      const parts = splitDocByHeadings(doc)
      for (const part of parts) {
        if (!part.paragraphs.length) continue
        chapters.push({
          title: part.title || `Chapter ${chapters.length + 1}`,
          paragraphs: part.paragraphs,
        })
      }
    }
  }

  // Drop empty / junk title-only chapters that have no real text or images
  chapters = chapters.filter((ch) =>
    ch.paragraphs.some((p) => p.type === 'image' || (p.content && p.content.length >= 2))
  )

  if (chapters.length === 0) throw new Error('No readable content found in EPUB')

  chapters = chapters.map((ch, i) => ({
    title: ch.title || `Chapter ${i + 1}`,
    paragraphs: ch.paragraphs,
  }))

  const coverDataUrl = await extractCover(zip, opfDoc, manifest, opfDir)

  return {
    title,
    author,
    chapters,
    category: folderName,
    coverDataUrl: coverDataUrl || null,
    parserVersion: PARSER_VERSION,
  }
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
