import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import JSZip from 'jszip'
import { parseHTML } from 'linkedom'
import { XMLParser } from 'fast-xml-parser'
import { getDocument as getPdfDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
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
      text: 'This document was imported successfully, but no readable text could be extracted from the source.',
    },
  ]
}

function extensionFromContentType(contentType: string | null): string {
  if (!contentType) {
    return '.img'
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

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

function domRootFromHtml(html: string) {
  const { document } = parseHTML(html)
  ;['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'noscript', 'iframe', 'svg'].forEach(
    (selector) => {
      document.querySelectorAll(selector).forEach((node) => node.remove())
    },
  )

  const root = document.querySelector('article, main, body')
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

    Array.from(node.children).forEach((child) => {
      walk(child)
    })
  }

  Array.from(root.children).forEach((child) => {
    walk(child)
  })

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
      const response = await fetch(resolvedUrl)
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
      sourcePath: input.sourcePath,
      cacheDirectory: input.cacheDirectory,
      warnings: input.warnings,
    },
  })
}

async function importTextLikeFile(filePath: string, cacheDirectory: string): Promise<DocumentRecord> {
  const extension = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  const titleFallback = fileName.replace(/\.[^/.]+$/, '') || 'Imported document'
  const sourceCopyPath = path.join(cacheDirectory, `source${extension || '.txt'}`)
  const rawText = await fs.readFile(filePath, 'utf8')
  await fs.writeFile(sourceCopyPath, rawText, 'utf8')
  const { document } = parseHTML(rawText)
  const titleFromHtml = normalizeWhitespace(document.querySelector('title')?.textContent ?? '')
  const author = normalizeWhitespace(
    document.querySelector('meta[name="author"]')?.getAttribute('content') ?? 'Local import',
  )

  if (extension === '.html' || extension === '.htm') {
    return importBlockDocument({
      cacheDirectory,
      title: titleFromHtml || titleFallback,
      author,
      description: 'Local HTML content normalized into the unified reading surface.',
      sourceType: 'web',
      preferredMode: 'scroll',
      originLabel: filePath,
      extractedWith: 'Local HTML normalizer',
      blocks: ensureReadableBlocks(htmlToBlocks(rawText), titleFromHtml || titleFallback),
      sourcePath: filePath,
    })
  }

  return importMarkdownDocument({
    cacheDirectory,
    titleFallback: titleFromHtml || titleFallback,
    author,
    description: 'Local content normalized into the unified reading surface.',
    sourceType: 'web',
    preferredMode: 'scroll',
    originLabel: filePath,
    extractedWith: extension === '.html' || extension === '.htm' ? 'Local HTML to Markdown normalizer' : 'Markdown/text normalizer',
    markdown: rawText,
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
}

function collectPdfLines(items: Array<Record<string, unknown>>): PdfLine[] {
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

function pdfPageToBlocks(lines: PdfLine[], baselineFontSize: number): ReaderBlock[] {
  const blocks: ReaderBlock[] = []
  let paragraphBuffer: string[] = []
  let listBuffer: string[] = []
  let previousY = 0

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) {
      return
    }

    blocks.push({
      id: createId('block'),
      type: 'paragraph',
      text: normalizeWhitespace(paragraphBuffer.join(' ')),
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
    const gap = previousY === 0 ? line.fontSize : Math.abs(previousY - line.y)
    const isListItem = /^([-\u2022*]|(\d+[\.\)]))\s+/.test(line.text)
    const isHeading =
      line.text.length <= 120 &&
      (line.fontSize >= baselineFontSize * 1.18 || /^[A-Z0-9][A-Z0-9\s,'":.-]{5,}$/.test(line.text))

    if (gap > line.fontSize * 1.75) {
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
      previousY = line.y
      continue
    }

    if (isListItem) {
      flushParagraph()
      listBuffer.push(line.text.replace(/^([-\u2022*]|(\d+[\.\)]))\s+/, ''))
      previousY = line.y
      continue
    }

    paragraphBuffer.push(line.text)
    previousY = line.y
  }

  flushParagraph()
  flushList()

  return blocks
}

async function importPdf(filePath: string, cacheDirectory: string): Promise<DocumentRecord> {
  const extension = path.extname(filePath)
  const sourceCopyPath = path.join(cacheDirectory, `source${extension || '.pdf'}`)
  const pdfBuffer = await fs.readFile(filePath)
  await fs.writeFile(sourceCopyPath, pdfBuffer)

  const pdf = await getPdfDocument({ data: new Uint8Array(pdfBuffer) }).promise
  const pages: Array<{ pageNumber: number; lines: PdfLine[] }> = []
  const fontSizes: number[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const lines = collectPdfLines(textContent.items as Array<Record<string, unknown>>)
    lines.forEach((line) => fontSizes.push(line.fontSize))
    pages.push({ pageNumber, lines })
    await delay()
  }

  const baselineFontSize = median(fontSizes)
  const pageBlocks = pages.map(({ pageNumber, lines }) => ({
    pageNumber,
    blocks: pdfPageToBlocks(lines, baselineFontSize),
  }))

  const allBlocks = pageBlocks.flatMap((page) => page.blocks)
  const hasDetectedHeadings = allBlocks.some((block) => block.type === 'heading')

  const chapters: Chapter[] = hasDetectedHeadings
    ? splitBlocksIntoChapters(path.basename(filePath, extension), ensureReadableBlocks(allBlocks, path.basename(filePath)))
    : pageBlocks.map(({ pageNumber, blocks }) => ({
        id: createId('chapter'),
        title: `Page ${pageNumber}`,
        content: ensureReadableBlocks(blocks, `Page ${pageNumber}`),
      }))

  return buildDocument({
    id: path.basename(cacheDirectory),
    title: path.basename(filePath, extension) || 'Imported PDF',
    author: 'PDF import',
    description: 'PDF content reconstructed into the shared reading model.',
    sourceType: 'pdf',
    preferredMode: 'scroll',
    originLabel: filePath,
    extractedWith: 'PDF.js semantic reconstruction',
    chapters,
    metadata: {
      sourcePath: filePath,
      cacheDirectory,
    },
  })
}

async function extractEpubToc(zip: JSZip, basePath: string, manifest: Map<string, string>): Promise<Map<string, string>> {
  const toc = new Map<string, string>()
  const navEntry = Array.from(manifest.entries()).find(([, itemPath]) => itemPath.endsWith('.xhtml') || itemPath.endsWith('.html'))

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
    const targetPath = path.join(cacheDirectory, `epub-image-${imageIndex}${extension}`)
    await fs.writeFile(targetPath, imageBuffer)
    image.setAttribute('src', pathToFileURL(targetPath).toString())
    imageIndex += 1
  }

  return scope.innerHTML
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
  const manifestById = new Map<string, string>()

  manifestItems.forEach((entry) => {
    const record = entry as Record<string, unknown>
    const id = String(record['@_id'] ?? '')
    const href = String(record['@_href'] ?? '')
    if (id && href) {
      manifestById.set(id, path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href)))
    }
  })

  const tocMap = await extractEpubToc(zip, opfPath, manifestById)
  const spineItems = toArray((packageRecord.spine as Record<string, unknown>)?.itemref)
  const chapters: Chapter[] = []

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
    const fallbackTitle = tocMap.get(chapterPath) || `Chapter ${index + 1}`
    const blocks = ensureReadableBlocks(htmlToBlocks(htmlWithLocalImages), fallbackTitle)

    chapters.push({
      id: createId('chapter'),
      title: fallbackTitle,
      content: blocks,
    })

    await delay()
  }

  const title = textFromXmlValue(metadata['dc:title']) || path.basename(filePath, extension) || 'Imported EPUB'
  const author = textFromXmlValue(metadata['dc:creator']) || 'EPUB import'

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
      sourcePath: filePath,
      cacheDirectory,
    },
  })
}

async function importUrlDocument(url: string, cacheDirectory: string): Promise<DocumentRecord> {
  const response = await fetch(url)

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
    preferredMode: 'scroll',
    originLabel: url,
    extractedWith,
    blocks: ensureReadableBlocks(blocks ?? markdownToBlocks(markdown), htmlTitle),
    note: warnings.length > 0 ? warnings.join(' ') : undefined,
    warnings,
  })
}

export async function importDocumentFromPath(filePath: string, libraryRoot: string): Promise<DocumentRecord> {
  const extension = path.extname(filePath).toLowerCase()
  const documentId = createId('document')
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
