import type {
  Chapter,
  DocumentMetadata,
  DocumentRecord,
  DocumentSource,
  FlatBlock,
  ReaderBlock,
  SearchResult,
  TocItem,
} from './types'

const WORDS_PER_MINUTE = 215
export const CURRENT_IMPORT_VERSION = 3
export const UNREADABLE_IMPORT_MESSAGE =
  'This document was imported successfully, but no readable text could be extracted from the source.'

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function hueFromTitle(title: string): number {
  return Array.from(title).reduce((total, char) => total + char.charCodeAt(0), 0) % 360
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[#>*`_~]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .trim()
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function isUtilityHeading(text: string): boolean {
  const normalized = normalizeLine(text)
  return /^\d{1,3}$/.test(normalized)
}

function countWords(chapters: Chapter[]): number {
  return chapters.reduce((total, chapter) => {
    return total + chapter.content.reduce((chapterTotal, block) => {
      if (block.text) {
        return chapterTotal + block.text.split(/\s+/).filter(Boolean).length
      }

      if (block.items) {
        return chapterTotal + block.items.join(' ').split(/\s+/).filter(Boolean).length
      }

      return chapterTotal
    }, 0)
  }, 0)
}

export function buildToc(chapters: Chapter[]): TocItem[] {
  const items: TocItem[] = []

  chapters.forEach((chapter) => {
    if (!isUtilityHeading(chapter.title)) {
      items.push({
        id: `${chapter.id}-toc`,
        title: chapter.title,
        chapterId: chapter.id,
        blockId: chapter.content[0]?.id ?? chapter.id,
        level: 1,
      })
    }

    chapter.content.forEach((block) => {
      if (block.type === 'heading' && block.text && !isUtilityHeading(block.text)) {
        items.push({
          id: `${block.id}-toc`,
          title: block.text,
          chapterId: chapter.id,
          blockId: block.id,
          level: Math.min(block.level ?? 2, 3),
        })
      }
    })
  })

  return items
}

export function buildDocument(input: {
  id: string
  title: string
  author: string
  description: string
  sourceType: DocumentSource
  preferredMode: 'scroll' | 'page'
  originLabel: string
  extractedWith: string
  note?: string
  chapters: Chapter[]
  metadata?: Partial<DocumentMetadata>
}): DocumentRecord {
  const wordCount = countWords(input.chapters)

  return {
    id: input.id,
    title: input.title,
    author: input.author,
    coverHue: hueFromTitle(input.title),
    sourceType: input.sourceType,
    description: input.description,
    chapters: input.chapters,
    toc: buildToc(input.chapters),
    metadata: {
      importedAt: input.metadata?.importedAt ?? new Date().toISOString(),
      importVersion: input.metadata?.importVersion ?? CURRENT_IMPORT_VERSION,
      originLabel: input.originLabel,
      wordCount,
      estimatedMinutes: Math.max(3, Math.round(wordCount / WORDS_PER_MINUTE)),
      extractedWith: input.extractedWith,
      coverImageUrl: input.metadata?.coverImageUrl,
      note: input.note ?? input.metadata?.note,
      sourcePath: input.metadata?.sourcePath,
      cacheDirectory: input.metadata?.cacheDirectory,
      warnings: input.metadata?.warnings ?? [],
    },
    preferredMode: input.preferredMode,
  }
}

export function splitBlocksIntoChapters(defaultTitle: string, blocks: ReaderBlock[], maxLevel = 2): Chapter[] {
  const chapters: Chapter[] = []
  let chapterIndex = 1
  let currentChapter: Chapter = {
    id: createId('chapter'),
    title: defaultTitle,
    content: [],
  }

  const pushCurrentChapter = () => {
    if (currentChapter.content.length === 0) {
      return
    }

    chapters.push(currentChapter)
  }

  blocks.forEach((block) => {
    const isTopHeading = block.type === 'heading' && (block.level ?? 2) <= maxLevel

    if (isTopHeading && currentChapter.content.length > 0) {
      pushCurrentChapter()
      currentChapter = {
        id: createId('chapter'),
        title: block.text ?? `Chapter ${chapterIndex + 1}`,
        content: [block],
      }
      chapterIndex += 1
      return
    }

    if (isTopHeading && currentChapter.content.length === 0 && block.text) {
      currentChapter.title = block.text
    }

    currentChapter.content.push(block)
  })

  pushCurrentChapter()

  if (chapters.length > 0) {
    return chapters
  }

  return [
    {
      id: createId('chapter'),
      title: defaultTitle,
      content: blocks,
    },
  ]
}

export function markdownToBlocks(markdown: string): ReaderBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReaderBlock[] = []
  let paragraphBuffer: string[] = []
  let listBuffer: string[] = []
  let codeBuffer: string[] = []
  let insideCode = false

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) {
      return
    }

    blocks.push({
      id: createId('block'),
      type: 'paragraph',
      text: normalizeLine(paragraphBuffer.join(' ')),
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

  const flushCode = () => {
    if (codeBuffer.length === 0) {
      return
    }

    blocks.push({
      id: createId('block'),
      type: 'code',
      text: codeBuffer.join('\n'),
    })
    codeBuffer = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      flushParagraph()
      flushList()
      if (insideCode) {
        flushCode()
      }
      insideCode = !insideCode
      continue
    }

    if (insideCode) {
      codeBuffer.push(line)
      continue
    }

    if (trimmed.length === 0) {
      flushParagraph()
      flushList()
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)

    if (headingMatch) {
      flushParagraph()
      flushList()
      blocks.push({
        id: createId('block'),
        type: 'heading',
        level: headingMatch[1].length,
        text: normalizeLine(headingMatch[2]),
      })
      continue
    }

    const imageMatch = trimmed.match(/^!\[(.*?)\]\((.+?)\)$/)

    if (imageMatch) {
      flushParagraph()
      flushList()
      blocks.push({
        id: createId('block'),
        type: 'image',
        alt: imageMatch[1] || 'Imported image',
        caption: imageMatch[1] || undefined,
        src: imageMatch[2],
      })
      continue
    }

    if (trimmed.startsWith('> ')) {
      flushParagraph()
      flushList()
      blocks.push({
        id: createId('block'),
        type: 'quote',
        text: normalizeLine(trimmed.slice(2)),
      })
      continue
    }

    if (/^([-*]|\d+\.)\s+/.test(trimmed)) {
      flushParagraph()
      listBuffer.push(normalizeLine(trimmed.replace(/^([-*]|\d+\.)\s+/, '')))
      continue
    }

    paragraphBuffer.push(stripMarkdown(trimmed))
  }

  flushParagraph()
  flushList()
  flushCode()

  return blocks
}

export function extractTitleFromMarkdown(markdown: string, fallback: string): string {
  const match = markdown.match(/^#{1,2}\s+(.+)$/m)
  return match?.[1]?.trim() || fallback
}

export function flattenDocument(document: DocumentRecord): FlatBlock[] {
  return document.chapters.flatMap((chapter) =>
    chapter.content.map((block) => ({
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      block,
    })),
  )
}

export function documentNeedsRepair(document: DocumentRecord): boolean {
  if ((document.metadata.importVersion ?? 0) < CURRENT_IMPORT_VERSION) {
    return true
  }

  const flatBlocks = flattenDocument(document)

  if (flatBlocks.length === 0) {
    return false
  }

  const contentBlocks = flatBlocks.filter(({ block }) => block.type !== 'heading')

  if (contentBlocks.length === 0) {
    return false
  }

  return contentBlocks.every(({ block }) => {
    if (block.type !== 'paragraph') {
      return false
    }

    return normalizeLine(block.text ?? '') === UNREADABLE_IMPORT_MESSAGE
  })
}

export function buildSearchResults(document: DocumentRecord, query: string): SearchResult[] {
  const needle = query.trim().toLowerCase()

  if (!needle) {
    return []
  }

  return flattenDocument(document)
    .map(({ chapterId, chapterTitle, block }) => {
      const fullText = block.items?.join(' ') ?? block.text ?? block.caption ?? ''

      if (!fullText.toLowerCase().includes(needle)) {
        return null
      }

      const matchIndex = fullText.toLowerCase().indexOf(needle)
      const contextStart = Math.max(0, matchIndex - 42)
      const contextEnd = Math.min(fullText.length, matchIndex + needle.length + 72)

      return {
        id: `${block.id}-search`,
        chapterId,
        blockId: block.id,
        chapterTitle,
        text: fullText,
        context: fullText.slice(contextStart, contextEnd).trim(),
      }
    })
    .filter((result): result is SearchResult => Boolean(result))
}
