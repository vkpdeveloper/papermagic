import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { parseHTML } from 'linkedom'
import { XMLParser } from 'fast-xml-parser'
import mupdf from 'mupdf'
import TurndownService from 'turndown'
import * as TurndownPluginGfm from 'turndown-plugin-gfm'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { chromium } from 'playwright'
import Firecrawl from '@mendable/firecrawl-js'
import {
  UNREADABLE_IMPORT_MESSAGE,
  buildDocument,
  createId,
  extractTitleFromMarkdown,
  markdownToBlocks,
  splitBlocksIntoChapters,
} from '../src/content'
import type { Chapter, DocumentRecord, ReaderBlock } from '../src/types'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
})

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

const WEB_REQUEST_TIMEOUT_MS = 25_000
const BROWSER_REQUEST_TIMEOUT_MS = 45_000
const WEB_MIN_MARKDOWN_CHARS = 380
const WEB_DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function normalizeSourceUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.')
  }
  parsed.hash = ''
  return parsed.toString()
}

function fallbackTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const slug = parsed.pathname.split('/').filter(Boolean).pop()
    if (slug) {
      return friendlyFilenameTitle(slug)
    }
    return parsed.hostname.replace(/^www\./i, '')
  } catch {
    return 'Web Article'
  }
}

function absolutizeUrl(candidate: string, baseUrl: string): string {
  try {
    return new URL(candidate, baseUrl).toString()
  } catch {
    return candidate
  }
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    bulletListMarker: '-',
    linkStyle: 'inlined',
    strongDelimiter: '**',
  })

  turndown.remove(['script', 'style', 'noscript', 'iframe'])
  turndown.remove((node) => node.nodeName === 'SVG')
  turndown.keep(['sub', 'sup'])
  turndown.use(TurndownPluginGfm.gfm)

  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface ParsedWebArticle {
  title: string
  author: string
  markdown: string
  excerpt?: string
  coverImageUrl?: string
}

function parseWebArticleFromHtml(html: string, sourceUrl: string): ParsedWebArticle {
  const dom = new JSDOM(html, { url: sourceUrl })
  const doc = dom.window.document
  const readability = new Readability(doc.cloneNode(true) as Document, {
    charThreshold: 220,
    keepClasses: false,
  })
  const article = readability.parse()
  const articleHtml =
    article?.content ??
    doc.querySelector('article, main, [role="main"], body')?.innerHTML ??
    ''
  const markdown = htmlToMarkdown(articleHtml)

  const title =
    normalizeWhitespace(
      article?.title ??
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
      doc.title ??
      '',
    ) || fallbackTitleFromUrl(sourceUrl)
  const author =
    normalizeWhitespace(
      article?.byline ??
      doc.querySelector('meta[name="author"]')?.getAttribute('content') ??
      doc.querySelector('meta[property="article:author"]')?.getAttribute('content') ??
      '',
    ) || 'Web import'
  const coverImageUrl = normalizeWhitespace(
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ??
    '',
  )

  return {
    title,
    author,
    markdown,
    excerpt: article?.excerpt ?? undefined,
    coverImageUrl: coverImageUrl ? absolutizeUrl(coverImageUrl, sourceUrl) : undefined,
  }
}

function isReadableMarkdown(markdown: string): boolean {
  return markdown.length >= WEB_MIN_MARKDOWN_CHARS || markdown.split(/\s+/).filter(Boolean).length >= 90
}

async function fetchHtmlWithTimeout(url: string): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), WEB_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': WEB_DESKTOP_USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return await response.text()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchRenderedHtmlWithBrowser(url: string): Promise<{ html: string; finalUrl: string }> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const context = await browser.newContext({
      userAgent: WEB_DESKTOP_USER_AGENT,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    const page = await context.newPage()

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_REQUEST_TIMEOUT_MS })
    await page.waitForTimeout(1_200)
    await page.mouse.move(320, 260, { steps: 18 })
    await page.mouse.wheel(0, 520)
    await page.waitForTimeout(700)
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.75))
    })
    await page.waitForTimeout(900)

    const html = await page.content()
    const finalUrl = page.url()
    await context.close()
    return { html, finalUrl }
  } finally {
    await browser.close()
  }
}

async function fetchMarkdownFromFirecrawl(url: string, apiKey: string): Promise<ParsedWebArticle> {
  const client = new Firecrawl({ apiKey })
  const scraped = await client.scrape(url, {
    formats: ['markdown'],
    onlyMainContent: true,
  })
  const markdown = (scraped.markdown ?? '').trim()
  if (!markdown) {
    throw new Error('Firecrawl did not return markdown content.')
  }

  const title = normalizeWhitespace(scraped.metadata?.title ?? '') || extractTitleFromMarkdown(markdown, fallbackTitleFromUrl(url))
  const author = 'Web import'
  const coverImageUrl = normalizeWhitespace(scraped.metadata?.ogImage?.toString() ?? '')

  return {
    title,
    author,
    markdown,
    coverImageUrl: coverImageUrl || undefined,
    excerpt: normalizeWhitespace(scraped.metadata?.description?.toString() ?? '') || undefined,
  }
}

export function friendlyFilenameTitle(filename: string): string {
  return filename
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function ensureReadableBlocks(blocks: ReaderBlock[], fallbackTitle: string): ReaderBlock[] {
  if (blocks.length > 0) {
    return blocks
  }

  return [
    {
      id: createId('block'),
      type: 'heading',
      level: 2,
      text: fallbackTitle,
    },
    {
      id: createId('block'),
      type: 'paragraph',
      text: UNREADABLE_IMPORT_MESSAGE,
    },
  ]
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'
}

async function createCacheDirectory(libraryRoot: string, documentId: string): Promise<string> {
  const directory = path.join(libraryRoot, documentId)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

function resolvePosixPath(basePath: string, target: string): string {
  const [pathname] = target.split('#')
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePath), pathname))
}

async function persistCoverBuffer(
  cacheDirectory: string,
  fileName: string,
  imageBuffer: Uint8Array | Buffer,
): Promise<string> {
  const targetPath = path.join(cacheDirectory, fileName)
  await fs.writeFile(targetPath, imageBuffer)
  return pathToFileURL(targetPath).toString()
}

function domRootFromHtml(html: string) {
  const { document } = parseHTML(html)
  ;['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'noscript', 'iframe', 'svg'].forEach(
    (selector) => {
      document.querySelectorAll(selector).forEach((node) => node.remove())
    },
  )

  const root =
    document.querySelector('article, main, body') ??
    document.body ??
    (document.documentElement as Element | null) ??
    document.firstElementChild
  return { document, root }
}

function inlineToMarkdown(node: Element | ChildNode): string {
  const TEXT_NODE = 3
  if (node.nodeType === TEXT_NODE) {
    return node.textContent ?? ''
  }
  const el = node as Element
  const tagName = el.tagName?.toLowerCase() ?? ''
  const children = () => Array.from(el.childNodes).map(inlineToMarkdown).join('')

  if (tagName === 'br') return ' '
  if (tagName === 'em' || tagName === 'i') return `*${children()}*`
  if (tagName === 'strong' || tagName === 'b') return `**${children()}**`
  if (tagName === 'code') return `\`${children()}\``
  if (tagName === 'a') {
    const href = el.getAttribute('href') ?? ''
    const text = children()
    return href ? `[${text}](${href})` : text
  }
  return children()
}

function htmlToBlocks(html: string): ReaderBlock[] {
  const { root } = domRootFromHtml(html)

  if (!root) {
    return []
  }

  const blocks: ReaderBlock[] = []

  const pushTextBlock = (type: ReaderBlock['type'], text: string, level?: number) => {
    const cleaned = normalizeWhitespace(text)
    if (!cleaned) {
      return
    }

    blocks.push({
      id: createId('block'),
      type,
      text: cleaned,
      level,
    })
  }

  const walk = (node: Element) => {
    const tagName = node.tagName.toLowerCase()

    if (tagName === 'br') {
      return
    }

    if (tagName === 'p') {
      pushTextBlock('paragraph', inlineToMarkdown(node))
      return
    }

    if (/^h[1-6]$/.test(tagName)) {
      pushTextBlock('heading', inlineToMarkdown(node), Number(tagName[1]))
      return
    }

    if (tagName === 'blockquote') {
      pushTextBlock('quote', inlineToMarkdown(node))
      return
    }

    if (tagName === 'pre') {
      blocks.push({
        id: createId('block'),
        type: 'code',
        text: normalizeWhitespace(node.textContent ?? ''),
      })
      return
    }

    if (tagName === 'ul' || tagName === 'ol') {
      const ordered = tagName === 'ol'
      const items = Array.from(node.children)
        .filter((child) => child.tagName.toLowerCase() === 'li')
        .map((item) => normalizeWhitespace(inlineToMarkdown(item)))
        .filter(Boolean)

      if (items.length > 0) {
        blocks.push({
          id: createId('block'),
          type: 'list',
          items,
          ordered,
        })
      }
      return
    }

    if (tagName === 'img') {
      const source = node.getAttribute('src')
      const alt = node.getAttribute('alt') ?? 'Imported image'

      if (source) {
        blocks.push({
          id: createId('block'),
          type: 'image',
          src: source,
          alt,
          caption: alt,
        })
      }
      return
    }

    if (tagName === 'div' || tagName === 'section' || tagName === 'article' || tagName === 'main') {
      Array.from(node.children).forEach((child) => {
        walk(child)
      })
      return
    }

    Array.from(node.children).forEach((child) => {
      walk(child)
    })
  }

  walk(root as Element)

  if (blocks.length === 0 && normalizeWhitespace(root.textContent ?? '')) {
    blocks.push({
      id: createId('block'),
      type: 'paragraph',
      text: normalizeWhitespace(root.textContent ?? ''),
    })
  }

  return blocks
}

function textFromXmlValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return textFromXmlValue(value[0])
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>
    return String(candidate['#text'] ?? candidate['__text'] ?? '')
  }

  return ''
}


// ─── Cover image ─────────────────────────────────────────────────────────────

async function renderMuPageAsCover(doc: InstanceType<typeof mupdf.Document>, cacheDirectory: string): Promise<string | undefined> {
  const pageCount = doc.countPages()

  for (const pageIndex of [0, 1]) {
    if (pageIndex >= pageCount) break

    const page = doc.loadPage(pageIndex)
    const bounds = page.getBounds()           // [x0, y0, x1, y1]
    const pageWidth = bounds[2] - bounds[0]
    const pageHeight = bounds[3] - bounds[1]

    // Scale so the longer side is 900px (good cover thumbnail quality)
    const scale = 900 / Math.max(pageWidth, pageHeight)
    const matrix = mupdf.Matrix.scale(scale, scale)
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)

    // Blank-page guard: check that at least 1% of pixels are non-white
    const pixels = pixmap.getPixels()
    let nonWhite = 0
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240) {
        nonWhite += 1
      }
    }
    const totalPixels = pixmap.getWidth() * pixmap.getHeight()
    if (nonWhite / totalPixels < 0.01) {
      continue
    }

    const jpegBytes = pixmap.asJPEG(85)
    const coverPath = path.join(cacheDirectory, 'cover.jpg')
    await fs.writeFile(coverPath, jpegBytes)
    return pathToFileURL(coverPath).toString()
  }

  return undefined
}

// ─── Outline helpers ──────────────────────────────────────────────────────────

interface OutlineItem {
  title: string | undefined
  uri: string | undefined
  open: boolean
  down?: OutlineItem[]
  page?: number
}

interface OutlineEntry {
  title: string
  page: number
  depth: number
}

function extractOutlineEntries(outline: OutlineItem[] | null): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  const seenPages = new Set<number>()

  const walk = (items: OutlineItem[], depth: number) => {
    for (const item of items) {
      const title = normalizeWhitespace(item.title ?? '')
      if (typeof item.page === 'number' && item.page >= 0 && title) {
        const pageNumber = item.page + 1
        if (!seenPages.has(pageNumber)) {
          seenPages.add(pageNumber)
          entries.push({ title, page: pageNumber, depth })
        }
      }
      if (item.down && item.down.length > 0) walk(item.down, depth + 1)
    }
  }

  if (outline && outline.length > 0) walk(outline, 0)
  return entries
}

// ─── Top-level PDF importer (image rendering — kept as fallback) ──────────────

// Render scale for page images: 1.8× gives ~130 DPI for a US-letter page (~1530px wide)
const PDF_RENDER_SCALE = 1.8

export async function importPdfAsImages(
  filePath: string,
  cacheDirectory: string,
  onUpdate?: (doc: DocumentRecord) => void,
): Promise<DocumentRecord> {
  const extension = path.extname(filePath)
  const sourceCopyPath = path.join(cacheDirectory, `source${extension || '.pdf'}`)
  const pdfBuffer = await fs.readFile(filePath)
  await fs.writeFile(sourceCopyPath, pdfBuffer)

  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
  const pageCount = doc.countPages()

  // Cover thumbnail
  const coverImageUrl = await renderMuPageAsCover(doc, cacheDirectory)

  // Metadata
  const rawTitle = doc.getMetaData(mupdf.Document.META_INFO_TITLE) ?? ''
  const rawAuthor = doc.getMetaData(mupdf.Document.META_INFO_AUTHOR) ?? ''
  const fallbackTitle = friendlyFilenameTitle(path.basename(filePath, extension)) || 'Imported PDF'
  const title = normalizeWhitespace(rawTitle) || fallbackTitle
  const author = normalizeWhitespace(rawAuthor) || 'PDF import'
  const importedAt = new Date().toISOString()
  const docId = path.basename(cacheDirectory)

  // Extract outline before rendering pages so we can pre-allocate stable chapter IDs for streaming
  const rawOutline = doc.loadOutline() as OutlineItem[] | null
  const outlineEntries = extractOutlineEntries(rawOutline)
  const outlineMap = new Map(outlineEntries.map((e) => [e.page, e]))
  const depthByPage = new Map(outlineEntries.map((e) => [e.page, e.depth]))

  // Pre-allocate chapters with stable IDs using the same boundary logic as the final build.
  // A new chapter starts at page 1 and at every page that has an outline entry.
  type StreamChapter = Chapter & { startPage: number }
  const streamChapters: StreamChapter[] = []
  for (let p = 1; p <= pageCount; p++) {
    const entry = outlineEntries.length > 0 ? outlineMap.get(p) : undefined
    const isChapterStart = streamChapters.length === 0 || !!entry
    if (isChapterStart) {
      streamChapters.push({
        id: createId('chapter'),
        title: entry?.title ?? (streamChapters.length === 0 ? fallbackTitle : `Section ${streamChapters.length + 1}`),
        content: [],
        outlineDepth: entry ? (depthByPage.get(p) ?? 0) : 0,
        startPage: p,
      })
    }
  }
  if (streamChapters.length === 0) {
    streamChapters.push({ id: createId('chapter'), title: fallbackTitle, content: [], outlineDepth: 0, startPage: 1 })
  }

  const buildCurrentDoc = () => {
    const chapters = streamChapters
      .filter((c) => c.content.length > 0)
      .map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        content: chapter.content,
        outlineDepth: chapter.outlineDepth,
      }))
    return buildDocument({
      id: docId,
      title,
      author,
      description: 'PDF rendered as page images.',
      sourceType: 'pdf',
      preferredMode: 'scroll',
      originLabel: filePath,
      extractedWith: 'MuPDF image rendering',
      chapters,
      metadata: { importedAt, coverImageUrl, sourcePath: filePath, cacheDirectory },
    })
  }

  // Send initial stub (cover + title visible, no pages yet)
  if (onUpdate) onUpdate(buildCurrentDoc())

  // Fire onUpdate at most every UPDATE_EVERY pages to reduce IPC overhead.
  // The initial call above already resolved the stub; subsequent calls stream pages in.
  const UPDATE_EVERY = Math.max(1, Math.ceil(pageCount / 20))

  // Render each page as a JPEG image
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i)
    const bounds = page.getBounds()
    const pageWidth = bounds[2] - bounds[0]
    const pageHeight = bounds[3] - bounds[1]
    const matrix = mupdf.Matrix.scale(PDF_RENDER_SCALE, PDF_RENDER_SCALE)
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)
    const jpegBytes = pixmap.asJPEG(88)
    const fileName = `page-${String(i + 1).padStart(4, '0')}.jpg`
    const imagePath = path.join(cacheDirectory, fileName)
    await fs.writeFile(imagePath, jpegBytes)
    const block: ReaderBlock = {
      id: createId('block'),
      type: 'pdf-page',
      src: pathToFileURL(imagePath).toString(),
      pageNumber: i + 1,
      pageWidth,
      pageHeight,
    }

    // Assign block to its pre-allocated chapter (last chapter whose startPage <= current page)
    let targetChapter = streamChapters[0]
    for (const c of streamChapters) {
      if (c.startPage <= i + 1) targetChapter = c
      else break
    }
    targetChapter.content.push(block)

    if (onUpdate && ((i + 1) % UPDATE_EVERY === 0 || i === pageCount - 1)) {
      onUpdate(buildCurrentDoc())
    }
    await delay()
  }

  return buildCurrentDoc()
}


interface EpubTocEntry {
  title: string
  depth: number
}

async function extractEpubToc(
  zip: JSZip,
  opfPath: string,
  manifest: Map<string, string>,
  packageRecord: Record<string, unknown>,
): Promise<Map<string, EpubTocEntry>> {
  const toc = new Map<string, EpubTocEntry>()

  // ── EPUB 3: find item with properties="nav" ──────────────────────────────
  const manifestItems = toArray((packageRecord.manifest as Record<string, unknown>)?.item) as Array<Record<string, unknown>>
  const navItem = manifestItems.find((item) => {
    const props = String(item['@_properties'] ?? '').split(/\s+/)
    return props.includes('nav')
  })

  if (navItem) {
    const navHref = String(navItem['@_href'] ?? '').trim()
    if (navHref) {
      const navPath = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), navHref))
      const navFile = zip.file(navPath)
      if (navFile) {
        const navMarkup = await navFile.async('text')
        const { document } = parseHTML(navMarkup)

        // Find the toc nav — prefer epub:type="toc", fall back to first <nav>
        const tocNav =
          document.querySelector('nav[epub\\:type="toc"]') ??
          document.querySelector('nav[epub:type="toc"]') ??
          document.querySelector('nav')

        if (tocNav) {
          const walkNavOl = (ol: Element, depth: number) => {
            for (const li of Array.from(ol.children)) {
              if (li.tagName.toLowerCase() !== 'li') continue
              const anchor = li.querySelector('a')
              const href = anchor?.getAttribute('href')
              const title = normalizeWhitespace(anchor?.textContent ?? '')
              if (href && title) {
                // Strip fragment so path lookup works; keep for navigation
                const hrefNoFragment = href.split('#')[0]
                const resolved = hrefNoFragment
                  ? resolvePosixPath(navPath, hrefNoFragment)
                  : navPath
                if (!toc.has(resolved)) {
                  toc.set(resolved, { title, depth })
                }
              }
              // Recurse into nested <ol>
              const nestedOl = li.querySelector('ol')
              if (nestedOl) walkNavOl(nestedOl, depth + 1)
            }
          }

          const rootOl = tocNav.querySelector('ol')
          if (rootOl) walkNavOl(rootOl, 0)
        }
      }
    }
  }

  // ── EPUB 2: NCX fallback ─────────────────────────────────────────────────
  if (toc.size === 0) {
    // Try to find NCX via spine toc attribute first, then by media-type/extension
    const spineTocId = String((packageRecord.spine as Record<string, unknown>)?.['@_toc'] ?? '').trim()
    const ncxPathFromSpine = spineTocId ? manifest.get(spineTocId) : undefined
    const ncxPathFromExtension = Array.from(manifest.values()).find((p) => p.endsWith('.ncx'))
    const ncxPath = ncxPathFromSpine ?? ncxPathFromExtension

    if (ncxPath) {
      const ncxFile = zip.file(ncxPath)
      if (ncxFile) {
        const ncxMarkup = await ncxFile.async('text')
        const parsed = xmlParser.parse(ncxMarkup) as Record<string, unknown>

        const walkNcx = (node: unknown, depth: number) => {
          const points = toArray((node as Record<string, unknown>)?.navPoint)
          points.forEach((point) => {
            const pointRecord = point as Record<string, unknown>
            const src = String((pointRecord.content as Record<string, unknown>)?.['@_src'] ?? '').trim()
            const label = textFromXmlValue((pointRecord.navLabel as Record<string, unknown>)?.text)
            if (src && label) {
              const srcNoFragment = src.split('#')[0]
              const resolved = srcNoFragment ? resolvePosixPath(ncxPath, srcNoFragment) : ncxPath
              if (!toc.has(resolved)) {
                toc.set(resolved, { title: label, depth })
              }
            }
            // Recurse for nested navPoints
            walkNcx(pointRecord, depth + 1)
          })
        }

        walkNcx((parsed.ncx as Record<string, unknown>)?.navMap, 0)
      }
    }
  }

  return toc
}

async function rewriteEpubImages(
  zip: JSZip,
  chapterPath: string,
  cacheDirectory: string,
  html: string,
): Promise<string> {
  const { document, root } = domRootFromHtml(html)
  const scope = root ?? document.body

  if (!scope) {
    return html
  }

  let imageIndex = 0
  const chapterSlug = slugify(path.posix.basename(chapterPath, path.posix.extname(chapterPath)))

  for (const image of Array.from(scope.querySelectorAll('img'))) {
    const source = image.getAttribute('src')
    if (!source) {
      continue
    }

    const resolvedPath = resolvePosixPath(chapterPath, source)
    const imageFile = zip.file(resolvedPath)

    if (!imageFile) {
      continue
    }

    const imageBuffer = Buffer.from(await imageFile.async('uint8array'))
    const extension = path.extname(resolvedPath) || '.img'
    const targetPath = path.join(cacheDirectory, `epub-${chapterSlug}-image-${imageIndex}${extension}`)
    await fs.writeFile(targetPath, imageBuffer)
    image.setAttribute('src', pathToFileURL(targetPath).toString())
    imageIndex += 1
  }

  return document.toString()
}

interface EpubManifestItemRecord {
  id: string
  href: string
  path: string
  mediaType: string
  properties: string[]
}

function normalizeEpubManifestItems(
  manifestItems: Array<Record<string, unknown>>,
  opfPath: string,
): {
  manifestById: Map<string, string>
  manifestByPath: Map<string, EpubManifestItemRecord>
  records: EpubManifestItemRecord[]
} {
  const manifestById = new Map<string, string>()
  const manifestByPath = new Map<string, EpubManifestItemRecord>()
  const records: EpubManifestItemRecord[] = []

  manifestItems.forEach((entry) => {
    const id = String(entry['@_id'] ?? '').trim()
    const href = String(entry['@_href'] ?? '').trim()

    if (!id || !href) {
      return
    }

    const record: EpubManifestItemRecord = {
      id,
      href,
      path: path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href)),
      mediaType: String(entry['@_media-type'] ?? '').trim().toLowerCase(),
      properties: String(entry['@_properties'] ?? '')
        .split(/\s+/)
        .map((property) => property.trim().toLowerCase())
        .filter(Boolean),
    }

    manifestById.set(id, record.path)
    manifestByPath.set(record.path, record)
    records.push(record)
  })

  return { manifestById, manifestByPath, records }
}

function isEpubImageAsset(record: Pick<EpubManifestItemRecord, 'mediaType' | 'path'>): boolean {
  return (
    record.mediaType.startsWith('image/') ||
    /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(path.posix.basename(record.path))
  )
}

function isEpubMarkupAsset(record: Pick<EpubManifestItemRecord, 'mediaType' | 'path'>): boolean {
  return (
    ['application/xhtml+xml', 'text/html', 'application/xml', 'text/xml'].includes(record.mediaType) ||
    /\.(xhtml|html?|xml)$/i.test(path.posix.basename(record.path))
  )
}

function coverHintScore(value: string): number {
  const normalizedValue = value.toLowerCase()
  let score = 0

  if (/front[-_ ]?cover|cover[-_ ]?image|^cover$/.test(normalizedValue)) {
    score += 500
  }

  if (/cover/.test(normalizedValue)) {
    score += 250
  }

  if (/title[-_ ]?page|titlepage/.test(normalizedValue)) {
    score += 120
  }

  if (/thumb|thumbnail|icon|logo/.test(normalizedValue)) {
    score -= 180
  }

  return score
}

function scoreEpubCoverCandidate(record: EpubManifestItemRecord): number {
  let score = 0

  if (record.properties.includes('cover-image')) {
    score += 1_000
  }

  if (isEpubImageAsset(record)) {
    score += 150
  } else if (isEpubMarkupAsset(record)) {
    score += 90
  }

  score += coverHintScore(record.id)
  score += coverHintScore(record.href)
  score += coverHintScore(path.posix.basename(record.path))

  return score
}

function resolveEpubGuideCoverPath(packageRecord: Record<string, unknown>, opfPath: string): string | undefined {
  const guideEntries = toArray((packageRecord.guide as Record<string, unknown> | undefined)?.reference)

  const guideCoverEntry = guideEntries.find((entry) => {
    const record = entry as Record<string, unknown>
    return String(record['@_type'] ?? '').toLowerCase() === 'cover'
  }) as Record<string, unknown> | undefined

  const href = String(guideCoverEntry?.['@_href'] ?? '').trim()
  return href ? resolvePosixPath(opfPath, href) : undefined
}

function resolveEpubCoverCandidatePaths(
  metadata: Record<string, unknown>,
  packageRecord: Record<string, unknown>,
  manifestRecords: EpubManifestItemRecord[],
  manifestById: Map<string, string>,
  opfPath: string,
): string[] {
  const metadataEntries = toArray(metadata.meta).map((entry) => entry as Record<string, unknown>)
  const explicitCoverId = metadataEntries.find((entry) => String(entry['@_name'] ?? '').toLowerCase() === 'cover')?.[
    '@_content'
  ]
  const explicitCoverPath =
    typeof explicitCoverId === 'string' && manifestById.has(explicitCoverId) ? manifestById.get(explicitCoverId) : undefined
  const manifestCoverPath = manifestRecords.find((record) => record.properties.includes('cover-image'))?.path
  const guideCoverPath = resolveEpubGuideCoverPath(packageRecord, opfPath)

  const rankedFallbackPaths = manifestRecords
    .map((record) => ({ path: record.path, score: scoreEpubCoverCandidate(record) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.path)

  return Array.from(
    new Set(
      [explicitCoverPath, manifestCoverPath, guideCoverPath, ...rankedFallbackPaths].filter(
        (candidatePath): candidatePath is string => typeof candidatePath === 'string' && candidatePath.length > 0,
      ),
    ),
  )
}

async function persistEpubCoverAsset(
  zip: JSZip,
  coverPath: string,
  cacheDirectory: string,
): Promise<string | undefined> {
  const coverFile = zip.file(coverPath)

  if (!coverFile) {
    return undefined
  }

  const imageBuffer = Buffer.from(await coverFile.async('uint8array'))
  const extension = path.extname(coverPath) || '.img'
  return persistCoverBuffer(cacheDirectory, `cover${extension}`, imageBuffer)
}

function scoreEpubEmbeddedCoverCandidate(node: Element): number {
  const descriptor = [
    node.getAttribute('src'),
    node.getAttribute('href'),
    node.getAttribute('xlink:href'),
    node.getAttribute('data'),
    node.getAttribute('alt'),
    node.getAttribute('title'),
    node.getAttribute('id'),
    node.getAttribute('class'),
  ]
    .filter(Boolean)
    .join(' ')

  const width = Number(node.getAttribute('width') ?? 0)
  const height = Number(node.getAttribute('height') ?? 0)
  let score = width > 0 && height > 0 ? width * height : 0

  score += coverHintScore(descriptor)
  return score
}

async function extractEpubCoverFromMarkup(
  zip: JSZip,
  coverPath: string,
  cacheDirectory: string,
): Promise<string | undefined> {
  const coverFile = zip.file(coverPath)

  if (!coverFile) {
    return undefined
  }

  const markup = await coverFile.async('text')
  const { document } = parseHTML(markup)
  const candidates = Array.from(document.querySelectorAll('img, image, object'))
    .map((node) => {
      const source =
        node.getAttribute('src') ??
        node.getAttribute('href') ??
        node.getAttribute('xlink:href') ??
        node.getAttribute('data')

      return {
        score: scoreEpubEmbeddedCoverCandidate(node),
        source: source?.trim() ?? '',
      }
    })
    .filter((candidate) => candidate.source.length > 0)
    .sort((left, right) => right.score - left.score)

  for (const candidate of candidates) {
    const resolvedPath = resolvePosixPath(coverPath, candidate.source)
    const extension = path.extname(resolvedPath).toLowerCase()

    if (/\.(xhtml|html?|xml)$/i.test(extension)) {
      continue
    }

    const persistedCoverUrl = await persistEpubCoverAsset(zip, resolvedPath, cacheDirectory)
    if (persistedCoverUrl) {
      return persistedCoverUrl
    }
  }

  return undefined
}

async function extractEpubCoverImage(
  zip: JSZip,
  candidatePaths: string[],
  manifestByPath: Map<string, EpubManifestItemRecord>,
  cacheDirectory: string,
): Promise<string | undefined> {
  for (const coverPath of candidatePaths) {
    const manifestRecord = manifestByPath.get(coverPath)

    if (manifestRecord && isEpubImageAsset(manifestRecord)) {
      const persistedCoverUrl = await persistEpubCoverAsset(zip, coverPath, cacheDirectory)
      if (persistedCoverUrl) {
        return persistedCoverUrl
      }
    }

    if (!manifestRecord || isEpubMarkupAsset(manifestRecord)) {
      const persistedCoverUrl = await extractEpubCoverFromMarkup(zip, coverPath, cacheDirectory)
      if (persistedCoverUrl) {
        return persistedCoverUrl
      }
    }
  }

  return undefined
}

function chapterTitleFromBlocks(blocks: ReaderBlock[], fallbackTitle: string): string {
  const firstHeading = blocks.find((block) => block.type === 'heading' && normalizeWhitespace(block.text ?? '').length > 0)
  return normalizeWhitespace(firstHeading?.text ?? fallbackTitle) || fallbackTitle
}

function stripDuplicateLeadingHeading(blocks: ReaderBlock[], title: string): ReaderBlock[] {
  if (blocks.length === 0) {
    return blocks
  }

  const [firstBlock, ...rest] = blocks
  if (firstBlock.type === 'heading' && normalizeWhitespace(firstBlock.text ?? '') === normalizeWhitespace(title)) {
    return rest
  }

  return blocks
}

function isSkippableEpubSection(title: string, blocks: ReaderBlock[]): boolean {
  const normalizedTitle = normalizeWhitespace(title).toLowerCase()

  if (/^(cover|title page|contents|table of contents|copyright|follow .+|brand page)$/i.test(normalizedTitle)) {
    return true
  }

  const meaningfulTextBlocks = blocks.filter((block) => ['paragraph', 'quote', 'list', 'code'].includes(block.type))
  const imageBlocks = blocks.filter((block) => block.type === 'image')

  if (meaningfulTextBlocks.length === 0 && imageBlocks.length <= 1) {
    return true
  }

  return false
}

function appendBlocksToChapter(chapter: Chapter, blocks: ReaderBlock[]): void {
  const nextBlocks = chapter.content.length === 0 ? blocks : stripDuplicateLeadingHeading(blocks, chapter.title)
  chapter.content.push(...nextBlocks)
}

function finalizeChapter(chapter: Chapter | null, target: Chapter[]): void {
  if (!chapter || chapter.content.length === 0 || isSkippableEpubSection(chapter.title, chapter.content)) {
    return
  }

  target.push(chapter)
}

interface EpubSegment {
  title: string
  blocks: ReaderBlock[]
  startsChapter: boolean
  outlineDepth: number
}

function mergeEpubSegments(title: string, segments: EpubSegment[]): Chapter[] {
  const chapters: Chapter[] = []
  let currentChapter: Chapter | null = null

  for (const segment of segments) {
    const nextTitle = normalizeWhitespace(segment.title) || chapterTitleFromBlocks(segment.blocks, title)
    const shouldStartNewChapter = segment.startsChapter

    if (!currentChapter || shouldStartNewChapter) {
      finalizeChapter(currentChapter, chapters)
      currentChapter = {
        id: createId('chapter'),
        title: nextTitle,
        content: [],
        outlineDepth: segment.outlineDepth,
      }
    }

    appendBlocksToChapter(currentChapter, segment.blocks)
  }

  finalizeChapter(currentChapter, chapters)
  return chapters
}

async function importEpub(filePath: string, cacheDirectory: string): Promise<DocumentRecord> {
  const extension = path.extname(filePath)
  const sourceCopyPath = path.join(cacheDirectory, `source${extension || '.epub'}`)
  const epubBuffer = await fs.readFile(filePath)
  await fs.writeFile(sourceCopyPath, epubBuffer)

  const zip = await JSZip.loadAsync(epubBuffer)
  const containerXml = await zip.file('META-INF/container.xml')?.async('text')

  if (!containerXml) {
    throw new Error('The EPUB container.xml file is missing.')
  }

  const container = xmlParser.parse(containerXml) as Record<string, unknown>
  const rootfiles = ((container.container as Record<string, unknown>)?.rootfiles ?? {}) as Record<string, unknown>
  const rootfile = rootfiles.rootfile as Record<string, unknown> | undefined
  const opfPath = String(rootfile?.['@_full-path'] ?? '')

  if (!opfPath) {
    throw new Error('The EPUB package document could not be located.')
  }

  const packageXml = await zip.file(opfPath)?.async('text')

  if (!packageXml) {
    throw new Error('The EPUB package document is unreadable.')
  }

  const parsedPackage = xmlParser.parse(packageXml) as Record<string, unknown>
  const packageRecord = parsedPackage.package as Record<string, unknown>
  const metadata = packageRecord.metadata as Record<string, unknown>
  const manifestItems = toArray((packageRecord.manifest as Record<string, unknown>)?.item)
  const { manifestById, manifestByPath, records: manifestRecords } = normalizeEpubManifestItems(
    manifestItems as Array<Record<string, unknown>>,
    opfPath,
  )
  const epubCoverCandidatePaths = resolveEpubCoverCandidatePaths(
    metadata,
    packageRecord,
    manifestRecords,
    manifestById,
    opfPath,
  )
  const explicitCoverImageUrl = await extractEpubCoverImage(
    zip,
    epubCoverCandidatePaths,
    manifestByPath,
    cacheDirectory,
  )

  const tocMap = await extractEpubToc(zip, opfPath, manifestById, packageRecord)
  const spineItems = toArray((packageRecord.spine as Record<string, unknown>)?.itemref)
  const segments: EpubSegment[] = []

  for (const [index, itemRef] of spineItems.entries()) {
    const idref = String((itemRef as Record<string, unknown>)['@_idref'] ?? '')
    const chapterPath = manifestById.get(idref)

    if (!chapterPath) {
      continue
    }

    const chapterFile = zip.file(chapterPath)
    if (!chapterFile) {
      continue
    }

    const chapterMarkup = await chapterFile.async('text')
    const htmlWithLocalImages = await rewriteEpubImages(zip, chapterPath, cacheDirectory, chapterMarkup)
    const tocEntry = tocMap.get(chapterPath)
    const explicitTitle = tocEntry?.title ?? ''
    const fallbackTitle = explicitTitle || `Section ${index + 1}`
    const blocks = htmlToBlocks(htmlWithLocalImages)

    if (blocks.length === 0) {
      continue
    }

    segments.push({
      title: explicitTitle || chapterTitleFromBlocks(blocks, fallbackTitle),
      blocks,
      startsChapter:
        Boolean(explicitTitle) ||
        (blocks[0]?.type === 'heading' && Math.min(blocks[0].level ?? 2, 2) <= 2),
      outlineDepth: tocEntry?.depth ?? 0,
    })

    await delay()
  }

  const title = textFromXmlValue(metadata['dc:title']) || friendlyFilenameTitle(path.basename(filePath, extension)) || 'Imported EPUB'
  const author = textFromXmlValue(metadata['dc:creator']) || 'EPUB import'
  const chapters = mergeEpubSegments(title, segments)
  const fallbackCoverImageUrl =
    segments
      .flatMap((segment) => segment.blocks)
      .find((block) => block.type === 'image' && block.src)?.src ?? undefined

  return buildDocument({
    id: path.basename(cacheDirectory),
    title,
    author,
    description: 'EPUB chapters mapped directly into the unified reader.',
    sourceType: 'epub',
    preferredMode: 'page',
    originLabel: filePath,
    extractedWith: 'JSZip EPUB parser',
    chapters: chapters.length > 0 ? chapters : splitBlocksIntoChapters(title, ensureReadableBlocks([], title)),
    metadata: {
      coverImageUrl: explicitCoverImageUrl ?? fallbackCoverImageUrl,
      sourcePath: filePath,
      cacheDirectory,
    },
  })
}

export async function importDocumentFromUrl(
  rawUrl: string,
  libraryRoot: string,
  options?: { documentId?: string; firecrawlEnabled?: boolean; firecrawlApiKey?: string | null },
): Promise<DocumentRecord> {
  const normalizedUrl = normalizeSourceUrl(rawUrl)
  const documentId = options?.documentId ?? createId('document')
  const cacheDirectory = await createCacheDirectory(libraryRoot, documentId)
  const warnings: string[] = []
  const attemptErrors: string[] = []

  let article: ParsedWebArticle | null = null
  let extractedWith = ''

  try {
    const html = await fetchHtmlWithTimeout(normalizedUrl)
    const parsed = parseWebArticleFromHtml(html, normalizedUrl)
    if (isReadableMarkdown(parsed.markdown)) {
      article = parsed
      extractedWith = 'Direct fetch + Readability + Turndown'
    } else {
      attemptErrors.push('Direct fetch produced low-density content.')
    }
  } catch (error) {
    attemptErrors.push(`Direct fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  if (!article) {
    try {
      const rendered = await fetchRenderedHtmlWithBrowser(normalizedUrl)
      const parsed = parseWebArticleFromHtml(rendered.html, rendered.finalUrl)
      if (isReadableMarkdown(parsed.markdown)) {
        article = parsed
        extractedWith = 'Headless Chromium + Readability + Turndown'
      } else {
        attemptErrors.push('Headless browser produced low-density content.')
      }
    } catch (error) {
      attemptErrors.push(`Headless browser failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const firecrawlApiKey = options?.firecrawlApiKey?.trim() ?? ''
  const canUseFirecrawl = Boolean(options?.firecrawlEnabled && firecrawlApiKey)

  if (!article && canUseFirecrawl) {
    try {
      article = await fetchMarkdownFromFirecrawl(normalizedUrl, firecrawlApiKey)
      extractedWith = 'Firecrawl markdown scrape'
    } catch (error) {
      attemptErrors.push(`Firecrawl failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (!article) {
    throw new Error(`Could not extract readable content from URL. ${attemptErrors.join(' ')}`)
  }

  const markdown = article.markdown.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const markdownFilePath = path.join(cacheDirectory, 'source.md')
  await fs.writeFile(markdownFilePath, markdown, 'utf8')

  if (attemptErrors.length > 0) {
    warnings.push(...attemptErrors)
  }

  const title = article.title || extractTitleFromMarkdown(markdown, fallbackTitleFromUrl(normalizedUrl))
  const blocks = markdownToBlocks(markdown)
  const readableBlocks = ensureReadableBlocks(blocks, title)
  const chapters = splitBlocksIntoChapters(title, readableBlocks)

  return buildDocument({
    id: documentId,
    title,
    author: article.author || 'Web import',
    description: article.excerpt || 'Web article imported from URL.',
    sourceType: 'url',
    preferredMode: 'page',
    originLabel: normalizedUrl,
    extractedWith,
    chapters,
    metadata: {
      coverImageUrl: article.coverImageUrl,
      cacheDirectory,
      warnings,
      note: `Imported from ${normalizedUrl}`,
    },
  })
}


export async function importDocumentFromPath(
  filePath: string,
  libraryRoot: string,
  options?: { documentId?: string; onUpdate?: (doc: DocumentRecord) => void },
): Promise<DocumentRecord> {
  const extension = path.extname(filePath).toLowerCase()
  const documentId = options?.documentId ?? createId('document')
  const cacheDirectory = await createCacheDirectory(libraryRoot, documentId)

  if (extension === '.pdf') {
    return importPdfAsImages(filePath, cacheDirectory, options?.onUpdate)
  }

  if (extension === '.epub') {
    return importEpub(filePath, cacheDirectory)
  }

  throw new Error(`Unsupported file type: ${extension}`)
}
