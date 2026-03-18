import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { parseHTML } from 'linkedom'
import { XMLParser } from 'fast-xml-parser'
import mupdf from 'mupdf'
import {
  UNREADABLE_IMPORT_MESSAGE,
  buildDocument,
  createId,
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
      pushTextBlock('paragraph', node.textContent ?? '')
      return
    }

    if (/^h[1-6]$/.test(tagName)) {
      pushTextBlock('heading', node.textContent ?? '', Number(tagName[1]))
      return
    }

    if (tagName === 'blockquote') {
      pushTextBlock('quote', node.textContent ?? '')
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
      const items = Array.from(node.children)
        .filter((child) => child.tagName.toLowerCase() === 'li')
        .map((item) => normalizeWhitespace(item.textContent ?? ''))
        .filter(Boolean)

      if (items.length > 0) {
        blocks.push({
          id: createId('block'),
          type: 'list',
          items,
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

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length === 0) {
    return 14
  }

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return sorted[middle]
}

// ─── MuPDF structured-text types ──────────────────────────────────────────────
// Actual shape from mupdf asJSON() — lines are flat (no spans array):
// { blocks: [{ type, bbox: {x,y,w,h}, lines: [{ wmode, bbox: {x,y,w,h,flags},
//   font: {name,family,weight,style,size}, x, y, text }] }] }

interface MuFont {
  name: string
  family: string
  weight: string   // 'normal' | 'bold'
  style: string    // 'normal' | 'italic'
  size: number
}

interface MuBBox {
  x: number
  y: number
  w: number
  h: number
}

interface MuLine {
  wmode: number
  bbox: MuBBox & { flags?: number }
  font: MuFont
  x: number
  y: number
  text: string
}

interface MuBlock {
  type: 'text' | 'image'
  bbox: MuBBox
  lines?: MuLine[]
}

interface MuStructuredPage {
  blocks: MuBlock[]
}

// ─── Internal representation ──────────────────────────────────────────────────

interface PdfLine {
  text: string
  x: number
  y: number
  fontSize: number
  bold: boolean
  italic: boolean
  pageNumber: number
  pageHeight: number
}

// ─── Cover image ─────────────────────────────────────────────────────────────

function renderMuPageAsCover(doc: InstanceType<typeof mupdf.Document>, cacheDirectory: string): string | undefined {
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
    fsSync.writeFileSync(coverPath, jpegBytes)
    return pathToFileURL(coverPath).toString()
  }

  return undefined
}

// ─── Structured text → PdfLine[] ─────────────────────────────────────────────

/**
 * Detect whether a page has a two-column layout.
 * Heuristic: collect all body-text x positions and look for two clear clusters
 * (left column ~0-45% of page width, right column ~50-100%).
 */
function detectColumnSplit(rawLines: PdfLine[], pageWidth: number): number | null {
  if (pageWidth <= 0) return null
  const xRatios = rawLines.map((l) => l.x / pageWidth)
  // Count lines in left (<40%) and right (>50%) bands
  const left = xRatios.filter((r) => r < 0.4).length
  const right = xRatios.filter((r) => r > 0.5).length
  const total = rawLines.length
  if (total < 6) return null
  // Both columns must have at least 25% of lines to be considered two-column
  if (left / total >= 0.25 && right / total >= 0.25) {
    // Find the midpoint gap
    return pageWidth * 0.48
  }
  return null
}

/**
 * Re-order a set of lines from a two-column page so that left column comes
 * entirely before right column, maintaining vertical order within each column.
 */
function reorderByColumns(lines: PdfLine[], splitX: number): PdfLine[] {
  const leftCol = lines.filter((l) => l.x <= splitX).sort((a, b) => a.y - b.y)
  const rightCol = lines.filter((l) => l.x > splitX).sort((a, b) => a.y - b.y)
  return [...leftCol, ...rightCol]
}

function muPageToLines(page: InstanceType<typeof mupdf.Page>, pageNumber: number): PdfLine[] {
  const bounds = page.getBounds()
  const pageWidth = bounds[2] - bounds[0]
  const pageHeight = bounds[3] - bounds[1]

  const stext: MuStructuredPage = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON())
  const rawLines: PdfLine[] = []

  for (const block of stext.blocks) {
    if (block.type !== 'text' || !block.lines) continue

    for (const line of block.lines) {
      // In MuPDF's asJSON() each line has text/font/x/y directly — no spans array
      const text = normalizeWhitespace(line.text ?? '')
      if (!text) continue

      // Font metadata comes from line.font
      const fontSize = line.font?.size ?? 10
      const bold = line.font?.weight === 'bold'
      const italic = line.font?.style === 'italic'

      // bbox is an object {x, y, w, h} — use line's own x/y for position
      const x = line.bbox.x
      const y = line.bbox.y

      rawLines.push({ text, x, y, fontSize, bold, italic, pageNumber, pageHeight })
    }
  }

  // Sort top-to-bottom, left-to-right
  rawLines.sort((a, b) => {
    const dy = a.y - b.y
    return Math.abs(dy) > 2 ? dy : a.x - b.x
  })

  // Merge fragments that share the same visual line (same y ± 2pt).
  // This handles justified text where MuPDF emits each word/run as a separate entry.
  const mergedByRow: PdfLine[] = []
  for (const line of rawLines) {
    const prev = mergedByRow[mergedByRow.length - 1]
    if (prev && Math.abs(line.y - prev.y) <= 2 && line.fontSize === prev.fontSize) {
      // Same visual row and same font size — join with a space
      prev.text = normalizeWhitespace(`${prev.text} ${line.text}`)
    } else {
      mergedByRow.push({ ...line })
    }
  }

  // If this page has two columns, re-order so left column precedes right column
  const splitX = detectColumnSplit(mergedByRow, pageWidth)
  if (splitX !== null) {
    return reorderByColumns(mergedByRow, splitX)
  }

  return mergedByRow
}

// ─── Per-page image extraction ────────────────────────────────────────────────

interface ExtractedPageImage {
  /** Y coordinate of the image's top edge in page units */
  y: number
  block: ReaderBlock
}

/**
 * Run the page through a mupdf Device to intercept every fillImage call,
 * render each image to a JPEG, save it to cacheDirectory, and return
 * ReaderBlocks (type 'image') with file:// src URLs and their page-Y position.
 *
 * Images smaller than minAreaFraction of the page area are skipped (decorative
 * icons, bullets, etc.).
 */
function extractPageImages(
  page: InstanceType<typeof mupdf.Page>,
  pageNumber: number,
  cacheDirectory: string,
  minAreaFraction = 0.01,
): ExtractedPageImage[] {
  const bounds = page.getBounds()
  const pageArea = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])
  const results: ExtractedPageImage[] = []
  let imageIndex = 0

  const callbacks = {
    fillImage(image: InstanceType<typeof mupdf.Image>, ctm: number[], _alpha: number) {
      // ctm maps unit-square to page coords: [a,b,c,d,e,f]
      // For non-rotated: x=e, y=f, w=|a|, h=|d|
      const y = Math.min(ctm[5], ctm[5] + ctm[3])
      const w = Math.abs(ctm[0])
      const h = Math.abs(ctm[3])
      const area = w * h

      // Skip tiny decorative images
      if (area < pageArea * minAreaFraction) return

      try {
        // Convert to RGB pixmap then JPEG — force DeviceRGB + no alpha so
        // images stored in Gray, CMYK, or with an inverted mask render correctly
        const rawPixmap = image.toPixmap()
        const pixmap = rawPixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB)
        const jpegBytes = pixmap.asJPEG(85)
        const fileName = `pdf-p${pageNumber}-img${imageIndex}.jpg`
        const filePath = path.join(cacheDirectory, fileName)
        fsSync.writeFileSync(filePath, jpegBytes)
        const src = pathToFileURL(filePath).toString()

        results.push({
          y,
          block: {
            id: createId('block'),
            type: 'image',
            src,
            alt: `Image on page ${pageNumber}`,
          },
        })
        imageIndex += 1
      } catch {
        // Some images (masks, CMYK without proper colorspace) may fail — skip silently
      }
    },
  }

  const device = new mupdf.Device(callbacks)
  page.run(device, mupdf.Matrix.identity)
  device.close()

  return results
}

/**
 * Merge image blocks into an existing ordered block array.
 * Each image is inserted after the last text/heading/list block whose Y
 * centroid is above the image's Y position.
 * Image Y positions are approximate page-unit values from the Device CTM.
 */
function mergeImageBlocksIntoPage(
  blocks: ReaderBlock[],
  images: ExtractedPageImage[],
  pageLines: PdfLine[],
): ReaderBlock[] {
  if (images.length === 0) return blocks

  // Build a Y-centroid for each block by finding which lines contributed to it.
  // Since we don't have per-block Y in ReaderBlock, we use the source PdfLines
  // sorted by index to assign approximate block order; image Y thresholds
  // are compared against cumulative page Y of the text stream.

  // Simpler approach: map each block to an approximate Y by scanning pageLines
  // in order. We know blocks are emitted in reading order; we can assign a
  // "Y anchor" by tracking which page-line was consumed when the block was produced.
  // As a good approximation, assign Y anchors from sorted unique Y values of lines.

  const sortedLineYs = [...new Set(pageLines.map((l) => l.y))].sort((a, b) => a - b)
  const blockCount = blocks.length

  // Spread block indices evenly across sortedLineYs
  function blockY(blockIdx: number): number {
    if (sortedLineYs.length === 0) return 0
    const ratio = blockCount <= 1 ? 0 : blockIdx / (blockCount - 1)
    const lineIdx = Math.round(ratio * (sortedLineYs.length - 1))
    return sortedLineYs[Math.min(lineIdx, sortedLineYs.length - 1)]
  }

  const result: ReaderBlock[] = []
  const sortedImages = [...images].sort((a, b) => a.y - b.y)
  let nextImageIdx = 0

  for (let bi = 0; bi < blocks.length; bi++) {
    result.push(blocks[bi])

    // After this block, flush any images whose Y <= the next block's Y anchor
    const nextBlockY = bi + 1 < blocks.length ? blockY(bi + 1) : Infinity
    while (nextImageIdx < sortedImages.length && sortedImages[nextImageIdx].y <= nextBlockY) {
      result.push(sortedImages[nextImageIdx].block)
      nextImageIdx++
    }
  }

  // Any remaining images go at the end
  while (nextImageIdx < sortedImages.length) {
    result.push(sortedImages[nextImageIdx].block)
    nextImageIdx++
  }

  return result
}

// ─── Running header/footer removal ───────────────────────────────────────────

function normalizePdfLineSignature(text: string): string {
  return normalizeWhitespace(text).replace(/\b\d+\b/g, '#').toLowerCase()
}

function filterRepeatedPdfChrome(pages: Array<{ pageNumber: number; lines: PdfLine[] }>): Array<{ pageNumber: number; lines: PdfLine[] }> {
  const signatureCounts = new Map<string, number>()

  for (const { lines } of pages) {
    const pageSignatures = new Set<string>()
    for (const line of lines) {
      const verticalRatio = line.pageHeight === 0 ? 0 : line.y / line.pageHeight
      const isMarginLine = verticalRatio <= 0.12 || verticalRatio >= 0.88
      if (!isMarginLine) continue
      const sig = normalizePdfLineSignature(line.text)
      if (sig.length >= 3) pageSignatures.add(sig)
    }
    for (const sig of pageSignatures) {
      signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1)
    }
  }

  return pages.map(({ pageNumber, lines }) => ({
    pageNumber,
    lines: lines.filter((line) => {
      const verticalRatio = line.pageHeight === 0 ? 0 : line.y / line.pageHeight
      const isMarginLine = verticalRatio <= 0.12 || verticalRatio >= 0.88
      if (!isMarginLine) return true
      return (signatureCounts.get(normalizePdfLineSignature(line.text)) ?? 0) < 3
    }),
  }))
}

// ─── PdfLine[] → ReaderBlock[] ───────────────────────────────────────────────

function titleCaseIfLikelyHeading(text: string): string {
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) {
    return text.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return text
}

function normalizePdfParagraphText(lines: string[]): string {
  // Join lines one-by-one. If a line ends with a hyphen and the next starts with a lowercase
  // letter it's a PDF line-break hyphen: keep the hyphen and join without an extra space
  // (the hyphen may be structural as in "chain-of-thought" or a break hyphen as in "promis-ing").
  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === 0) {
      result = line
      continue
    }
    const nextStart = line[0] ?? ''
    if (result.endsWith('-') && /[a-z]/.test(nextStart)) {
      // Keep the trailing hyphen and join directly (no extra space)
      result = result + line
    } else {
      result = result + ' ' + line
    }
  }
  return normalizeWhitespace(result.replace(/\s+([,.;:!?])/g, '$1'))
}

function pdfLinesToBlocks(lines: PdfLine[], baselineFontSize: number): ReaderBlock[] {
  const blocks: ReaderBlock[] = []
  let paragraphBuffer: string[] = []
  let listBuffer: string[] = []
  let previousLine: PdfLine | null = null
  // Accumulate consecutive heading-candidate lines to join wrapped headings
  let headingBuffer: { text: string; fontSize: number; bold: boolean } | null = null

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return
    blocks.push({ id: createId('block'), type: 'paragraph', text: normalizePdfParagraphText(paragraphBuffer) })
    paragraphBuffer = []
  }

  const flushList = () => {
    if (listBuffer.length === 0) return
    blocks.push({ id: createId('block'), type: 'list', items: [...listBuffer] })
    listBuffer = []
  }

  const flushHeading = () => {
    if (!headingBuffer) return
    blocks.push({
      id: createId('block'),
      type: 'heading',
      level: headingBuffer.fontSize >= baselineFontSize * 1.4 ? 2 : 3,
      text: titleCaseIfLikelyHeading(headingBuffer.text),
    })
    headingBuffer = null
  }

  // Pre-process: merge lone bullet marker lines and drop-cap letter lines into the
  // following text line. MuPDF sometimes emits "•" as a separate line at the same y,
  // and ornamental drop-caps as isolated single letters on their own line.
  const mergedLines: PdfLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const next = lines[i + 1]

    // Bullet marker on its own line immediately before/beside the text
    if (/^[-\u2022*]$/.test(cur.text) && next && Math.abs(next.y - cur.y) <= cur.fontSize * 0.6) {
      mergedLines.push({ ...next, text: `${cur.text} ${next.text}` })
      i++
      continue
    }

    // Drop-cap: single uppercase letter immediately before a continuation line
    // (continuation starts with a lowercase letter, indicating the cap was the first letter of a word)
    const isDropCap =
      /^[A-Z]$/.test(cur.text) &&
      next !== undefined &&
      /^[a-z]/.test(next.text) &&
      Math.abs(next.y - cur.y) <= cur.fontSize * 2.5

    if (isDropCap && next) {
      mergedLines.push({ ...next, text: `${cur.text}${next.text}` })
      i++
      continue
    }

    mergedLines.push(cur)
  }

  for (const line of mergedLines) {
    // ── Skip lone page-number lines (just a number, possibly with roman numerals) ──
    if (/^[ivxlcdmIVXLCDM\d]+$/.test(line.text) && line.text.length <= 4) {
      continue
    }

    // ── Skip residual single-letter drop-caps that had no mergeable successor ──
    if (/^[A-Z]$/.test(line.text)) {
      continue
    }

    const gap = previousLine ? line.y - previousLine.y : line.fontSize
    const indentDelta = previousLine ? Math.abs(line.x - previousLine.x) : 0
    const endsSentence = /[.!?:""']$/.test(paragraphBuffer[paragraphBuffer.length - 1] ?? '')
    const isListItem = /^([-\u2022*]|(\d+[.)]))\s+/.test(line.text)
    const wordCount = line.text.split(/\s+/).filter(Boolean).length
    const startsLikeHeading = /^[A-Z0-9IVX]/.test(line.text) && !/^[a-z]/.test(line.text)
    const endsLikeSentence = /[.!?;]$/.test(line.text) || (!/^[A-Z0-9][A-Z0-9\s,'":.-]+$/.test(line.text) && /,$/.test(line.text))

    // A bold line that contains a mid-sentence period (e.g. "OpenAI. Founded in 2015 by eight people"
    // or "Anthropic (Claude). Founded in 2020 by") is a bold lead-in for the following paragraph,
    // NOT a standalone heading.
    const hasMidSentencePeriod = /[A-Za-z)]\.\s+[A-Z]/.test(line.text)

    // A line ending with a stop/continuation word is an incomplete sentence fragment, not a heading.
    // Exception: ALL-CAPS lines (e.g. "CHOOSING A PROVIDER AND") are section titles and must not
    // be filtered out by stop-word check.
    const isAllCaps = /^[A-Z0-9][A-Z0-9\s,'":.-]+$/.test(line.text)
    const endsWithStopWord =
      !isAllCaps &&
      /\b(a|an|the|in|of|to|for|on|at|by|as|with|from|into|than|that|which|and|or|is|are|was|were|be|been|being|have|has|had|its|checking|building|provide|being|make|can|need|now|use|take|do|get|set|well|just|only|also|both|even|here|there|when|where|how|what|why|who|up|out|down|back|will)$/i.test(line.text)

    // A bold baseline-font line that has a colon mid-sentence (e.g. "Chunking: You start by taking
    // a document") is a definition/lead-in line, not a standalone heading.
    // Exception: short "label:" headings like "Best Practices:" (≤3 words and ends with the colon)
    const hasDefinitionColon =
      line.bold &&
      line.fontSize < baselineFontSize * 1.28 &&
      /:\s+[A-Z]/.test(line.text) &&
      wordCount >= 4

    // A bold baseline-font line that contains a finite verb in a predicate position is a sentence
    // fragment lead-in, not a heading. E.g. "Multi-agent systems cover the coordination" or
    // "Others include Mistral (an open-source".
    // Only apply to baseline-size bold lines (larger fonts are genuine section titles).
    const hasSentenceVerb =
      line.bold &&
      line.fontSize < baselineFontSize * 1.28 &&
      /\b(introduces?|covers?|explores?|examines?|discusses?|describes?|helps?|allows?|provides?|enables?|shows?|demonstrate[sd]?|presents?|includes?)\b/i.test(line.text)

    // A line is a heading when:
    // 1. font is noticeably larger than baseline (≥1.28×), OR bold + short, OR ALL-CAPS short text
    //    Single-word lines qualify as headings only when the font is clearly display-size (≥2× baseline)
    // 2. doesn't end like a sentence (avoids false positives from first sentences)
    // 3. not a list marker
    // 4. not a bold lead-in opener (mid-sentence period, ends with stop word, definition colon, or predicate verb)
    // For ALL-CAPS lines, a single hyphenated "word" still qualifies (e.g. "RETRIEVAL-AUGMENTED")
    const isHeading =
      !isListItem &&
      !hasMidSentencePeriod &&
      !endsWithStopWord &&
      !hasSentenceVerb &&
      !hasDefinitionColon &&
      line.text.length <= 120 &&
      (wordCount >= 2 || isAllCaps || line.fontSize >= baselineFontSize * 2.0) &&
      startsLikeHeading &&
      !endsLikeSentence &&
      (line.fontSize >= baselineFontSize * 1.28 ||
        (line.bold && wordCount <= 12 && line.fontSize >= baselineFontSize * 0.95) ||
        (/^[A-Z0-9][A-Z0-9\s,'":.-]{3,}$/.test(line.text) && wordCount <= 12))

    // New paragraph when vertical gap is large, big indentation shift, or previous line ended a sentence
    const startsNewParagraph =
      gap > line.fontSize * 1.65 || indentDelta > Math.max(18, line.fontSize * 1.1) || endsSentence

    if (isHeading) {
      flushParagraph()
      flushList()
      // Try to join with a previous heading line if it's a continuation
      // (same font size, bold flag, and small vertical gap)
      const sameStyle =
        headingBuffer !== null &&
        previousLine !== null &&
        Math.abs(line.fontSize - headingBuffer.fontSize) < 1 &&
        line.bold === previousLine.bold &&
        gap <= line.fontSize * 2.0
      if (sameStyle && headingBuffer) {
        headingBuffer.text = `${headingBuffer.text} ${line.text}`
      } else {
        flushHeading()
        headingBuffer = { text: line.text, fontSize: line.fontSize, bold: line.bold }
      }
      previousLine = line
      continue
    }

    // Non-heading line — but if there's an active headingBuffer and this line looks like
    // a continuation of the heading (ALL-CAPS 1-3 word label, small gap, similar size),
    // append it to the heading rather than flushing.
    const isHeadingContinuation =
      headingBuffer !== null &&
      previousLine !== null &&
      gap <= line.fontSize * 2.5 &&
      wordCount <= 3 &&
      /^[A-Z][A-Z0-9\s]+$/.test(line.text) &&
      Math.abs(line.fontSize - headingBuffer.fontSize) <= headingBuffer.fontSize * 0.5

    if (isHeadingContinuation && headingBuffer) {
      headingBuffer.text = `${headingBuffer.text} ${line.text}`
      previousLine = line
      continue
    }

    flushHeading()

    if (startsNewParagraph) {
      flushParagraph()
      flushList()
    }

    if (isListItem) {
      flushParagraph()
      listBuffer.push(line.text.replace(/^([-\u2022*]|(\d+[.)]))\s+/, ''))
      previousLine = line
      continue
    }

    paragraphBuffer.push(line.text)
    previousLine = line
  }

  flushHeading()
  flushParagraph()
  flushList()

  return blocks
}

// ─── Outline → chapter map ───────────────────────────────────────────────────

interface OutlineItem {
  title: string | undefined
  uri: string | undefined
  open: boolean
  down?: OutlineItem[]
  page?: number
}

function extractOutlineMap(outline: OutlineItem[] | null): Map<number, string> {
  const pageMap = new Map<number, string>()

  const walk = (items: OutlineItem[]) => {
    for (const item of items) {
      const title = normalizeWhitespace(item.title ?? '')
      // MuPDF gives us 0-based page index directly
      if (typeof item.page === 'number' && item.page >= 0 && title && !pageMap.has(item.page + 1)) {
        pageMap.set(item.page + 1, title)
      }
      if (item.down && item.down.length > 0) walk(item.down)
    }
  }

  if (outline && outline.length > 0) walk(outline)
  return pageMap
}

function buildPdfChaptersFromOutline(
  pageBlocks: Array<{ pageNumber: number; blocks: ReaderBlock[] }>,
  outlineMap: Map<number, string>,
  fallbackTitle: string,
): Chapter[] {
  if (outlineMap.size === 0) return []

  const chapters: Chapter[] = []
  let currentChapter: Chapter | null = null

  for (const page of pageBlocks) {
    const outlineTitle = outlineMap.get(page.pageNumber)
    const pageContent = outlineTitle
      ? page.blocks.filter(
          (b) => b.type !== 'heading' || normalizeWhitespace(b.text ?? '') !== normalizeWhitespace(outlineTitle),
        )
      : page.blocks

    if (!currentChapter || outlineTitle) {
      if (currentChapter && currentChapter.content.length > 0) chapters.push(currentChapter)
      currentChapter = {
        id: createId('chapter'),
        title: outlineTitle || (chapters.length === 0 ? fallbackTitle : `Section ${chapters.length + 1}`),
        content: pageContent.length > 0 ? [...pageContent] : ensureReadableBlocks([], outlineTitle || fallbackTitle),
      }
      continue
    }

    currentChapter.content.push(...pageContent)
  }

  if (currentChapter && currentChapter.content.length > 0) chapters.push(currentChapter)
  return chapters
}

// ─── Chapter cleanup ──────────────────────────────────────────────────────────

function chapterWordCount(chapter: Chapter): number {
  return chapter.content.reduce((total, block) => {
    if (block.text) return total + block.text.split(/\s+/).filter(Boolean).length
    if (block.items) return total + block.items.join(' ').split(/\s+/).filter(Boolean).length
    return total
  }, 0)
}

function cleanupPdfChapters(chapters: Chapter[], fallbackTitle: string): Chapter[] {
  const cleaned: Chapter[] = []

  chapters.forEach((chapter, index) => {
    const words = chapterWordCount(chapter)
    const hasMeaningfulBody = chapter.content.some((b) => ['paragraph', 'quote', 'list', 'code'].includes(b.type))
    const title = normalizeWhitespace(chapter.title)
    const isTinyFrontMatter =
      index < 3 &&
      (title === fallbackTitle || /^(\d+(st|nd|rd|th)? edition|contents|foreword|preface)$/i.test(title) || words < 60)

    if ((!hasMeaningfulBody && words === 0) || (isTinyFrontMatter && chapters[index + 1])) {
      const next = chapters[index + 1]
      next.content = [...chapter.content.filter((b) => b.type !== 'heading'), ...next.content]
      return
    }

    cleaned.push(chapter)
  })

  return cleaned
}

// ─── Top-level PDF importer ───────────────────────────────────────────────────

async function importPdf(filePath: string, cacheDirectory: string): Promise<DocumentRecord> {
  const extension = path.extname(filePath)
  const sourceCopyPath = path.join(cacheDirectory, `source${extension || '.pdf'}`)
  const pdfBuffer = await fs.readFile(filePath)
  await fs.writeFile(sourceCopyPath, pdfBuffer)

  // Open the PDF with MuPDF — synchronous after WASM is loaded
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
  const pageCount = doc.countPages()

  // ── Cover image: render page 1 (or 2 if blank) at high resolution ──────────
  const coverImageUrl = renderMuPageAsCover(doc, cacheDirectory)

  // ── Metadata ────────────────────────────────────────────────────────────────
  const rawTitle = doc.getMetaData(mupdf.Document.META_INFO_TITLE) ?? ''
  const rawAuthor = doc.getMetaData(mupdf.Document.META_INFO_AUTHOR) ?? ''
  const fallbackTitle = friendlyFilenameTitle(path.basename(filePath, extension)) || 'Imported PDF'

  // ── Per-page structured text + image extraction ─────────────────────────────
  const pages: Array<{ pageNumber: number; lines: PdfLine[] }> = []
  const pageImages: Array<{ pageNumber: number; images: ExtractedPageImage[] }> = []
  const fontSizes: number[] = []

  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.loadPage(i)
    const lines = muPageToLines(page, i + 1)
    for (const l of lines) fontSizes.push(l.fontSize)
    pages.push({ pageNumber: i + 1, lines })
    pageImages.push({ pageNumber: i + 1, images: extractPageImages(page, i + 1, cacheDirectory) })
    await delay()
  }

  const baselineFontSize = median(fontSizes)

  // ── Strip running headers/footers ───────────────────────────────────────────
  const cleanedPages = filterRepeatedPdfChrome(pages)

  // ── Convert lines → semantic blocks, then weave in extracted images ──────────
  const imagesByPage = new Map(pageImages.map((p) => [p.pageNumber, p.images]))
  const pageBlocks = cleanedPages.map(({ pageNumber, lines }) => {
    const textBlocks = pdfLinesToBlocks(lines, baselineFontSize)
    const imgs = imagesByPage.get(pageNumber) ?? []
    return {
      pageNumber,
      blocks: mergeImageBlocksIntoPage(textBlocks, imgs, lines),
    }
  })

  const allBlocks = pageBlocks.flatMap((p) => p.blocks)
  const hasDetectedHeadings = allBlocks.some((b) => b.type === 'heading')

  // ── Outline (TOC) ────────────────────────────────────────────────────────────
  const rawOutline = doc.loadOutline() as OutlineItem[] | null
  const outlineMap = extractOutlineMap(rawOutline)
  const outlinedChapters = buildPdfChaptersFromOutline(pageBlocks, outlineMap, fallbackTitle)

  // ── Assemble chapters: outline → heading split → per-page fallback ──────────
  const chapters: Chapter[] =
    outlinedChapters.length > 0
      ? outlinedChapters
      : hasDetectedHeadings
        ? splitBlocksIntoChapters(fallbackTitle, ensureReadableBlocks(allBlocks, fallbackTitle), 3)
        : pageBlocks.map(({ pageNumber, blocks }) => ({
            id: createId('chapter'),
            title: `Page ${pageNumber}`,
            content: ensureReadableBlocks(blocks, `Page ${pageNumber}`),
          }))

  const normalizedChapters = cleanupPdfChapters(chapters, fallbackTitle)
  const title = normalizeWhitespace(rawTitle) || fallbackTitle
  const author = normalizeWhitespace(rawAuthor) || 'PDF import'

  return buildDocument({
    id: path.basename(cacheDirectory),
    title,
    author,
    description: 'PDF content reconstructed into the shared reading model.',
    sourceType: 'pdf',
    preferredMode: 'page',
    originLabel: filePath,
    extractedWith: outlineMap.size > 0 ? 'MuPDF outline + structured text' : 'MuPDF structured text reconstruction',
    chapters: normalizedChapters,
    metadata: {
      coverImageUrl,
      sourcePath: filePath,
      cacheDirectory,
    },
  })
}

async function extractEpubToc(zip: JSZip, basePath: string, manifest: Map<string, string>): Promise<Map<string, string>> {
  const toc = new Map<string, string>()
  const navEntry = Array.from(manifest.entries()).find(
    ([id, itemPath]) =>
      id.toLowerCase() === 'nav' || /(^|\/)nav\.(xhtml|html)$/i.test(itemPath) || /(^|\/)toc\.(xhtml|html)$/i.test(itemPath),
  )

  if (navEntry) {
    const [, navPath] = navEntry
    const navFile = zip.file(navPath)
    if (navFile) {
      const navMarkup = await navFile.async('text')
      const { document } = parseHTML(navMarkup)
      document.querySelectorAll('nav a').forEach((anchor) => {
        const href = anchor.getAttribute('href')
        const title = normalizeWhitespace(anchor.textContent ?? '')
        if (href && title) {
          toc.set(resolvePosixPath(navPath, href), title)
        }
      })
    }
  }

  const ncxEntry = Array.from(manifest.entries()).find(([, itemPath]) => itemPath.endsWith('.ncx'))

  if (toc.size === 0 && ncxEntry) {
    const [, ncxPath] = ncxEntry
    const ncxFile = zip.file(ncxPath)
    if (ncxFile) {
      const ncxMarkup = await ncxFile.async('text')
      const parsed = xmlParser.parse(ncxMarkup) as Record<string, unknown>
      const walk = (node: unknown) => {
        const points = toArray((node as Record<string, unknown>)?.navPoint)
        points.forEach((point) => {
          const pointRecord = point as Record<string, unknown>
          const href = pointRecord.content
            ? resolvePosixPath(ncxPath, String((pointRecord.content as Record<string, unknown>)['@_src'] ?? ''))
            : ''
          const label = textFromXmlValue((pointRecord.navLabel as Record<string, unknown>)?.text)
          if (href && label) {
            toc.set(href, label)
          }
          walk(pointRecord)
        })
      }
      walk((parsed.ncx as Record<string, unknown>)?.navMap)
    }
  }

  if (toc.size === 0) {
    toc.set(basePath, '')
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

  const tocMap = await extractEpubToc(zip, opfPath, manifestById)
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
    const explicitTitle = tocMap.get(chapterPath) || ''
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

export async function importDocumentFromPath(
  filePath: string,
  libraryRoot: string,
  options?: { documentId?: string },
): Promise<DocumentRecord> {
  const extension = path.extname(filePath).toLowerCase()
  const documentId = options?.documentId ?? createId('document')
  const cacheDirectory = await createCacheDirectory(libraryRoot, documentId)

  if (extension === '.pdf') {
    return importPdf(filePath, cacheDirectory)
  }

  if (extension === '.epub') {
    return importEpub(filePath, cacheDirectory)
  }

  throw new Error(`Unsupported file type: ${extension}`)
}

