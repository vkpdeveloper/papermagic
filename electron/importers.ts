import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { session } from 'electron'
import JSZip from 'jszip'
import { parseHTML } from 'linkedom'
import { XMLParser } from 'fast-xml-parser'
import { createCanvas } from '@napi-rs/canvas'
import { ImageKind, OPS, getDocument as getPdfDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { RefProxy } from 'pdfjs-dist/types/src/display/api'
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

export function friendlyFilenameTitle(filename: string): string {
  return filename
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function buildBrowserLikeHeaders(targetUrl: string, headers?: HeadersInit): Headers {
  const nextHeaders = new Headers(headers)

  if (!nextHeaders.has('accept')) {
    nextHeaders.set(
      'accept',
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    )
  }

  if (!nextHeaders.has('accept-language')) {
    nextHeaders.set('accept-language', 'en-US,en;q=0.9')
  }

  if (!nextHeaders.has('cache-control')) {
    nextHeaders.set('cache-control', 'no-cache')
  }

  if (!nextHeaders.has('pragma')) {
    nextHeaders.set('pragma', 'no-cache')
  }

  if (!nextHeaders.has('upgrade-insecure-requests')) {
    nextHeaders.set('upgrade-insecure-requests', '1')
  }

  if (!nextHeaders.has('user-agent')) {
    const chromeVersion = process.versions.chrome ?? '124.0.0.0'
    nextHeaders.set(
      'user-agent',
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    )
  }

  if (!nextHeaders.has('referer')) {
    try {
      nextHeaders.set('referer', new URL(targetUrl).origin)
    } catch {
      // Ignore invalid URLs and let the request proceed without a referer.
    }
  }

  return nextHeaders
}

async function fetchRemoteResource(input: string | URL, init?: RequestInit): Promise<Response> {
  const targetUrl = input instanceof URL ? input.toString() : input
  const requestInit: RequestInit = {
    ...init,
    redirect: init?.redirect ?? 'follow',
    headers: buildBrowserLikeHeaders(targetUrl, init?.headers),
  }

  try {
    return await session.defaultSession.fetch(targetUrl, requestInit)
  } catch {
    return fetch(targetUrl, requestInit)
  }
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

function extensionFromContentType(contentType: string | null): string {
  if (!contentType) {
    return '.img'
  }

  if (contentType.includes('svg')) {
    return '.svg'
  }

  if (contentType.includes('png')) {
    return '.png'
  }

  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    return '.jpg'
  }

  if (contentType.includes('webp')) {
    return '.webp'
  }

  if (contentType.includes('gif')) {
    return '.gif'
  }

  return '.img'
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let index = 0; index < 256; index += 1) {
    let value = index

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }

    table[index] = value >>> 0
  }

  return table
})()

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'
}

function resolveAppRoot(): string {
  return process.env.APP_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function resolveSummarizeCliPath(): string {
  return path.join(resolveAppRoot(), 'node_modules', '@steipete', 'summarize', 'dist', 'cli.js')
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

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(data.length, 0)

  const crcInput = Buffer.concat([typeBuffer, data])
  let crc = 0xffffffff

  for (const byte of crcInput) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)

  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)

  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const rowOffset = rowIndex * (stride + 1)
    raw[rowOffset] = 0
    Buffer.from(rgba.subarray(rowIndex * stride, (rowIndex + 1) * stride)).copy(raw, rowOffset + 1)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    PNG_SIGNATURE,
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', zlib.deflateSync(raw)),
    createPngChunk('IEND', Buffer.alloc(0)),
  ])
}

function toRgbaImageData(image: {
  width: number
  height: number
  kind: number
  data: Uint8Array
}): Uint8Array | null {
  if (image.kind === ImageKind.RGBA_32BPP) {
    return new Uint8Array(image.data)
  }

  if (image.kind === ImageKind.RGB_24BPP) {
    const rgba = new Uint8Array(image.width * image.height * 4)

    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < image.data.length; sourceIndex += 3, targetIndex += 4) {
      rgba[targetIndex] = image.data[sourceIndex]
      rgba[targetIndex + 1] = image.data[sourceIndex + 1]
      rgba[targetIndex + 2] = image.data[sourceIndex + 2]
      rgba[targetIndex + 3] = 255
    }

    return rgba
  }

  if (image.kind === ImageKind.GRAYSCALE_1BPP) {
    const rgba = new Uint8Array(image.width * image.height * 4)

    for (let pixelIndex = 0; pixelIndex < image.width * image.height; pixelIndex += 1) {
      const sourceByte = image.data[pixelIndex >> 3]
      const mask = 0x80 >> (pixelIndex & 7)
      const value = (sourceByte & mask) === mask ? 255 : 0
      const targetIndex = pixelIndex * 4
      rgba[targetIndex] = value
      rgba[targetIndex + 1] = value
      rgba[targetIndex + 2] = value
      rgba[targetIndex + 3] = 255
    }

    return rgba
  }

  return null
}

function isPdfBinaryImage(value: unknown): value is {
  width: number
  height: number
  kind: number
  data: Uint8Array
} {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.kind === 'number' &&
    candidate.data instanceof Uint8Array
  )
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

async function cacheImageAsset(
  source: string,
  origin: string,
  cacheDirectory: string,
  targetBaseName = 'cover',
): Promise<string | undefined> {
  let resolvedUrl: URL

  try {
    resolvedUrl = new URL(source, origin)
  } catch {
    return undefined
  }

  if (resolvedUrl.protocol === 'data:') {
    return resolvedUrl.toString()
  }

  if (resolvedUrl.protocol === 'file:') {
    const sourcePath = fileURLToPath(resolvedUrl)
    const extension = path.extname(sourcePath) || '.img'
    const targetPath = path.join(cacheDirectory, `${targetBaseName}${extension}`)

    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      await fs.copyFile(sourcePath, targetPath)
    }

    return pathToFileURL(targetPath).toString()
  }

  if (!/^https?:$/.test(resolvedUrl.protocol)) {
    return undefined
  }

  try {
    const response = await fetchRemoteResource(resolvedUrl)
    if (!response.ok) {
      return undefined
    }

    const extension = path.extname(resolvedUrl.pathname) || extensionFromContentType(response.headers.get('content-type'))
    const imageBuffer = Buffer.from(await response.arrayBuffer())
    return persistCoverBuffer(cacheDirectory, `${targetBaseName}${extension}`, imageBuffer)
  } catch {
    return undefined
  }
}

function coverCandidateScore(image: Element): number {
  const descriptor = [
    image.getAttribute('alt'),
    image.getAttribute('class'),
    image.getAttribute('id'),
    image.getAttribute('src'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const width = Number(image.getAttribute('width') ?? 0)
  const height = Number(image.getAttribute('height') ?? 0)
  let score = width > 0 && height > 0 ? width * height : 0

  if (/cover|hero|feature|featured|lead|preview|header|banner/.test(descriptor)) {
    score += 500_000
  }

  if (/logo|avatar|icon|emoji|author|profile|badge|sprite|tracking/.test(descriptor)) {
    score -= 500_000
  }

  if (!Number.isFinite(score) || Number.isNaN(score)) {
    return 0
  }

  return score
}

function pickHtmlCoverSource(document: Document): string | undefined {
  const metaSelectors = [
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ]

  for (const selector of metaSelectors) {
    const value = document.querySelector(selector)?.getAttribute('content')?.trim()

    if (value) {
      return value
    }
  }

  const candidates = Array.from(
    document.querySelectorAll('article img, main img, [itemprop="articleBody"] img, body img'),
  )
    .filter((image) => image.getAttribute('src'))
    .sort((left, right) => coverCandidateScore(right) - coverCandidateScore(left))

  return candidates[0]?.getAttribute('src') ?? undefined
}

async function extractHtmlCoverImage(
  document: Document,
  origin: string,
  cacheDirectory: string,
): Promise<string | undefined> {
  const coverSource = pickHtmlCoverSource(document)

  if (!coverSource) {
    return undefined
  }

  return cacheImageAsset(coverSource, origin, cacheDirectory)
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

function blocksToMarkdown(blocks: ReaderBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return `${'#'.repeat(block.level ?? 2)} ${block.text ?? ''}`.trim()
        case 'quote':
          return `> ${block.text ?? ''}`.trim()
        case 'list':
          return (block.items ?? []).map((item) => `- ${item}`).join('\n')
        case 'code':
          return `\`\`\`\n${block.text ?? ''}\n\`\`\``
        case 'image':
          return `![${block.alt ?? block.caption ?? 'Imported image'}](${block.src ?? ''})`
        default:
          return block.text ?? ''
      }
    })
    .filter(Boolean)
    .join('\n\n')
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

async function cacheRemoteImagesInMarkdown(markdown: string, originUrl: string, cacheDirectory: string): Promise<string> {
  const matches = Array.from(markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g))
  let nextMarkdown = markdown
  let index = 0

  for (const match of matches) {
    const imageUrl = match[2]

    if (!imageUrl || imageUrl.startsWith('data:') || imageUrl.startsWith('file:')) {
      continue
    }

    let resolvedUrl: URL

    try {
      resolvedUrl = new URL(imageUrl, originUrl)
    } catch {
      continue
    }

    try {
      const response = await fetchRemoteResource(resolvedUrl)
      if (!response.ok) {
        continue
      }

      const extension = path.extname(resolvedUrl.pathname) || extensionFromContentType(response.headers.get('content-type'))
      const imageBuffer = Buffer.from(await response.arrayBuffer())
      const targetPath = path.join(cacheDirectory, `web-image-${index}${extension}`)
      await fs.writeFile(targetPath, imageBuffer)
      nextMarkdown = nextMarkdown.replace(imageUrl, pathToFileURL(targetPath).toString())
      index += 1
    } catch {
      continue
    }
  }

  return nextMarkdown
}

async function runSummarizeExtract(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.NODE_BINARY || 'node',
      [
        resolveSummarizeCliPath(),
        url,
        '--extract',
        '--format',
        'md',
        '--markdown-mode',
        'readability',
        '--plain',
        '--no-color',
        '--metrics',
        'off',
      ],
      {
        env: process.env,
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim())
        return
      }

      reject(new Error(stderr.trim() || `Summarize exited with code ${code ?? 'unknown'}.`))
    })
  })
}

async function importMarkdownDocument(input: {
  cacheDirectory: string
  titleFallback: string
  author: string
  description: string
  sourceType: DocumentRecord['sourceType']
  preferredMode: DocumentRecord['preferredMode']
  originLabel: string
  extractedWith: string
  markdown: string
  coverImageUrl?: string
  note?: string
  sourcePath?: string
  warnings?: string[]
}): Promise<DocumentRecord> {
  const title = extractTitleFromMarkdown(input.markdown, input.titleFallback)
  const blocks = ensureReadableBlocks(markdownToBlocks(input.markdown), title)
  return importBlockDocument({
    cacheDirectory: input.cacheDirectory,
    title,
    author: input.author,
    description: input.description,
    sourceType: input.sourceType,
    preferredMode: input.preferredMode,
    originLabel: input.originLabel,
    extractedWith: input.extractedWith,
    blocks,
    coverImageUrl: input.coverImageUrl,
    note: input.note,
    sourcePath: input.sourcePath,
    warnings: input.warnings,
  })
}

async function importBlockDocument(input: {
  cacheDirectory: string
  title: string
  author: string
  description: string
  sourceType: DocumentRecord['sourceType']
  preferredMode: DocumentRecord['preferredMode']
  originLabel: string
  extractedWith: string
  blocks: ReaderBlock[]
  coverImageUrl?: string
  note?: string
  sourcePath?: string
  warnings?: string[]
}): Promise<DocumentRecord> {
  const chapters = splitBlocksIntoChapters(input.title, input.blocks)

  return buildDocument({
    id: path.basename(input.cacheDirectory),
    title: input.title,
    author: input.author,
    description: input.description,
    sourceType: input.sourceType,
    preferredMode: input.preferredMode,
    originLabel: input.originLabel,
    extractedWith: input.extractedWith,
    note: input.note,
    chapters,
    metadata: {
      coverImageUrl: input.coverImageUrl,
      sourcePath: input.sourcePath,
      cacheDirectory: input.cacheDirectory,
      warnings: input.warnings,
    },
  })
}

async function importTextLikeFile(filePath: string, cacheDirectory: string): Promise<DocumentRecord> {
  const extension = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  const titleFallback = friendlyFilenameTitle(fileName.replace(/\.[^/.]+$/, '')) || 'Imported document'
  const sourceCopyPath = path.join(cacheDirectory, `source${extension || '.txt'}`)
  const rawText = await fs.readFile(filePath, 'utf8')
  await fs.writeFile(sourceCopyPath, rawText, 'utf8')
  const { document } = parseHTML(rawText)
  const titleFromHtml = normalizeWhitespace(document.querySelector('title')?.textContent ?? '')
  const author = normalizeWhitespace(
    document.querySelector('meta[name="author"]')?.getAttribute('content') ?? 'Local import',
  )
  const fileOrigin = pathToFileURL(filePath).toString()
  const coverImageUrl =
    extension === '.html' || extension === '.htm'
      ? await extractHtmlCoverImage(document, fileOrigin, cacheDirectory)
      : undefined

  if (extension === '.html' || extension === '.htm') {
    return importBlockDocument({
      cacheDirectory,
      title: titleFromHtml || titleFallback,
      author,
      description: 'Local HTML content normalized into the unified reading surface.',
      sourceType: 'web',
      preferredMode: 'page',
      originLabel: filePath,
      extractedWith: 'Local HTML normalizer',
      blocks: ensureReadableBlocks(htmlToBlocks(rawText), titleFromHtml || titleFallback),
      coverImageUrl,
      sourcePath: filePath,
    })
  }

  return importMarkdownDocument({
    cacheDirectory,
    titleFallback: titleFromHtml || titleFallback,
    author,
    description: 'Local content normalized into the unified reading surface.',
    sourceType: 'web',
    preferredMode: 'page',
    originLabel: filePath,
    extractedWith: extension === '.html' || extension === '.htm' ? 'Local HTML to Markdown normalizer' : 'Markdown/text normalizer',
    markdown: rawText,
    coverImageUrl,
    sourcePath: filePath,
  })
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

interface PdfLine {
  text: string
  x: number
  y: number
  fontSize: number
  pageNumber: number
  pageHeight: number
}

async function extractPdfCoverImage(
  pdf: Awaited<ReturnType<typeof getPdfDocument>['promise']>,
  cacheDirectory: string,
): Promise<string | undefined> {
  let fallbackImage: { area: number; buffer: Buffer } | null = null

  for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 6); pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const operatorList = await page.getOperatorList()

    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      const operator = operatorList.fnArray[index]
      const args = operatorList.argsArray[index]
      const objectId = typeof args?.[0] === 'string' ? args[0] : null
      const imageCandidate =
        operator === OPS.paintInlineImageXObject
          ? args?.[0]
          : objectId && page.objs.has(objectId)
            ? page.objs.get(objectId)
            : objectId && page.commonObjs.has(objectId)
              ? page.commonObjs.get(objectId)
              : null

      if (!isPdfBinaryImage(imageCandidate) || imageCandidate.width < 96 || imageCandidate.height < 96) {
        continue
      }

      const rgba = toRgbaImageData(imageCandidate)
      if (!rgba) {
        continue
      }

      const buffer = encodeRgbaPng(imageCandidate.width, imageCandidate.height, rgba)
      const area = imageCandidate.width * imageCandidate.height

      if (area >= 48_000) {
        return persistCoverBuffer(cacheDirectory, 'cover.png', buffer)
      }

      if (!fallbackImage || area > fallbackImage.area) {
        fallbackImage = { area, buffer }
      }
    }
  }

  const renderedCover = await renderPdfPageAsCover(pdf, cacheDirectory)
  if (renderedCover) {
    return renderedCover
  }

  if (!fallbackImage) {
    return undefined
  }

  return persistCoverBuffer(cacheDirectory, 'cover.png', fallbackImage.buffer)
}

async function renderPdfPageAsCover(
  pdf: Awaited<ReturnType<typeof getPdfDocument>['promise']>,
  cacheDirectory: string,
): Promise<string | undefined> {
  // Try page 1, fall back to page 2 if page 1 appears blank
  for (const pageNumber of [1, 2]) {
    if (pageNumber > pdf.numPages) break

    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height))
    const context = canvas.getContext('2d')

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    const pixels = imageData.data
    let nonWhitePixels = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240) {
        nonWhitePixels += 1
      }
    }

    const totalPixels = canvas.width * canvas.height
    if (nonWhitePixels / totalPixels < 0.01) {
      // Page is nearly blank, try next
      continue
    }

    const buffer = canvas.toBuffer('image/jpeg', 85)
    return persistCoverBuffer(cacheDirectory, 'cover.jpg', Buffer.from(buffer))
  }

  return undefined
}

function collectPdfLines(items: Array<Record<string, unknown>>, pageNumber: number, pageHeight: number): PdfLine[] {
  const textItems = items
    .filter((item) => typeof item.str === 'string' && normalizeWhitespace(String(item.str)).length > 0)
    .map((item) => {
      const transform = item.transform as number[] | undefined
      const x = transform?.[4] ?? 0
      const y = transform?.[5] ?? 0
      const fontSize = Math.abs(Number(item.height ?? transform?.[0] ?? 14))

      return {
        text: normalizeWhitespace(String(item.str)),
        x,
        y,
        fontSize,
        pageNumber,
        pageHeight,
      }
    })
    .sort((left, right) => {
      const verticalDiff = right.y - left.y
      if (Math.abs(verticalDiff) > 2) {
        return verticalDiff
      }
      return left.x - right.x
    })

  const lines: PdfLine[] = []

  for (const item of textItems) {
    const currentLine = lines[lines.length - 1]

    if (currentLine && Math.abs(currentLine.y - item.y) <= Math.max(2, item.fontSize * 0.35)) {
      const spacer = /[-/([{]$/.test(currentLine.text) || /^[,.;:!?)]/.test(item.text) ? '' : ' '
      currentLine.text = `${currentLine.text}${spacer}${item.text}`.trim()
      currentLine.fontSize = Math.max(currentLine.fontSize, item.fontSize)
      currentLine.x = Math.min(currentLine.x, item.x)
      continue
    }

    lines.push(item)
  }

  return lines
}

function titleCaseIfLikelyHeading(text: string): string {
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) {
    return text
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }

  return text
}

function normalizePdfLineSignature(text: string): string {
  return normalizeWhitespace(text).replace(/\b\d+\b/g, '#').toLowerCase()
}

function filterRepeatedPdfChrome(pages: Array<{ pageNumber: number; lines: PdfLine[] }>): Array<{ pageNumber: number; lines: PdfLine[] }> {
  const signatureCounts = new Map<string, number>()

  pages.forEach(({ lines }) => {
    const pageSignatures = new Set<string>()

    lines.forEach((line) => {
      const verticalRatio = line.pageHeight === 0 ? 0 : line.y / line.pageHeight
      const isMarginLine = verticalRatio >= 0.88 || verticalRatio <= 0.12

      if (!isMarginLine) {
        return
      }

      const signature = normalizePdfLineSignature(line.text)
      if (signature.length >= 3) {
        pageSignatures.add(signature)
      }
    })

    pageSignatures.forEach((signature) => {
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1)
    })
  })

  return pages.map(({ pageNumber, lines }) => ({
    pageNumber,
    lines: lines.filter((line) => {
      const verticalRatio = line.pageHeight === 0 ? 0 : line.y / line.pageHeight
      const isMarginLine = verticalRatio >= 0.88 || verticalRatio <= 0.12

      if (!isMarginLine) {
        return true
      }

      const signature = normalizePdfLineSignature(line.text)
      return (signatureCounts.get(signature) ?? 0) < 3
    }),
  }))
}

function normalizePdfParagraphText(lines: string[]): string {
  return normalizeWhitespace(
    lines
      .join(' ')
      .replace(/(\w)-\s+([a-z])/g, '$1$2')
      .replace(/\s+([,.;:!?])/g, '$1'),
  )
}

function pdfPageToBlocks(lines: PdfLine[], baselineFontSize: number): ReaderBlock[] {
  const blocks: ReaderBlock[] = []
  let paragraphBuffer: string[] = []
  let listBuffer: string[] = []
  let previousLine: PdfLine | null = null

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) {
      return
    }

    blocks.push({
      id: createId('block'),
      type: 'paragraph',
      text: normalizePdfParagraphText(paragraphBuffer),
    })
    paragraphBuffer = []
  }

  const flushList = () => {
    if (listBuffer.length === 0) {
      return
    }

    blocks.push({
      id: createId('block'),
      type: 'list',
      items: [...listBuffer],
    })
    listBuffer = []
  }

  for (const line of lines) {
    const gap = previousLine ? Math.abs(previousLine.y - line.y) : line.fontSize
    const indentationDelta = previousLine ? Math.abs(line.x - previousLine.x) : 0
    const endsSentence = /[.!?:"”']$/.test(paragraphBuffer[paragraphBuffer.length - 1] ?? '')
    const isListItem = /^([-\u2022*]|(\d+[.)]))\s+/.test(line.text)
    const wordCount = line.text.split(/\s+/).filter(Boolean).length
    const startsLikeHeading = /^[A-Z0-9IVX]/.test(line.text) && !/^[a-z]/.test(line.text)
    const endsLikeSentence = /[.!?]$/.test(line.text)
    const isHeading =
      !isListItem &&
      line.text.length <= 100 &&
      (wordCount >= 2 || /^\d+$/.test(line.text)) &&
      startsLikeHeading &&
      !endsLikeSentence &&
      (line.fontSize >= baselineFontSize * 1.28 ||
        (/^[A-Z0-9][A-Z0-9\s,'":.-]{3,}$/.test(line.text) && wordCount <= 12))
    const startsNewParagraph =
      gap > line.fontSize * 1.65 || indentationDelta > Math.max(18, line.fontSize * 1.1) || endsSentence

    if (startsNewParagraph) {
      flushParagraph()
      flushList()
    }

    if (isHeading) {
      flushParagraph()
      flushList()
      blocks.push({
        id: createId('block'),
        type: 'heading',
        level: line.fontSize >= baselineFontSize * 1.4 ? 2 : 3,
        text: titleCaseIfLikelyHeading(line.text),
      })
      previousLine = line
      continue
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

  flushParagraph()
  flushList()

  return blocks
}

async function resolvePdfDestinationPageNumber(
  pdf: Awaited<ReturnType<typeof getPdfDocument>['promise']>,
  destination: unknown,
): Promise<number | null> {
  if (!destination) {
    return null
  }

  let explicitDestination: unknown = destination

  if (typeof destination === 'string') {
    explicitDestination = await pdf.getDestination(destination)
  }

  if (!Array.isArray(explicitDestination) || explicitDestination.length === 0) {
    return null
  }

  const target = explicitDestination[0] as Partial<RefProxy> | null

  if (!target || typeof target !== 'object' || typeof target.num !== 'number' || typeof target.gen !== 'number') {
    return null
  }

  return (await pdf.getPageIndex(target as RefProxy)) + 1
}

async function extractPdfOutlineMap(
  pdf: Awaited<ReturnType<typeof getPdfDocument>['promise']>,
): Promise<Map<number, string>> {
  const outline = await pdf.getOutline()
  const pageMap = new Map<number, string>()

  const walk = async (items: Array<{ title: string; dest?: unknown; items?: unknown[] }>): Promise<void> => {
    for (const item of items) {
      const pageNumber = await resolvePdfDestinationPageNumber(pdf, item.dest)
      const title = normalizeWhitespace(item.title ?? '')

      if (pageNumber && title && !pageMap.has(pageNumber)) {
        pageMap.set(pageNumber, title)
      }

      if (Array.isArray(item.items) && item.items.length > 0) {
        await walk(item.items as Array<{ title: string; dest?: unknown; items?: unknown[] }>)
      }
    }
  }

  if (Array.isArray(outline) && outline.length > 0) {
    await walk(outline as Array<{ title: string; dest?: unknown; items?: unknown[] }>)
  }

  return pageMap
}

function buildPdfChaptersFromOutline(
  pageBlocks: Array<{ pageNumber: number; blocks: ReaderBlock[] }>,
  outlineMap: Map<number, string>,
  fallbackTitle: string,
): Chapter[] {
  if (outlineMap.size === 0) {
    return []
  }

  const chapters: Chapter[] = []
  let currentChapter: Chapter | null = null

  for (const page of pageBlocks) {
    const outlineTitle = outlineMap.get(page.pageNumber)
    const pageContent =
      outlineTitle
        ? page.blocks.filter(
            (block) =>
              block.type !== 'heading' || normalizeWhitespace(block.text ?? '') !== normalizeWhitespace(outlineTitle),
          )
        : page.blocks

    if (!currentChapter || outlineTitle) {
      if (currentChapter && currentChapter.content.length > 0) {
        chapters.push(currentChapter)
      }

      currentChapter = {
        id: createId('chapter'),
        title: outlineTitle || (chapters.length === 0 ? fallbackTitle : `Section ${chapters.length + 1}`),
        content: pageContent.length > 0 ? [...pageContent] : ensureReadableBlocks([], outlineTitle || fallbackTitle),
      }
      continue
    }

    currentChapter.content.push(...pageContent)
  }

  if (currentChapter && currentChapter.content.length > 0) {
    chapters.push(currentChapter)
  }

  return chapters
}

function chapterWordCount(chapter: Chapter): number {
  return chapter.content.reduce((total, block) => {
    if (block.text) {
      return total + block.text.split(/\s+/).filter(Boolean).length
    }

    if (block.items) {
      return total + block.items.join(' ').split(/\s+/).filter(Boolean).length
    }

    return total
  }, 0)
}

function cleanupPdfChapters(chapters: Chapter[], fallbackTitle: string): Chapter[] {
  const cleaned: Chapter[] = []

  chapters.forEach((chapter, index) => {
    const words = chapterWordCount(chapter)
    const hasMeaningfulBody = chapter.content.some((block) => ['paragraph', 'quote', 'list', 'code'].includes(block.type))
    const title = normalizeWhitespace(chapter.title)
    const isTinyFrontMatter =
      index < 3 &&
      (title === fallbackTitle || /^(\d+(st|nd|rd|th)? edition|contents|foreword|preface)$/i.test(title) || words < 60)

    if ((!hasMeaningfulBody && words === 0) || (isTinyFrontMatter && chapters[index + 1])) {
      const nextChapter = chapters[index + 1]
      nextChapter.content = [...chapter.content.filter((block) => block.type !== 'heading'), ...nextChapter.content]
      return
    }

    cleaned.push(chapter)
  })

  return cleaned
}

async function importPdf(filePath: string, cacheDirectory: string): Promise<DocumentRecord> {
  const extension = path.extname(filePath)
  const sourceCopyPath = path.join(cacheDirectory, `source${extension || '.pdf'}`)
  const pdfBuffer = await fs.readFile(filePath)
  await fs.writeFile(sourceCopyPath, pdfBuffer)

  const pdf = await getPdfDocument({ data: new Uint8Array(pdfBuffer) }).promise
  const pages: Array<{ pageNumber: number; lines: PdfLine[] }> = []
  const fontSizes: number[] = []
  const metadata = await pdf.getMetadata().catch(() => null)
  const coverImageUrl = await extractPdfCoverImage(pdf, cacheDirectory)

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const viewport = page.getViewport({ scale: 1 })
    const lines = collectPdfLines(textContent.items as Array<Record<string, unknown>>, pageNumber, viewport.height)
    lines.forEach((line) => fontSizes.push(line.fontSize))
    pages.push({ pageNumber, lines })
    await delay()
  }

  const baselineFontSize = median(fontSizes)
  const cleanedPages = filterRepeatedPdfChrome(pages)
  const pageBlocks = cleanedPages.map(({ pageNumber, lines }) => ({
    pageNumber,
    blocks: pdfPageToBlocks(lines, baselineFontSize),
  }))

  const allBlocks = pageBlocks.flatMap((page) => page.blocks)
  const hasDetectedHeadings = allBlocks.some((block) => block.type === 'heading')
  const outlineMap = await extractPdfOutlineMap(pdf)
  const fallbackTitle = friendlyFilenameTitle(path.basename(filePath, extension)) || 'Imported PDF'
  const outlinedChapters = buildPdfChaptersFromOutline(pageBlocks, outlineMap, fallbackTitle)

  const chapters: Chapter[] =
    outlinedChapters.length > 0
      ? outlinedChapters
      : hasDetectedHeadings
        ? splitBlocksIntoChapters(fallbackTitle, ensureReadableBlocks(allBlocks, fallbackTitle))
        : pageBlocks.map(({ pageNumber, blocks }) => ({
            id: createId('chapter'),
            title: `Page ${pageNumber}`,
            content: ensureReadableBlocks(blocks, `Page ${pageNumber}`),
          }))
  const normalizedChapters = cleanupPdfChapters(chapters, fallbackTitle)

  const info = metadata?.info as Record<string, unknown> | undefined
  const title = normalizeWhitespace(String(info?.Title ?? fallbackTitle)) || fallbackTitle
  const author = normalizeWhitespace(String(info?.Author ?? 'PDF import')) || 'PDF import'

  return buildDocument({
    id: path.basename(cacheDirectory),
    title,
    author,
    description: 'PDF content reconstructed into the shared reading model.',
    sourceType: 'pdf',
    preferredMode: 'page',
    originLabel: filePath,
    extractedWith: outlineMap.size > 0 ? 'PDF.js outline + text reconstruction' : 'PDF.js semantic reconstruction',
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

async function importUrlDocument(url: string, cacheDirectory: string): Promise<DocumentRecord> {
  const response = await fetchRemoteResource(url)

  if (!response.ok) {
    throw new Error(`The URL could not be fetched (${response.status}).`)
  }

  const html = await response.text()
  const htmlPath = path.join(cacheDirectory, 'source.html')
  await fs.writeFile(htmlPath, html, 'utf8')

  const { document } = parseHTML(html)
  const host = new URL(url).hostname.replace(/^www\./, '')
  const htmlTitle = normalizeWhitespace(document.querySelector('title')?.textContent ?? host)
  const author =
    normalizeWhitespace(document.querySelector('meta[name="author"]')?.getAttribute('content') ?? '') || host
  const coverImageUrl = await extractHtmlCoverImage(document, url, cacheDirectory)

  let markdown: string
  let extractedWith = 'Summarize CLI extraction'
  const warnings: string[] = []
  let blocks: ReaderBlock[] | null = null

  try {
    markdown = await runSummarizeExtract(url)
    markdown = await cacheRemoteImagesInMarkdown(markdown, url, cacheDirectory)
    blocks = ensureReadableBlocks(markdownToBlocks(markdown), htmlTitle)
  } catch (error) {
    blocks = ensureReadableBlocks(htmlToBlocks(html), htmlTitle)
    markdown = blocksToMarkdown(blocks)
    extractedWith = 'HTML readability fallback'
    warnings.push(error instanceof Error ? error.message : 'Summarize CLI extraction failed.')
  }

  await fs.writeFile(path.join(cacheDirectory, 'extracted.md'), markdown, 'utf8')

  return importBlockDocument({
    cacheDirectory,
    title: extractTitleFromMarkdown(markdown, htmlTitle),
    author,
    description: 'Saved web page extracted into a calm, offline-first reading surface.',
    sourceType: 'web',
    preferredMode: 'page',
    originLabel: url,
    extractedWith,
    blocks: ensureReadableBlocks(blocks ?? markdownToBlocks(markdown), htmlTitle),
    coverImageUrl,
    note: warnings.length > 0 ? warnings.join(' ') : undefined,
    warnings,
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

  return importTextLikeFile(filePath, cacheDirectory)
}

export async function importDocumentFromUrl(url: string, libraryRoot: string): Promise<DocumentRecord> {
  const documentId = createId('document')
  const cacheDirectory = await createCacheDirectory(libraryRoot, documentId)
  return importUrlDocument(url, cacheDirectory)
}
