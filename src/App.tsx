import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useHotkey, useHotkeySequence } from '@tanstack/react-hotkeys'
import {
  BookOpen as BookOpenIcon,
  Bookmark as BookmarkIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  FileText as FileTextIcon,
  Highlighter as HighlighterIcon,
  List as ListIcon,
  NotebookPen as NotebookPenIcon,
  PanelLeftClose as PanelLeftCloseIcon,
  PanelLeftOpen as PanelLeftOpenIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Upload as UploadIcon,
  X as XIcon,
  Columns2 as Columns2Icon,
  LayoutTemplate as LayoutSingleIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  Moon as MoonIcon,
  Sun as SunIcon,
  RotateCcw as FitWidthIcon,
  Clock as ClockIcon,
  Globe as GlobeIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { buildSearchResults, isUtilityHeading } from './content'
import { defaultPreferences } from './storage'
import type {
  AppMode,
  Bookmark,
  DocumentRecord,
  Highlight,
  PersistedState,
  ReaderBlock,
  ReadingProgress,
  TocItem,
} from './types'
import { Streamdown, type ThemeInput } from 'streamdown'
import { createMathPlugin } from '@streamdown/math'
import { createCodePlugin } from '@streamdown/code'
import { createCjkPlugin } from '@streamdown/cjk'
import { createMermaidPlugin } from '@streamdown/mermaid'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Dialog } from './components/ui/Dialog'
import { DropOverlay } from './components/DropOverlay'
import { ImageLightbox } from './components/ImageLightbox'
import { SelectionPopover } from './components/SelectionPopover'
import { ReaderSearchBar } from './components/ReaderSearchBar'
import { SettingsPage } from './components/SettingsPage'
import { Button } from './components/ui/Button'
import { Input } from './components/ui/Input'
import { Tooltip, TooltipProvider } from './components/ui/Tooltip'
import { ContextMenu } from './components/ui/ContextMenu'
import { Spinner } from './components/ui/Spinner'

type ReaderPanel = 'toc' | 'notes' | null

interface SelectionDraft {
  chapterId: string
  blockId: string
  text: string
  x: number
  y: number
}

interface ImagePreviewState {
  src: string
  alt: string
  caption?: string
}

interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
}

interface TocGroup {
  chapterId: string
  title: string
  blockId: string
  items: TocItem[]
}

type DroppedFile = File & {
  path?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

async function toggleFullscreen(): Promise<void> {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen()
    return
  }

  await document.exitFullscreen()
}

function coverStyle(document: DocumentRecord): React.CSSProperties {
  return {
    background: `linear-gradient(145deg, hsl(${document.coverHue} 50% 18%), hsl(${(document.coverHue + 26) % 360} 44% 10%))`,
    boxShadow: `inset 0 1px 0 hsla(${document.coverHue} 85% 80% / 0.14)`,
  }
}

function resolveDocumentCoverImage(document: DocumentRecord): string | undefined {
  if (document.metadata.coverImageUrl) {
    return document.metadata.coverImageUrl
  }

  for (const chapter of document.chapters) {
    const firstImage = chapter.content.find((block) => block.type === 'image' && block.src)

    if (firstImage?.src) {
      return firstImage.src
    }
  }

  return undefined
}

function upsertProgress(items: ReadingProgress[], progress: ReadingProgress): ReadingProgress[] {
  const existingIndex = items.findIndex((item) => item.documentId === progress.documentId)

  if (existingIndex === -1) {
    return [...items, progress]
  }

  const next = [...items]
  next[existingIndex] = progress
  return next
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderWithHighlights(text: string, highlights: Highlight[], documentId: string, blockId: string) {
  const relevant = highlights
    .filter((highlight) => highlight.documentId === documentId && highlight.blockId === blockId)
    .map((highlight) => highlight.text)
    .filter(Boolean)

  if (relevant.length === 0) {
    return text
  }

  const pattern = relevant
    .sort((left, right) => right.length - left.length)
    .map((value) => escapeForRegExp(value))
    .join('|')

  if (!pattern) {
    return text
  }

  const parts = text.split(new RegExp(`(${pattern})`, 'gi'))

  return parts.map((part, index) => {
    const isMarked = relevant.some((value) => value.toLowerCase() === part.toLowerCase())

    if (!isMarked) {
      return <span key={`${blockId}-${index}`}>{part}</span>
    }

    return <mark key={`${blockId}-${index}`} className="px-[0.14em] py-[0.04em] bg-white/[0.18] text-text-primary">{part}</mark>
  })
}

function sourceLabel(sourceType: DocumentRecord['sourceType']): string {
  switch (sourceType) {
    case 'epub':
      return 'EPUB'
    case 'pdf':
      return 'PDF'
    case 'url':
      return 'URL'
    default:
      return 'URL'
  }
}

function documentAuthorLabel(document: DocumentRecord): string {
  const placeholderAuthors = new Set(['PDF import', 'EPUB import', 'Web import'])
  return placeholderAuthors.has(document.author) ? 'Unknown author' : document.author
}

function SourceIcon(props: {
  sourceType: DocumentRecord['sourceType']
  size?: number
  strokeWidth?: number
}) {
  const { sourceType, size = 16, strokeWidth = 1.8 } = props
  const Icon = sourceType === 'epub' ? BookOpenIcon : sourceType === 'pdf' ? FileTextIcon : GlobeIcon
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" />
}

function removeDocumentFromState(state: PersistedState, documentId: string): PersistedState {
  return {
    ...state,
    documents: state.documents.filter((document) => document.id !== documentId),
    progress: state.progress.filter((progress) => progress.documentId !== documentId),
    highlights: state.highlights.filter((highlight) => highlight.documentId !== documentId),
    bookmarks: state.bookmarks.filter((bookmark) => bookmark.documentId !== documentId),
  }
}

function buildCurrentLocation(readerElement: HTMLDivElement | null): { chapterId: string; blockId: string } | null {
  if (!readerElement) {
    return null
  }

  const elements = Array.from(readerElement.querySelectorAll<HTMLElement>('[data-block-id]'))
  const scrollTop = readerElement.scrollTop
  let currentElement: HTMLElement | undefined = elements[0]

  for (const element of elements) {
    if (element.offsetTop - scrollTop <= 120) {
      currentElement = element
      continue
    }
    break
  }

  if (!currentElement) {
    return null
  }

  const chapterId = currentElement.dataset.chapterId
  const blockId = currentElement.dataset.blockId

  if (!chapterId || !blockId) {
    return null
  }

  return { chapterId, blockId }
}

function buildTocGroups(document: DocumentRecord | null): TocGroup[] {
  if (!document) {
    return []
  }

  const filtered = document.toc.filter(
    (item) => item.title.trim() && !isUtilityHeading(item.title),
  )

  if (filtered.length === 0) return []

  // Group items: each level-1 item starts a new group; level 2+ items nest under it.
  // If there are no level-1 items at all (flat doc), treat all as level-1 groups.
  const hasLevel1 = filtered.some((item) => item.level === 1)

  if (!hasLevel1) {
    // Fallback: every item becomes its own group with no children
    return filtered.map((item) => ({
      chapterId: item.chapterId,
      title: item.title,
      blockId: item.blockId,
      items: [],
    }))
  }

  const groups: TocGroup[] = []
  let current: TocGroup | null = null

  for (const item of filtered) {
    if (item.level === 1) {
      if (current) groups.push(current)
      current = {
        chapterId: item.chapterId,
        title: item.title,
        blockId: item.blockId,
        items: [],
      }
    } else if (current) {
      current.items.push(item)
    } else {
      // Orphaned sub-item before any level-1 — promote to group
      groups.push({
        chapterId: item.chapterId,
        title: item.title,
        blockId: item.blockId,
        items: [],
      })
    }
  }

  if (current) groups.push(current)
  return groups
}


function renderWithSearchMatches(text: string, searchQuery: string, isActive: boolean) {
  const trimmed = searchQuery.trim()
  if (!trimmed) return text

  const parts = text.split(new RegExp(`(${escapeForRegExp(trimmed)})`, 'gi'))
  return parts.map((part, index) => {
    if (part.toLowerCase() !== trimmed.toLowerCase()) {
      return <span key={index}>{part}</span>
    }
    return (
      <mark
        key={index}
        className={
          isActive
            ? 'bg-[rgba(255,200,60,0.72)] text-[#000] px-[0.12em] py-[0.04em]'
            : 'bg-[rgba(255,200,60,0.24)] text-text-primary px-[0.12em] py-[0.04em]'
        }
      >
        {part}
      </mark>
    )
  })
}

// Streamdown plugins — created once at module level to avoid re-instantiation
const SD_SHIKI_THEME: [ThemeInput, ThemeInput] = ['github-dark', 'github-dark']

const sdPlugins = {
  math: createMathPlugin({ singleDollarTextMath: true }),
  code: createCodePlugin({ themes: SD_SHIKI_THEME }),
  cjk: createCjkPlugin(),
  mermaid: createMermaidPlugin(),
}

const sdAllPlugins = { math: sdPlugins.math, code: sdPlugins.code, cjk: sdPlugins.cjk, mermaid: sdPlugins.mermaid }
const sdCodePlugins = { code: sdPlugins.code, cjk: sdPlugins.cjk }
const sdMathPlugins = { math: sdPlugins.math }

// Detect a squashed GFM table: a paragraph where the LLM/PDF importer joined
// table rows into a single line separated by | ... | :---: | ... |
// Returns the reconstructed multi-line markdown table, or null if not a table.
function tryUnwrapSquashedTable(text: string): string | null {
  // Must contain a separator cell pattern like :--- or ---:
  if (!/\|\s*:?-{2,}:?\s*\|/.test(text)) return null
  // Must start with | (possibly after whitespace)
  if (!text.trimStart().startsWith('|')) return null

  // Split on the row boundaries: a | that is preceded by a cell-end pattern
  // Strategy: split on "| |" boundary (two pipes with only whitespace between row-end and row-start)
  // The squashed form looks like: "| A | B | | :--- | :---: | | val | val |"
  // Row boundaries appear as "| |" (end of last cell, space, start of next row)
  const rows = text.split(/\s*\|\s*(?=\|)/)
  if (rows.length < 2) return null

  // Re-add the leading | that gets split off for each row (except first)
  const lines = rows.map((r, i) => (i === 0 ? r.trim() : `|${r.trim()}`))

  // Validate: at least header + separator + one data row
  const separatorIndex = lines.findIndex((l) => /^\|\s*:?-{2,}/.test(l))
  if (separatorIndex < 1) return null

  return lines.join('\n')
}

// Inline renderer: renders a markdown string without adding a block-level wrapper
function InlineMd({ text }: { text: string }) {
  return (
    <Streamdown
      mode="static"
      plugins={sdAllPlugins}
      shikiTheme={SD_SHIKI_THEME}
      components={{ p: ({ children }) => <>{children}</> }}
    >
      {text}
    </Streamdown>
  )
}

// ─── PDF page image block with lazy render and dark mode inversion ────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1/6) return p + (q - p) * 6 * t
  if (t < 1/2) return q
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue2rgb(p, q, h + 1/3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1/3)]
}

const darkModeCache = new Map<string, string>()

function invertLuminance(src: string): Promise<string> {
  if (darkModeCache.has(src)) return Promise.resolve(darkModeCache.get(src)!)
  return new Promise((resolve) => {
    const img = new Image()
    img.src = src
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const d = imageData.data
      for (let i = 0; i < d.length; i += 4) {
        const [h, s, l] = rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255)
        const [nr, ng, nb] = hslToRgb(h, s, 1 - l)
        d[i] = nr * 255; d[i + 1] = ng * 255; d[i + 2] = nb * 255
      }
      ctx.putImageData(imageData, 0, 0)
      const result = canvas.toDataURL('image/jpeg', 0.9)
      darkModeCache.set(src, result)
      resolve(result)
    }
    img.onerror = () => resolve(src)
  })
}

function PdfPageBlock({ block, chapterId, isDarkMode }: { block: ReaderBlock; chapterId: string; isDarkMode: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [darkSrc, setDarkSrc] = useState<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.disconnect() } },
      { rootMargin: '800px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isVisible || !isDarkMode || !block.src) return
    void invertLuminance(block.src).then(setDarkSrc)
  }, [isVisible, isDarkMode, block.src])

  const aspectRatio = block.pageWidth && block.pageHeight
    ? block.pageWidth / block.pageHeight
    : 0.7727

  const displaySrc = isDarkMode && darkSrc ? darkSrc : block.src

  return (
    <div
      ref={containerRef}
      data-block-id={block.id}
      data-chapter-id={chapterId}
      className="w-full"
      style={{ aspectRatio: String(aspectRatio) }}
    >
      {isVisible && displaySrc ? (
        <img
          src={displaySrc}
          alt={`Page ${block.pageNumber ?? ''}`}
          className="w-full h-auto block"
          draggable={false}
        />
      ) : (
        <div className="w-full h-full bg-white/[0.03] animate-pulse" />
      )}
    </div>
  )
}

const ReaderBlockView = memo(function ReaderBlockView(props: {
  block: ReaderBlock
  chapterId: string
  documentId: string
  highlights: Highlight[]
  searchQuery?: string
  activeSearchBlockId?: string
  onPreviewImage?: (image: ImagePreviewState) => void
  pdfDarkMode?: boolean
}) {
  const { block, chapterId, documentId, highlights, searchQuery = '', activeSearchBlockId, onPreviewImage, pdfDarkMode = false } = props

  function renderText(text: string) {
    const withHighlights = renderWithHighlights(text, highlights, documentId, block.id)
    if (!searchQuery.trim()) return withHighlights
    if (Array.isArray(withHighlights)) {
      return withHighlights.map((node) => {
        if (typeof node === 'string') {
          return renderWithSearchMatches(node, searchQuery, block.id === activeSearchBlockId)
        }
        return node
      })
    }
    return renderWithSearchMatches(text, searchQuery, block.id === activeSearchBlockId)
  }

  const blockBase = 'mb-[1.15em] break-inside-avoid scroll-mt-6'

  // For blocks with active highlights or search, fall back to plain text rendering
  // so highlight/search overlays remain functional
  const hasHighlights = highlights.some(
    (h) => h.documentId === documentId && h.blockId === block.id,
  )
  const hasSearch = Boolean(searchQuery.trim())

  switch (block.type) {
    case 'heading': {
      if (isUtilityHeading(block.text ?? '')) {
        return null
      }

      const headingConfig: Record<number, { tag: string; size: string; mt: string }> = {
        1: { tag: 'h1', size: 'text-[1.55em]', mt: 'mt-[3em]' },
        2: { tag: 'h2', size: 'text-[1.3em]', mt: 'mt-[2.6em]' },
        3: { tag: 'h3', size: 'text-[1.12em]', mt: 'mt-[2.4em]' },
        4: { tag: 'h4', size: 'text-[0.97em]', mt: 'mt-[1.8em]' },
        5: { tag: 'h5', size: 'text-[0.9em]', mt: 'mt-[1.6em]' },
        6: { tag: 'h6', size: 'text-[0.85em]', mt: 'mt-[1.4em]' },
      }
      const hc = headingConfig[block.level ?? 3] ?? headingConfig[3]
      const HeadingTag = hc.tag as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

      return (
        <HeadingTag
          className={`${blockBase} ${hc.mt} mb-[0.9em] ${hc.size} font-display font-semibold leading-[1.18]`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          {hasHighlights || hasSearch ? renderText(block.text ?? '') : <InlineMd text={block.text ?? ''} />}
        </HeadingTag>
      )
    }
    case 'quote':
      return (
        <blockquote
          className={`${blockBase} pl-5 border-l-2 border-border-strong text-text-secondary italic`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          {hasHighlights || hasSearch ? renderText(block.text ?? '') : <InlineMd text={block.text ?? ''} />}
        </blockquote>
      )
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul'
      const listStyle = block.ordered ? 'list-decimal' : 'list-disc'
      return (
        <ListTag
          className={`${blockBase} ${listStyle} pl-[1.6em] space-y-[0.35em]`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          {(block.items ?? []).map((item, index) => (
            <li key={`${block.id}-${index}`}>
              {hasHighlights || hasSearch ? item : <InlineMd text={item} />}
            </li>
          ))}
        </ListTag>
      )
    }
    case 'code':
      return (
        <div
          className={`${blockBase}`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          <Streamdown
            mode="static"
            plugins={sdCodePlugins}
            shikiTheme={SD_SHIKI_THEME}
            controls={false}
          >
            {`\`\`\`${block.language ?? 'rust'}\n${block.text ?? ''}\n\`\`\``}
          </Streamdown>
        </div>
      )
    case 'math':
      return (
        <div
          className={`${blockBase} overflow-x-auto`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          <Streamdown
            mode="static"
            plugins={sdMathPlugins}
            controls={false}
          >
            {`$$\n${block.text ?? ''}\n$$`}
          </Streamdown>
        </div>
      )
    case 'table':
      return (
        <div
          className={`${blockBase} overflow-x-auto`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          <Streamdown mode="static" controls={false}>
            {block.text ?? ''}
          </Streamdown>
        </div>
      )
    case 'image':
      return (
        <figure
          className={blockBase}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          <button
            type="button"
            className="flex justify-center w-full p-0 border-0 bg-transparent cursor-zoom-in outline-none"
            onClick={() =>
              block.src
                ? onPreviewImage?.({
                    src: block.src,
                    alt: block.alt ?? block.caption ?? 'Imported image',
                    caption: block.caption,
                  })
                : undefined
            }
            disabled={!block.src}
          >
            <img
              loading="eager"
              src={block.src}
              alt={block.alt ?? block.caption ?? 'Imported image'}
              className="mx-auto block max-w-full max-h-[min(60vh,520px)] object-contain"
            />
          </button>
          {block.caption ? (
            <figcaption className="mt-2 text-text-muted text-[0.82em] text-center">{block.caption}</figcaption>
          ) : null}
        </figure>
      )
    case 'pdf-page':
      return (
        <PdfPageBlock
          key={block.id}
          block={block}
          chapterId={chapterId}
          isDarkMode={pdfDarkMode}
        />
      )
    default: {
      const text = block.text ?? ''
      const tableMarkdown = !hasHighlights && !hasSearch ? tryUnwrapSquashedTable(text) : null
      if (tableMarkdown) {
        return (
          <div
            className={`${blockBase} overflow-x-auto`}
            data-chapter-id={chapterId}
            data-block-id={block.id}
          >
            <Streamdown mode="static" controls={false}>{tableMarkdown}</Streamdown>
          </div>
        )
      }
      return (
        <p
          className={`${blockBase} tracking-[0.012em]`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          {hasHighlights || hasSearch ? renderText(text) : <InlineMd text={text} />}
        </p>
      )
    }
  }
})

function App() {
  const [persistedState, setPersistedState] = useState<PersistedState | null>(null)
  const [mode, setMode] = useState<AppMode>('library')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isUrlDialogOpen, setIsUrlDialogOpen] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<ReaderPanel>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isImporting, setIsImporting] = useState(false)
  const [deletingDocumentIds, setDeletingDocumentIds] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [pdfTwoPage, setPdfTwoPage] = useState(false)
  const [pdfDarkMode, setPdfDarkMode] = useState(false)
  const [pdfZoom, setPdfZoom] = useState(100) // percentage, 50–200
  const [librarySearchQuery, setLibrarySearchQuery] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [isReaderSearchOpen, setIsReaderSearchOpen] = useState(false)
  const [searchResultIndex, setSearchResultIndex] = useState(0)
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null)
  const [previewImage, setPreviewImage] = useState<ImagePreviewState | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [renameDialog, setRenameDialog] = useState<{ document: DocumentRecord; value: string } | null>(null)
  const [expandedTocChapters, setExpandedTocChapters] = useState<string[]>([])
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isSidebarTitleEditing, setIsSidebarTitleEditing] = useState(false)
  const [sidebarTitleValue, setSidebarTitleValue] = useState('')
  const readerRef = useRef<HTMLDivElement | null>(null)
  const sidebarTitleInputRef = useRef<HTMLInputElement | null>(null)
  const progressSaveTimerRef = useRef<number | null>(null)
  const preferenceSaveTimerRef = useRef<number | null>(null)
  const pendingScrollRestoreRef = useRef(false)
  const latestProgressRef = useRef<ReadingProgress | null>(null)
  const latestPreferencesRef = useRef(defaultPreferences)
  const librarySearchRef = useRef<HTMLInputElement | null>(null)
  const readerSearchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const state = await window.paperMagic.loadState()
        if (cancelled) {
          return
        }

        setPersistedState(state)
        setActiveDocumentId((current) => current ?? state.documents[0]?.id ?? null)
      } catch (error) {
        if (cancelled) {
          return
        }

        setLoadError(error instanceof Error ? error.message : 'Paper Magic could not load the local library.')
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      if (progressSaveTimerRef.current) {
        window.clearTimeout(progressSaveTimerRef.current)
        const latestProgress = latestProgressRef.current
        if (latestProgress) {
          void window.paperMagic.saveProgress(latestProgress)
        }
      }
      if (preferenceSaveTimerRef.current) {
        window.clearTimeout(preferenceSaveTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!activeDocumentId && persistedState && persistedState.documents.length > 0) {
      setActiveDocumentId(persistedState.documents[0].id)
    }
  }, [activeDocumentId, persistedState])

  // Stream page-by-page updates as the document is extracted in the background
  useEffect(() => {
    window.paperMagic.onDocumentUpdated((doc) => {
      setPersistedState((prev) => {
        if (!prev) return prev
        const exists = prev.documents.some((d) => d.id === doc.id)
        return {
          ...prev,
          documents: exists
            ? prev.documents.map((d) => (d.id === doc.id ? doc : d))
            : [doc, ...prev.documents],
        }
      })
    })
  }, [])

  useEffect(() => {
    setExpandedTocChapters([])
    setIsSidebarTitleEditing(false)
  }, [activeDocumentId])


  const commitProgress = useCallback((progress: ReadingProgress) => {
    startTransition(() => {
      setPersistedState((currentState) => {
        if (!currentState) {
          return currentState
        }

        return {
          ...currentState,
          progress: upsertProgress(currentState.progress, progress),
        }
      })
    })
  }, [])

  const flushQueuedProgressSave = () => {
    if (progressSaveTimerRef.current) {
      window.clearTimeout(progressSaveTimerRef.current)
      progressSaveTimerRef.current = null
    }

    const latestProgress = latestProgressRef.current
    if (!latestProgress) {
      return
    }

    commitProgress(latestProgress)
    void window.paperMagic.saveProgress(latestProgress)
  }

  const queueProgressSave = useCallback((progress: ReadingProgress) => {
    latestProgressRef.current = progress

    if (progressSaveTimerRef.current) {
      window.clearTimeout(progressSaveTimerRef.current)
    }

    progressSaveTimerRef.current = window.setTimeout(() => {
      const latestProgress = latestProgressRef.current
      progressSaveTimerRef.current = null
      if (latestProgress) {
        commitProgress(latestProgress)
        void window.paperMagic.saveProgress(latestProgress)
      }
    }, 180)
  }, [commitProgress])

  const queuePreferenceSave = (preferences: PersistedState['preferences']) => {
    latestPreferencesRef.current = preferences

    setPersistedState((currentState) => {
      if (!currentState) {
        return currentState
      }

      return {
        ...currentState,
        preferences,
      }
    })

    if (preferenceSaveTimerRef.current) {
      window.clearTimeout(preferenceSaveTimerRef.current)
    }

    preferenceSaveTimerRef.current = window.setTimeout(() => {
      void window.paperMagic.savePreferences(latestPreferencesRef.current)
    }, 160)
  }

  const mergeImportedDocuments = (documents: DocumentRecord[], message: string) => {
    if (documents.length === 0) {
      toast(message)
      return
    }

    setPersistedState((currentState) => {
      if (!currentState) {
        return currentState
      }

      const existingIds = new Set(documents.map((document) => document.id))
      return {
        ...currentState,
        documents: [...documents, ...currentState.documents.filter((document) => !existingIds.has(document.id))],
      }
    })

    setActiveDocumentId(documents[0]?.id ?? activeDocumentId)
    toast.success(message)
  }

  const activeDocument =
    persistedState?.documents.find((document) => document.id === activeDocumentId) ?? null
  const persistedActiveProgress = useMemo(
    () =>
      activeDocument && persistedState
        ? persistedState.progress.find((progress) => progress.documentId === activeDocument.id) ?? null
        : null,
    [activeDocument, persistedState],
  )
  const activeProgress = persistedActiveProgress
  const deferredLibrarySearchQuery = useDeferredValue(librarySearchQuery)
  const libraryDocuments = useMemo(() => {
    if (!persistedState) {
      return []
    }

    return [...persistedState.documents].sort((left, right) => {
      const leftProgress = persistedState.progress.find((progress) => progress.documentId === left.id)
      const rightProgress = persistedState.progress.find((progress) => progress.documentId === right.id)
      const leftTimestamp = new Date(leftProgress?.lastOpenedAt ?? left.metadata.importedAt).getTime()
      const rightTimestamp = new Date(rightProgress?.lastOpenedAt ?? right.metadata.importedAt).getTime()

      return rightTimestamp - leftTimestamp
    })
  }, [persistedState])
  const documentHighlights = useMemo(
    () =>
      activeDocument && persistedState
        ? persistedState.highlights.filter((highlight) => highlight.documentId === activeDocument.id)
        : [],
    [activeDocument, persistedState],
  )
  const documentBookmarks = useMemo(
    () =>
      activeDocument && persistedState
        ? persistedState.bookmarks.filter((bookmark) => bookmark.documentId === activeDocument.id)
        : [],
    [activeDocument, persistedState],
  )
  const searchResults = useMemo(
    () => (activeDocument ? buildSearchResults(activeDocument, searchQuery) : []),
    [activeDocument, searchQuery],
  )
  const activeSearchBlockId = isReaderSearchOpen && searchResults.length > 0
    ? searchResults[searchResultIndex % searchResults.length]?.blockId
    : undefined
  const filteredLibraryDocuments = useMemo(() => {
    const normalizedQuery = deferredLibrarySearchQuery.trim().toLowerCase()

    if (!normalizedQuery) {
      return libraryDocuments
    }

    return libraryDocuments.filter((document) => {
      const haystack = [
        document.title,
        document.author,
        documentAuthorLabel(document),
        document.metadata.originLabel,
        sourceLabel(document.sourceType),
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(normalizedQuery)
    })
  }, [deferredLibrarySearchQuery, libraryDocuments])
  const prevDocumentIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeDocument) {
      return
    }

    prevDocumentIdRef.current = activeDocument.id
  }, [activeDocument])

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !activeDocumentId || mode !== 'reader') {
      return
    }

    const readerElement = readerRef.current
    const targetBlockId = activeProgress?.blockId
    if (!readerElement || !targetBlockId) {
      return
    }

    const target = readerElement.querySelector<HTMLElement>(`[data-block-id="${targetBlockId}"]`)
    if (!target) {
      return
    }

    pendingScrollRestoreRef.current = false
    target.scrollIntoView({ block: 'start' })
  }, [activeDocumentId, activeProgress?.blockId, mode])

  const openDocument = (documentId: string) => {
    if (!persistedState) {
      return
    }

    const document = persistedState.documents.find((item) => item.id === documentId)
    if (!document) {
      return
    }

    setActiveDocumentId(documentId)
    setMode('reader')
    setActivePanel('toc')
    setIsSidebarOpen(true)
    setSearchQuery('')
    setSelectionDraft(null)
    setPreviewImage(null)
    setPdfZoom(100)
    setPdfTwoPage(false)
    setPdfDarkMode(false)

    const existingProgress = persistedState.progress.find((progress) => progress.documentId === documentId)
    const fallbackBlock = document.chapters[0]?.content[0]
    const fallbackChapter = document.chapters[0]
    pendingScrollRestoreRef.current = Boolean(existingProgress)

    if (fallbackBlock && fallbackChapter) {
      queueProgressSave({
        documentId,
        progress: existingProgress?.progress ?? 0,
        chapterId: existingProgress?.chapterId ?? fallbackChapter.id,
        blockId: existingProgress?.blockId ?? fallbackBlock.id,
        pageIndex: 0,
        readingMode: 'scroll',
        lastOpenedAt: new Date().toISOString(),
      })
    }
  }

  const exitReader = () => {
    flushQueuedProgressSave()
    setMode('library')
    setActivePanel(null)
    setIsSidebarOpen(true)
    setSelectionDraft(null)
    setPreviewImage(null)
  }

  const handleImportDialog = async () => {
    setIsImporting(true)

    try {
      const importedDocuments = await window.paperMagic.importWithDialog()
      mergeImportedDocuments(
        importedDocuments,
        importedDocuments.length > 0
          ? `Imported ${importedDocuments.length} document${importedDocuments.length > 1 ? 's' : ''} into the local library.`
          : 'No new files were selected for import.',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The selected files could not be imported.')
    } finally {
      setIsImporting(false)
    }
  }

  const handleUrlImport = async () => {
    const normalized = urlInput.trim()
    if (!normalized) {
      toast.error('Enter a URL to import.')
      return
    }

    setIsImporting(true)

    try {
      const importedDocuments = await window.paperMagic.importFromUrl(normalized)
      mergeImportedDocuments(
        importedDocuments,
        importedDocuments.length > 0
          ? 'Imported URL into the library.'
          : 'That URL is already in your library.',
      )
      if (importedDocuments.length > 0) {
        setIsUrlDialogOpen(false)
        setUrlInput('')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The URL could not be imported.')
    } finally {
      setIsImporting(false)
    }
  }

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return
    }

    const paths = Array.from(files)
      .map((file) => (file as DroppedFile).path)
      .filter((pathValue): pathValue is string => Boolean(pathValue))

    if (paths.length === 0) {
      toast.error('Dropped files could not be resolved into local paths.')
      return
    }

    setIsImporting(true)

    try {
      const importedDocuments = await window.paperMagic.importPaths(paths)
      mergeImportedDocuments(
        importedDocuments,
        importedDocuments.length > 0
          ? `Imported ${importedDocuments.length} dropped document${importedDocuments.length > 1 ? 's' : ''}.`
          : 'Those files were already in the local library.',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The dropped files could not be imported.')
    } finally {
      setIsImporting(false)
    }
  }

  const handleReaderScroll = () => {
    if (!readerRef.current || !activeDocument) {
      return
    }

    const readerElement = readerRef.current
    const scrollDistance = readerElement.scrollHeight - readerElement.clientHeight
    const progress = scrollDistance <= 0 ? 0 : readerElement.scrollTop / scrollDistance
    const location = buildCurrentLocation(readerElement)

    if (!location) {
      return
    }

    queueProgressSave({
      documentId: activeDocument.id,
      progress,
      chapterId: location.chapterId,
      blockId: location.blockId,
      pageIndex: 0,
      readingMode: 'scroll',
      lastOpenedAt: new Date().toISOString(),
    })
  }

  const jumpToLocation = useCallback((chapterId: string, blockId: string) => {
    if (!activeDocument || !readerRef.current) {
      return
    }

    const readerEl = readerRef.current
    const target = readerEl.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
    if (!target) {
      return
    }

    // With content-visibility:auto, off-screen elements have estimated sizes.
    // Instant scroll forces the browser to lay out the target with real dimensions,
    // then a rAF smooth-scroll lands at the correct position.
    target.scrollIntoView({ block: 'start' })
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })

    queueProgressSave({
      documentId: activeDocument.id,
      progress: activeProgress?.progress ?? 0,
      chapterId,
      blockId,
      pageIndex: 0,
      readingMode: 'scroll',
      lastOpenedAt: new Date().toISOString(),
    })
  }, [activeDocument, activeProgress?.progress, queueProgressSave])

  const handleRemoveDocument = async (document: DocumentRecord) => {
    if (!persistedState || deletingDocumentIds.includes(document.id)) {
      return
    }

    setConfirmDialog({
      title: 'Remove from library',
      message: `Remove "${document.title}"? This deletes the saved copy, cover assets, and reading state.`,
      confirmLabel: 'Remove',
      onConfirm: () => void handleRemoveDocumentConfirmed(document),
    })
  }

  const handleRenameDocument = async (document: DocumentRecord, title: string) => {
    const trimmed = title.trim()
    if (!trimmed || trimmed === document.title || !persistedState) {
      return
    }

    setPersistedState((current) => {
      if (!current) return current
      return {
        ...current,
        documents: current.documents.map((doc) =>
          doc.id === document.id ? { ...doc, title: trimmed } : doc
        ),
      }
    })

    try {
      await window.paperMagic.renameDocument(document.id, trimmed)
    } catch (error) {
      setPersistedState((current) => {
        if (!current) return current
        return {
          ...current,
          documents: current.documents.map((doc) =>
            doc.id === document.id ? { ...doc, title: document.title } : doc
          ),
        }
      })
      toast.error(error instanceof Error ? error.message : `Could not rename "${document.title}".`)
    }
  }

  const handleRemoveDocumentConfirmed = async (document: DocumentRecord) => {
    if (!persistedState) {
      return
    }

    const previousState = persistedState
    const previousMode = mode
    const previousActiveDocumentId = activeDocumentId
    const previousActivePanel = activePanel
    const previousIsSidebarOpen = isSidebarOpen
    const previousSearchQuery = searchQuery
    const previousSelectionDraft = selectionDraft
    const previousPreviewImage = previewImage
    const isRemovingActiveDocument = activeDocumentId === document.id
    const nextState = removeDocumentFromState(previousState, document.id)

    if (isRemovingActiveDocument && progressSaveTimerRef.current) {
      window.clearTimeout(progressSaveTimerRef.current)
      progressSaveTimerRef.current = null
      latestProgressRef.current = null
    }

    setDeletingDocumentIds((current) => [...current, document.id])
    setPersistedState(nextState)

    if (isRemovingActiveDocument) {
      setMode('library')
      setActivePanel(null)
      setIsSidebarOpen(true)
      setSelectionDraft(null)
      setPreviewImage(null)
      setSearchQuery('')
      setActiveDocumentId(nextState.documents[0]?.id ?? null)
    } else if (activeDocumentId && !nextState.documents.some((entry) => entry.id === activeDocumentId)) {
      setActiveDocumentId(nextState.documents[0]?.id ?? null)
    }

    try {
      await window.paperMagic.removeDocument(document.id)
      toast.success(`Removed "${document.title}" from your library.`)
    } catch (error) {
      setPersistedState(previousState)
      setMode(previousMode)
      setActiveDocumentId(previousActiveDocumentId)
      setActivePanel(previousActivePanel)
      setIsSidebarOpen(previousIsSidebarOpen)
      setSearchQuery(previousSearchQuery)
      setSelectionDraft(previousSelectionDraft)
      setPreviewImage(previousPreviewImage)
      toast.error(error instanceof Error ? error.message : `Could not remove ${document.title}.`)
    } finally {
      setDeletingDocumentIds((current) => current.filter((documentId) => documentId !== document.id))
    }
  }

  const addBookmark = async () => {
    if (!activeDocument || !persistedState) {
      return
    }

    const fallbackBlock = activeDocument.chapters[0]?.content[0]
    const fallbackChapter = activeDocument.chapters[0]
    const blockId = activeProgress?.blockId ?? fallbackBlock?.id
    const chapterId = activeProgress?.chapterId ?? fallbackChapter?.id

    if (!blockId || !chapterId) {
      return
    }

    const bookmark = await window.paperMagic.addBookmark({
      documentId: activeDocument.id,
      chapterId,
      blockId,
      label: `Bookmark · ${formatPercent(activeProgress?.progress ?? 0)}`,
    })

    setPersistedState({
      ...persistedState,
      bookmarks: [bookmark, ...persistedState.bookmarks],
    })
  }

  const addHighlight = async () => {
    if (!activeDocument || !selectionDraft || !persistedState) {
      return
    }

    const highlight = await window.paperMagic.addHighlight({
      documentId: activeDocument.id,
      chapterId: selectionDraft.chapterId,
      blockId: selectionDraft.blockId,
      text: selectionDraft.text,
    })

    setPersistedState({
      ...persistedState,
      highlights: [highlight, ...persistedState.highlights],
    })
    setSelectionDraft(null)
    window.getSelection()?.removeAllRanges()
  }

  const toggleHighlightAtSelection = async () => {
    if (!activeDocument || !persistedState) {
      return
    }

    if (selectionDraft) {
      await addHighlight()
      return
    }

    const selection = window.getSelection()
    const node = selection?.focusNode
    const blockElement = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null))?.closest<HTMLElement>('[data-block-id]')
    if (!blockElement) {
      return
    }

    const blockId = blockElement.dataset.blockId
    const existingHighlight = persistedState.highlights.find(
      (h) => h.documentId === activeDocument.id && h.blockId === blockId,
    )

    if (existingHighlight) {
      await window.paperMagic.removeHighlight(existingHighlight.id)
      setPersistedState({
        ...persistedState,
        highlights: persistedState.highlights.filter((h) => h.id !== existingHighlight.id),
      })
    }
  }

  const removeHighlightById = async (highlightId: string) => {
    if (!persistedState) return
    await window.paperMagic.removeHighlight(highlightId)
    setPersistedState({
      ...persistedState,
      highlights: persistedState.highlights.filter((h) => h.id !== highlightId),
    })
  }

  const removeBookmarkById = async (bookmarkId: string) => {
    if (!persistedState) return
    await window.paperMagic.removeBookmark(bookmarkId)
    setPersistedState({
      ...persistedState,
      bookmarks: persistedState.bookmarks.filter((b) => b.id !== bookmarkId),
    })
  }

  const handleSelectionChange = () => {
    const selection = window.getSelection()

    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      setSelectionDraft(null)
      return
    }

    const range = selection.getRangeAt(0)
    const node =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : (range.commonAncestorContainer as Element)
    const blockElement = node?.closest<HTMLElement>('[data-block-id]')

    if (!blockElement) {
      setSelectionDraft(null)
      return
    }

    const rect = range.getBoundingClientRect()

    setSelectionDraft({
      chapterId: blockElement.dataset.chapterId ?? '',
      blockId: blockElement.dataset.blockId ?? '',
      text: selection.toString().trim(),
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
    })
  }

  const readerHotkeysEnabled = mode === 'reader' && Boolean(activeDocument)

  useHotkey(
    'Mod+F',
    () => {
      setIsReaderSearchOpen(true)
      setSearchResultIndex(0)
      setTimeout(() => readerSearchRef.current?.focus(), 0)
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'Mod+F',
    () => {
      librarySearchRef.current?.focus()
    },
    { enabled: mode === 'library' },
  )

  useHotkey(
    'Mod+T',
    () => {
      setActivePanel('toc')
      setIsSidebarOpen(true)
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'Mod+B',
    () => {
      setIsSidebarOpen((open) => !open)
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'F',
    () => {
      void toggleFullscreen()
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'Escape',
    () => {
      if (previewImage) {
        setPreviewImage(null)
        return
      }

      if (isReaderSearchOpen) {
        setIsReaderSearchOpen(false)
        setSearchQuery('')
        return
      }

      if (selectionDraft) {
        setSelectionDraft(null)
        window.getSelection()?.removeAllRanges()
        return
      }

      if (activePanel) {
        if (activePanel !== 'toc') {
          setActivePanel('toc')
          setIsSidebarOpen(true)
          return
        }
      }

      if (isSidebarOpen) {
        setIsSidebarOpen(false)
        return
      }

      exitReader()
    },
    { enabled: readerHotkeysEnabled, ignoreInputs: false },
  )

  useHotkey(
    'Mod+H',
    () => {
      void toggleHighlightAtSelection()
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'Mod+O',
    () => {
      void handleImportDialog()
    },
    { enabled: true },
  )

  useHotkey(
    'J',
    () => {
      readerRef.current?.scrollBy({ top: 160, behavior: 'smooth' })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'K',
    () => {
      readerRef.current?.scrollBy({ top: -160, behavior: 'smooth' })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'N',
    () => {
      if (isReaderSearchOpen && searchResults.length > 0) {
        setSearchResultIndex((i) => (i + 1) % searchResults.length)
        return
      }
      setActivePanel((currentPanel) => (currentPanel === 'notes' ? null : 'notes'))
      setIsSidebarOpen(true)
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'Shift+N',
    () => {
      if (isReaderSearchOpen && searchResults.length > 0) {
        setSearchResultIndex((i) => (i - 1 + searchResults.length) % searchResults.length)
      }
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'B',
    () => {
      void addBookmark()
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    { key: '=' },
    () => {
      queuePreferenceSave({
        ...latestPreferencesRef.current,
        fontSize: clamp(latestPreferencesRef.current.fontSize + 1, 16, 24),
      })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    { key: '=', shift: true },
    () => {
      queuePreferenceSave({
        ...latestPreferencesRef.current,
        fontSize: clamp(latestPreferencesRef.current.fontSize + 1, 16, 24),
      })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    '-',
    () => {
      queuePreferenceSave({
        ...latestPreferencesRef.current,
        fontSize: clamp(latestPreferencesRef.current.fontSize - 1, 16, 24),
      })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    '[',
    () => {
      queuePreferenceSave({
        ...latestPreferencesRef.current,
        readingWidth: clamp(latestPreferencesRef.current.readingWidth - 20, 700, 1040),
      })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    ']',
    () => {
      queuePreferenceSave({
        ...latestPreferencesRef.current,
        readingWidth: clamp(latestPreferencesRef.current.readingWidth + 20, 700, 1040),
      })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'Space',
    () => {
      setActivePanel(null)
      readerRef.current?.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' })
    },
    { enabled: readerHotkeysEnabled },
  )

  useHotkey(
    'Shift+G',
    () => {
      const readerElement = readerRef.current
      if (!readerElement) {
        return
      }

      readerElement.scrollTo({ top: readerElement.scrollHeight, behavior: 'smooth' })
    },
    { enabled: readerHotkeysEnabled },
  )

  const isPdfReader = readerHotkeysEnabled && activeDocument?.sourceType === 'pdf'

  // PDF zoom: Ctrl/Cmd + minus / equals(plus)
  useHotkey(
    'Mod+-',
    () => { setPdfZoom((z) => Math.max(50, z - 10)) },
    { enabled: isPdfReader },
  )

  useHotkey(
    'Mod+=',
    () => { setPdfZoom((z) => Math.min(200, z + 10)) },
    { enabled: isPdfReader },
  )

  useHotkey(
    { key: '=', shift: true, mod: true },
    () => { setPdfZoom((z) => Math.min(200, z + 10)) },
    { enabled: isPdfReader },
  )

  // Ctrl/Cmd+0: reset zoom to 100%
  useHotkey(
    'Mod+0',
    () => { setPdfZoom(100) },
    { enabled: isPdfReader },
  )

  // D: toggle dark mode (invert)
  useHotkey(
    'D',
    () => { setPdfDarkMode((v) => !v) },
    { enabled: isPdfReader },
  )

  // P: toggle two-page spread
  useHotkey(
    'P',
    () => { setPdfTwoPage((v) => !v) },
    { enabled: isPdfReader },
  )

  useHotkeySequence(
    ['G', 'G'],
    () => {
      readerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    },
    { enabled: readerHotkeysEnabled, timeout: 900 },
  )

  useEffect(() => {
    if (!isReaderSearchOpen || searchResults.length === 0) {
      return
    }
    const result = searchResults[searchResultIndex]
    if (result) {
      jumpToLocation(result.chapterId, result.blockId)
    }
  }, [searchResultIndex, isReaderSearchOpen, searchResults, jumpToLocation])

  useEffect(() => {
    if (isReaderSearchOpen) {
      setSearchResultIndex(0)
    }
  }, [searchQuery, isReaderSearchOpen])

  const tocGroups = useMemo(() => buildTocGroups(activeDocument), [activeDocument])

  // Shared list-item classes for TOC items, annotation items
  const listItemBase = 'w-full px-[12px] py-[10px] text-left text-text-primary transition-[background,color] duration-[140ms] cursor-pointer font-[inherit] outline-none text-sm'
  const listItemHover = 'hover:bg-white/[0.05] hover:text-text-primary'
  const listItemActive = 'bg-white/[0.07] text-text-primary'

  if (isBootstrapping) {
    return (
      <div className="min-h-screen text-text-primary bg-bg-page flex items-center justify-center">
        <div className="w-[min(480px,calc(100vw-48px))]">
          <p className="m-0 mb-[8px] uppercase tracking-[0.20em] text-[0.60rem] text-text-faint font-ui font-semibold">Paper Magic</p>
          <h1 className="m-0 text-[1.8rem] font-display font-bold leading-[1.02] tracking-[-0.04em] mb-3">
            Loading library…
          </h1>
          <p className="text-text-muted text-sm leading-[1.6]">
            Opening the local database and restoring your reading state.
          </p>
        </div>
      </div>
    )
  }

  if (loadError || !persistedState) {
    return (
      <div className="min-h-screen text-text-primary bg-bg-page flex items-center justify-center">
        <div className="w-[min(480px,calc(100vw-48px))]">
          <p className="m-0 mb-[8px] uppercase tracking-[0.20em] text-[0.60rem] text-text-faint font-ui font-semibold">Paper Magic</p>
          <h1 className="m-0 text-[1.8rem] font-display font-bold leading-[1.02] tracking-[-0.04em] mb-3">
            Library unavailable
          </h1>
          <p className="text-text-muted text-sm leading-[1.6]">
            {loadError ?? 'The application state could not be initialized.'}
          </p>
        </div>
      </div>
    )
  }

  const visibleReaderPanel = activePanel ?? 'toc'
  const readerTabs = [
    { id: 'toc' as const, label: 'Contents', icon: ListIcon, shortcut: 'Mod+T' },
    { id: 'notes' as const, label: 'Notes', icon: NotebookPenIcon, shortcut: 'N' },
  ]
  const readerColumnStyle = {
    ['--reader-width' as string]: `${clamp(persistedState.preferences.readingWidth, 700, 1040)}px`,
    fontSize: `${persistedState.preferences.fontSize}px`,
  } as React.CSSProperties

  return (
    <TooltipProvider>
    <div
      className="min-h-screen text-text-primary bg-bg-page"
      onDragEnter={() => setIsDragging(true)}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setIsDragging(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        setIsDragging(false)

        if (event.dataTransfer.files.length > 0) {
          void handleFilesSelected(event.dataTransfer.files)
        }
      }}
    >
      {isDragging ? <DropOverlay /> : null}

      {mode === 'library' ? (
        <main className="w-[min(1200px,calc(100vw-48px))] mx-auto pt-8 pb-[88px] max-sm:w-[min(calc(100vw-24px),1200px)] max-sm:pt-5">
          {/* Library header */}
          <section className="flex justify-between items-center gap-[18px] mb-6 max-sm:items-start pb-5 border-b border-border-subtle">
            <div>
              <p className="m-0 mb-[6px] uppercase tracking-[0.20em] text-[0.60rem] text-text-faint font-ui font-semibold">Paper Magic</p>
              <h1 className="m-0 text-[clamp(1.8rem,4.5vw,2.6rem)] font-display font-bold leading-[0.96] tracking-[-0.05em]">
                Library
              </h1>
            </div>
            <div className="flex items-center gap-[6px] shrink-0">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void handleImportDialog()}
                disabled={isImporting}
                aria-label="Import files"
              >
                {isImporting ? <Spinner className="size-4" /> : <UploadIcon size={13} strokeWidth={2} aria-hidden="true" />}
                Import
              </Button>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setIsUrlDialogOpen(true)}
                disabled={isImporting}
                aria-label="Import from URL"
              >
                <GlobeIcon size={13} strokeWidth={2} aria-hidden="true" />
                URL
              </Button>
              <Button
                variant="icon"
                size="md"
                className="border border-border-subtle"
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                aria-label="Open settings"
              >
                <SettingsIcon size={15} strokeWidth={1.9} />
              </Button>
            </div>
          </section>

          {/* Empty state */}
          {persistedState.documents.length === 0 ? (
            <section className="border border-border-subtle p-8">
              <p className="m-0 mb-3 text-[0.68rem] tracking-[0.18em] uppercase text-text-muted">Empty library</p>
              <h2 className="m-0 mb-4 text-[1.6rem] font-display font-bold leading-[1.0] tracking-[-0.04em]">
                No documents yet.
              </h2>
              <p className="max-w-[38ch] text-text-muted leading-[1.6] mb-6">
                Import a PDF, EPUB, or URL to begin. Your library stays offline except optional web fetches for URL imports.
              </p>
              <div className="flex items-center gap-2 max-sm:flex-col max-sm:items-stretch">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => void handleImportDialog()}
                  disabled={isImporting}
                >
                  {isImporting ? <Spinner className="size-4" /> : <UploadIcon size={15} strokeWidth={1.9} aria-hidden="true" />}
                  Import file
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => setIsUrlDialogOpen(true)}
                  disabled={isImporting}
                >
                  <GlobeIcon size={15} strokeWidth={1.9} aria-hidden="true" />
                  Import URL
                </Button>
              </div>
            </section>
          ) : null}

          {/* Library section */}
          {libraryDocuments.length > 0 ? (
            <section className="mt-5">
              <div className="flex justify-between gap-4 items-center mb-4 max-sm:flex-col max-sm:items-stretch">
                <div className="flex items-baseline gap-3">
                  <h2 className="m-0 text-[0.78rem] font-ui font-semibold tracking-[0.12em] uppercase text-text-muted">
                    Library
                  </h2>
                  <span className="text-text-faint text-[0.72rem] tabular-nums">
                    {filteredLibraryDocuments.length} {filteredLibraryDocuments.length === 1 ? 'item' : 'items'}
                  </span>
                </div>
                <Input
                  ref={librarySearchRef}
                  size="md"
                  prefix={<SearchIcon size={15} strokeWidth={1.9} aria-hidden="true" />}
                  wrapperClassName="w-[min(100%,300px)] max-sm:w-full"
                  value={librarySearchQuery}
                  onChange={(event) => setLibrarySearchQuery(event.target.value)}
                  placeholder="Search title, author…"
                />
              </div>
              {filteredLibraryDocuments.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-px bg-border-subtle border border-border-subtle max-sm:grid-cols-2">
                  {filteredLibraryDocuments.map((document) => {
                    const progress = persistedState.progress.find((item) => item.documentId === document.id)
                    const coverImageUrl = resolveDocumentCoverImage(document)
                    const progressValue = progress?.progress ?? 0
                    const progressWidth = `${Math.max(0, Math.min(100, progressValue * 100))}%`
                    const isDeletingDocument = deletingDocumentIds.includes(document.id)
                    const readingMins = document.metadata.estimatedMinutes
                    return (
                      <ContextMenu
                        key={document.id}
                        items={[
                          {
                            label: 'Open',
                            onSelect: () => { if (!isDeletingDocument) openDocument(document.id) },
                          },
                          {
                            label: 'Rename',
                            disabled: isDeletingDocument,
                            onSelect: () => setRenameDialog({ document, value: document.title }),
                          },
                          { type: 'separator' },
                          {
                            label: 'Remove from library',
                            destructive: true,
                            disabled: isDeletingDocument,
                            onSelect: () => void handleRemoveDocument(document),
                          },
                        ]}
                      >
                      <article
                        className={`bg-bg-page grid grid-rows-[auto_minmax(0,1fr)] h-full p-0 text-left transition-[background] duration-[140ms] cursor-pointer hover:bg-bg-surface ${isDeletingDocument ? 'opacity-60 pointer-events-none' : ''}`}
                        onClick={() => {
                          if (!isDeletingDocument) {
                            openDocument(document.id)
                          }
                        }}
                      >
                        {/* Cover art */}
                        <div
                          className="relative min-h-0 aspect-[0.72] overflow-hidden"
                          style={coverImageUrl ? undefined : coverStyle(document)}
                        >
                          {coverImageUrl ? (
                            <>
                              <img
                                className="absolute inset-0 w-full h-full object-cover"
                                src={coverImageUrl}
                                alt={`Cover for ${document.title}`}
                                loading="lazy"
                              />
                              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/[0.15] to-black/[0.85]" />
                            </>
                          ) : null}
                          {/* Format badge — top left */}
                          <span className="absolute top-[10px] left-[10px] z-[1] inline-flex items-center gap-1 px-[7px] py-[4px] border border-white/[0.15] bg-black/50 text-white/[0.78] text-[0.66rem] tracking-[0.10em] uppercase font-ui">
                            <SourceIcon sourceType={document.sourceType} size={11} strokeWidth={2} />
                            {sourceLabel(document.sourceType)}
                          </span>
                          {/* Reading time — bottom left */}
                          {readingMins > 0 ? (
                            <span className="absolute bottom-[10px] left-[10px] z-[1] inline-flex items-center gap-1 px-[7px] py-[4px] border border-white/[0.12] bg-black/50 text-white/[0.65] text-[0.64rem] tracking-[0.08em] uppercase font-ui">
                              <ClockIcon size={10} strokeWidth={2} aria-hidden="true" />
                              {readingMins < 60 ? `${readingMins}m` : `${Math.round(readingMins / 60)}h`}
                            </span>
                          ) : null}
                        </div>
                        {/* Document meta */}
                        <div className="min-w-0 flex flex-col p-3 gap-[8px]">
                          <p className="m-0 text-text-muted text-[0.68rem] tracking-[0.14em] uppercase truncate">
                            {documentAuthorLabel(document)}
                          </p>
                          <h3 className="m-0 min-w-0 overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:3] [display:-webkit-box] text-[1.02rem] font-display font-semibold leading-[1.12] tracking-[-0.03em] flex-1">
                            {document.title}
                          </h3>
                          {/* Progress footer */}
                          <div className="mt-auto pt-3 border-t border-border-subtle">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-text-muted text-[0.65rem] tracking-[0.14em] uppercase">
                                {progress ? 'Progress' : 'Not started'}
                              </span>
                              {progress ? (
                                <span className="text-text-primary text-[0.78rem] font-ui font-semibold tabular-nums tracking-[-0.01em]">
                                  {formatPercent(progressValue)}
                                </span>
                              ) : null}
                            </div>
                            <div className="h-[2px] bg-white/[0.07]" aria-hidden="true">
                              {progress ? <div className="h-full bg-text-primary/60 transition-[width_300ms]" style={{ width: progressWidth }} /> : null}
                            </div>
                          </div>
                        </div>
                      </article>
                      </ContextMenu>
                    )
                  })}
                </div>
              ) : (
                <p className="text-text-muted pt-3 text-sm">No items match that search.</p>
              )}
            </section>
          ) : null}
        </main>
      ) : null}

      {mode === 'reader' && activeDocument ? (
        <section
          className={`min-h-screen bg-bg-page grid transition-[grid-template-columns] duration-[180ms] relative max-sm:block ${isSidebarOpen ? 'grid-cols-[320px_minmax(0,1fr)]' : 'grid-cols-[0_minmax(0,1fr)]'}`}
        >
          {/* Sidebar */}
          <aside
            className={`sticky top-0 h-screen overflow-y-auto overflow-x-hidden border-r border-border-subtle bg-[#000] transition-[transform,opacity,border-color] duration-[180ms] max-sm:fixed max-sm:top-0 max-sm:left-0 max-sm:bottom-0 max-sm:w-screen max-sm:h-screen max-sm:z-30 ${
              isSidebarOpen
                ? 'max-sm:translate-x-0 max-sm:pointer-events-auto'
                : 'translate-x-[-100%] opacity-0 pointer-events-none border-transparent max-sm:opacity-100 max-sm:border-border-subtle'
            }`}
          >
            <div className="min-h-full flex flex-col">
              {/* Sidebar top */}
              <div className="px-[18px] pt-[14px] pb-[16px] border-b border-border-subtle">
                <div className="mb-[16px] flex items-center justify-between gap-[8px]">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={exitReader}
                  >
                    <ChevronLeftIcon size={14} strokeWidth={1.9} aria-hidden="true" />
                    <span>Library</span>
                  </Button>
                  <div className="inline-flex items-center gap-[6px]">
                    <Tooltip content="Collapse sidebar" shortcut="Mod+B" side="bottom">
                      <Button
                        variant="icon"
                        size="md"
                        className="border border-border-subtle"
                        onClick={() => setIsSidebarOpen(false)}
                        aria-label="Collapse sidebar"
                      >
                        <PanelLeftCloseIcon size={15} strokeWidth={1.9} aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
                <p className="m-0 mb-[8px] uppercase tracking-[0.16em] text-[0.65rem] text-text-muted inline-flex items-center gap-1.5">
                  <SourceIcon sourceType={activeDocument.sourceType} size={12} strokeWidth={1.9} />
                  {sourceLabel(activeDocument.sourceType)}
                </p>
                {isSidebarTitleEditing ? (
                  <input
                    ref={sidebarTitleInputRef}
                    autoFocus
                    value={sidebarTitleValue}
                    onChange={(e) => setSidebarTitleValue(e.target.value)}
                    onBlur={() => {
                      const trimmed = sidebarTitleValue.trim()
                      if (trimmed && trimmed !== activeDocument.title) {
                        void handleRenameDocument(activeDocument, trimmed)
                      }
                      setIsSidebarTitleEditing(false)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        sidebarTitleInputRef.current?.blur()
                      }
                      if (e.key === 'Escape') {
                        setSidebarTitleValue(activeDocument.title)
                        setIsSidebarTitleEditing(false)
                      }
                    }}
                    className="w-full m-0 bg-transparent text-[1.5rem] font-display font-bold leading-[1.04] tracking-[-0.04em] text-text-primary border-0 border-b border-border-strong outline-none pb-[2px]"
                  />
                ) : (
                  <h1
                    className="m-0 text-[1.5rem] font-display font-bold leading-[1.04] tracking-[-0.04em] cursor-text group"
                    title="Click to rename"
                    onClick={() => {
                      setSidebarTitleValue(activeDocument.title)
                      setIsSidebarTitleEditing(true)
                    }}
                  >
                    {activeDocument.title}
                  </h1>
                )}
                {activeDocument.author && documentAuthorLabel(activeDocument) !== 'Unknown author' ? (
                  <p className="mt-[6px] text-text-muted font-ui text-[0.82rem] tracking-[0.02em]">
                    {activeDocument.author}
                  </p>
                ) : null}
              </div>

              {/* Sidebar main */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* Tab bar */}
                <div
                  className="grid grid-cols-2 border-b border-border-subtle max-sm:sticky max-sm:top-0 max-sm:bg-[#000]"
                  role="tablist"
                  aria-label="Reader panels"
                >
                  {readerTabs.map((tab) => {
                    const Icon = tab.icon
                    return (
                      <Tooltip key={tab.id} content={tab.label} shortcut={tab.shortcut} side="bottom">
                        <button
                          className={`inline-flex items-center justify-center gap-2 min-w-0 min-h-[52px] px-3 py-[11px] border-0 border-r border-r-border-subtle last:border-r-0 bg-transparent text-text-muted cursor-pointer transition-[border-color,background,color] duration-[160ms] font-[inherit] outline-none hover:bg-white/[0.04] hover:text-text-primary ${visibleReaderPanel === tab.id ? 'text-text-primary bg-[#070707]' : ''}`}
                          onClick={() => {
                            setActivePanel(tab.id)
                            setIsSidebarOpen(true)
                          }}
                        >
                          <span className="min-w-0 inline-flex items-center gap-2">
                            <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
                            <span className="whitespace-nowrap">{tab.label}</span>
                          </span>
                        </button>
                      </Tooltip>
                    )
                  })}
                </div>

                {/* Progress row */}
                <div className="px-[18px] pb-[14px] pt-3 border-b border-border-subtle">
                  <div className="flex items-center justify-between mb-[7px]">
                    <span className="text-text-muted text-[0.65rem] tracking-[0.14em] uppercase">Reading progress</span>
                    <span className="text-text-secondary text-[0.78rem] font-ui font-semibold tabular-nums tracking-[-0.01em]">
                      {formatPercent(activeProgress?.progress ?? 0)}
                    </span>
                  </div>
                  <div className="h-[2px] bg-white/[0.07]" aria-hidden="true">
                    <div
                      className="h-full bg-white/50 transition-[width] duration-300"
                      style={{ width: `${Math.round((activeProgress?.progress ?? 0) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* TOC panel */}
                {visibleReaderPanel === 'toc' ? (
                  <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain pb-8 [scrollbar-width:thin] px-[14px] py-4">
                    <div className="flex justify-between items-center gap-3 mb-3">
                      <span className="inline-flex items-center gap-1.5 text-text-muted text-[0.65rem] tracking-[0.16em] uppercase font-ui font-semibold">
                        <ListIcon size={12} strokeWidth={2} aria-hidden="true" />
                        Contents
                      </span>
                    </div>
                    <div className="grid gap-[2px]">
                      {tocGroups.map((group) => {
                        const isExpanded = expandedTocChapters.includes(group.chapterId)
                        const isActiveChapter =
                          activeProgress?.chapterId === group.chapterId ||
                          group.items.some((item) => item.blockId === activeProgress?.blockId)

                        return (
                          <section key={group.chapterId}>
                            <button
                              className={`w-full px-[12px] py-[10px] flex items-start gap-[9px] text-text-secondary text-[0.82rem] text-left transition-[background,color] duration-[140ms] cursor-pointer font-[inherit] outline-none hover:bg-white/[0.05] hover:text-text-primary ${isActiveChapter || isExpanded ? 'text-text-primary bg-white/[0.05]' : ''}`}
                              aria-expanded={isExpanded}
                              onClick={() => {
                                if (group.items.length === 0) {
                                  jumpToLocation(group.chapterId, group.blockId)
                                  return
                                }

                                setExpandedTocChapters((current) =>
                                  current.includes(group.chapterId)
                                    ? current.filter((chapterId) => chapterId !== group.chapterId)
                                    : [...current, group.chapterId],
                                )
                              }}
                            >
                              <ChevronRightIcon
                                className={`shrink-0 mt-[2px] transition-transform duration-[140ms] text-text-muted ${isExpanded ? 'rotate-90' : ''}`}
                                size={13}
                                strokeWidth={2}
                                aria-hidden="true"
                              />
                              <span className="leading-[1.45] break-words min-w-0">{group.title}</span>
                            </button>
                            {isExpanded ? (
                              <div className="ml-[22px] border-l border-border-subtle pl-[10px]">
                                {group.items.map((item) => (
                                  <button
                                    key={item.id}
                                    className={`${listItemBase} ${listItemHover} text-[0.78rem] text-text-muted text-left ${item.level === 2 ? '' : item.level === 3 ? 'pl-4' : ''} ${activeProgress?.blockId === item.blockId ? listItemActive + ' text-text-primary' : ''}`}
                                    onClick={() => jumpToLocation(item.chapterId, item.blockId)}
                                  >
                                    <span className="leading-[1.45] break-words">{item.title}</span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </section>
                        )
                      })}
                    </div>
                  </div>
                ) : null}

                {/* Notes panel */}
                {visibleReaderPanel === 'notes' ? (
                  <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain pb-8 [scrollbar-width:thin] px-[14px] py-4">
                    <div className="flex justify-between items-center gap-3 mb-3">
                      <span className="inline-flex items-center gap-1.5 text-text-muted text-[0.65rem] tracking-[0.16em] uppercase font-ui font-semibold">
                        <NotebookPenIcon size={12} strokeWidth={2} aria-hidden="true" />
                        Notes
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActivePanel('toc')}
                      >
                        <XIcon size={14} strokeWidth={1.9} aria-hidden="true" />
                        Close
                      </Button>
                    </div>
                    {/* Bookmarks */}
                    <div className="mt-4">
                      <div className="inline-flex items-center gap-2 mb-[10px] text-text-secondary">
                        <BookmarkIcon size={14} strokeWidth={1.9} aria-hidden="true" />
                        <h3 className="m-0">Bookmarks</h3>
                      </div>
                      {documentBookmarks.map((bookmark: Bookmark) => (
                        <ContextMenu
                          key={bookmark.id}
                          items={[
                            {
                              label: 'Jump to location',
                              onSelect: () => jumpToLocation(bookmark.chapterId, bookmark.blockId),
                            },
                            { type: 'separator' },
                            {
                              label: 'Remove bookmark',
                              destructive: true,
                              onSelect: () => void removeBookmarkById(bookmark.id),
                            },
                          ]}
                        >
                          <button
                            className={`${listItemBase} ${listItemHover} mt-[10px] first:mt-0 ${activeProgress?.blockId === bookmark.blockId ? listItemActive : ''}`}
                            onClick={() => jumpToLocation(bookmark.chapterId, bookmark.blockId)}
                          >
                            <strong className="block mb-1">{bookmark.label}</strong>
                            <span className="text-text-muted">{formatDate(bookmark.createdAt)}</span>
                          </button>
                        </ContextMenu>
                      ))}
                      {documentBookmarks.length === 0 ? (
                        <p className="text-text-muted m-0 pt-[14px]">No bookmarks yet.</p>
                      ) : null}
                    </div>
                    {/* Highlights */}
                    <div className="mt-[22px]">
                      <div className="inline-flex items-center gap-2 mb-[10px] text-text-secondary">
                        <HighlighterIcon size={14} strokeWidth={1.9} aria-hidden="true" />
                        <h3 className="m-0">Highlights</h3>
                      </div>
                      {documentHighlights.map((highlight: Highlight) => (
                        <ContextMenu
                          key={highlight.id}
                          items={[
                            {
                              label: 'Jump to location',
                              onSelect: () => jumpToLocation(highlight.chapterId, highlight.blockId),
                            },
                            { type: 'separator' },
                            {
                              label: 'Remove highlight',
                              destructive: true,
                              onSelect: () => void removeHighlightById(highlight.id),
                            },
                          ]}
                        >
                          <button
                            className={`${listItemBase} ${listItemHover} mt-[10px] first:mt-0 ${activeProgress?.blockId === highlight.blockId ? listItemActive : ''}`}
                            onClick={() => jumpToLocation(highlight.chapterId, highlight.blockId)}
                          >
                            <strong className="block mb-1">{highlight.text}</strong>
                            <span className="text-text-muted">{formatDate(highlight.createdAt)}</span>
                          </button>
                        </ContextMenu>
                      ))}
                      {documentHighlights.length === 0 ? (
                        <p className="text-text-muted m-0 pt-[14px]">Select text to highlight.</p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </aside>

          {/* Reader search overlay */}
          {isReaderSearchOpen ? (
            <ReaderSearchBar
              searchQuery={searchQuery}
              searchResults={searchResults}
              searchResultIndex={searchResultIndex}
              onQueryChange={setSearchQuery}
              onNavigate={(delta) => {
                setSearchResultIndex((i) => {
                  const len = Math.max(1, searchResults.length)
                  return ((i + delta) % len + len) % len
                })
              }}
              onClose={() => { setIsReaderSearchOpen(false); setSearchQuery('') }}
              inputRef={readerSearchRef}
            />
          ) : null}

          {/* Selection popover */}
          {selectionDraft ? (
            <SelectionPopover
              x={selectionDraft.x}
              y={selectionDraft.y}
              onClick={() => void addHighlight()}
            />
          ) : null}

          {/* Reader surface */}
          <div
            ref={readerRef}
            className="overflow-y-auto relative min-h-screen py-6 pb-[88px] max-sm:pt-5"
            onScroll={handleReaderScroll}
            onMouseUp={handleSelectionChange}
            onKeyUp={handleSelectionChange}
          >
            {!isSidebarOpen ? (
              <div className="fixed top-[22px] left-[22px] z-20 flex items-center gap-2 max-sm:top-4 max-sm:left-4">
                <Tooltip content="Back to library" side="right">
                  <Button
                    variant="icon"
                    size="md"
                    className="bg-black/[0.82] backdrop-blur-[12px] border border-border-subtle"
                    onClick={exitReader}
                    aria-label="Back to library"
                  >
                    <ChevronLeftIcon size={17} strokeWidth={1.9} aria-hidden="true" />
                  </Button>
                </Tooltip>
                <Tooltip content="Open sidebar" shortcut="Mod+B" side="right">
                  <Button
                    variant="icon"
                    size="md"
                    className="bg-black/[0.82] backdrop-blur-[12px] border border-border-subtle"
                    onClick={() => setIsSidebarOpen(true)}
                    aria-label="Open sidebar"
                  >
                    <PanelLeftOpenIcon size={17} strokeWidth={1.9} aria-hidden="true" />
                  </Button>
                </Tooltip>
              </div>
            ) : null}
            {/* PDF toolbar */}
            {activeDocument.sourceType === 'pdf' ? (
              <div className="sticky top-0 z-10 flex items-center justify-center gap-1 py-2 px-4 bg-black/80 backdrop-blur-[10px] border-b border-white/[0.07]">
                {/* Zoom out */}
                <button
                  type="button"
                  onClick={() => setPdfZoom((z) => Math.max(50, z - 10))}
                  disabled={pdfZoom <= 50}
                  className="inline-flex items-center justify-center w-8 h-8 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors"
                  aria-label="Zoom out"
                >
                  <ZoomOutIcon size={15} strokeWidth={1.8} />
                </button>
                {/* Zoom value + reset */}
                <button
                  type="button"
                  onClick={() => setPdfZoom(100)}
                  className="min-w-[48px] text-center text-xs text-text-secondary hover:text-text-primary transition-colors tabular-nums"
                  aria-label="Reset zoom"
                >
                  {pdfZoom}%
                </button>
                {/* Zoom in */}
                <button
                  type="button"
                  onClick={() => setPdfZoom((z) => Math.min(200, z + 10))}
                  disabled={pdfZoom >= 200}
                  className="inline-flex items-center justify-center w-8 h-8 text-text-muted hover:text-text-primary disabled:opacity-30 transition-colors"
                  aria-label="Zoom in"
                >
                  <ZoomInIcon size={15} strokeWidth={1.8} />
                </button>

                <div className="w-px h-4 bg-white/[0.12] mx-1" />

                {/* Fit width */}
                <button
                  type="button"
                  onClick={() => setPdfZoom(100)}
                  className="inline-flex items-center justify-center w-8 h-8 text-text-muted hover:text-text-primary transition-colors"
                  aria-label="Fit width"
                  title="Fit width"
                >
                  <FitWidthIcon size={15} strokeWidth={1.8} />
                </button>

                <div className="w-px h-4 bg-white/[0.12] mx-1" />

                {/* Single / two-page toggle */}
                <button
                  type="button"
                  onClick={() => setPdfTwoPage((v) => !v)}
                  className={`inline-flex items-center justify-center w-8 h-8 transition-colors ${pdfTwoPage ? 'text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
                  aria-label={pdfTwoPage ? 'Single page' : 'Two-page spread'}
                  title={pdfTwoPage ? 'Single page' : 'Two-page spread'}
                >
                  {pdfTwoPage ? <LayoutSingleIcon size={15} strokeWidth={1.8} /> : <Columns2Icon size={15} strokeWidth={1.8} />}
                </button>

                <div className="w-px h-4 bg-white/[0.12] mx-1" />

                {/* Dark mode toggle */}
                <button
                  type="button"
                  onClick={() => setPdfDarkMode((v) => !v)}
                  className={`inline-flex items-center justify-center w-8 h-8 transition-colors ${pdfDarkMode ? 'text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
                  aria-label={pdfDarkMode ? 'Light mode' : 'Dark mode'}
                  title={pdfDarkMode ? 'Invert off' : 'Invert colors (dark)'}
                >
                  {pdfDarkMode ? <SunIcon size={15} strokeWidth={1.8} /> : <MoonIcon size={15} strokeWidth={1.8} />}
                </button>
              </div>
            ) : null}


            <div
              className={activeDocument.sourceType === 'pdf'
                ? 'mx-auto pt-4 pb-16 px-4 max-sm:px-2'
                : 'epub-prose w-[min(100%,var(--reader-width,840px))] mx-auto font-reading leading-[1.82] px-10 pt-8 pb-16 max-sm:px-[18px] max-sm:pb-10'}
              style={activeDocument.sourceType === 'pdf'
                ? { width: `${Math.min(pdfZoom, 100)}%`, maxWidth: `${pdfZoom * 10}px` }
                : readerColumnStyle}
            >
              {activeDocument.sourceType === 'pdf' ? (
                // ── PDF: flat page list, optionally paired side-by-side ──────────
                (() => {
                  const allPages = activeDocument.chapters.flatMap((ch) =>
                    ch.content.filter((b) => b.type === 'pdf-page').map((b) => ({ block: b, chapterId: ch.id }))
                  )
                  if (pdfTwoPage) {
                    const pairs: Array<[typeof allPages[0], typeof allPages[0] | null]> = []
                    // First page alone (cover), then pairs
                    if (allPages.length > 0) pairs.push([allPages[0], null])
                    for (let i = 1; i < allPages.length; i += 2) {
                      pairs.push([allPages[i], allPages[i + 1] ?? null])
                    }
                    return pairs.map((pair, idx) => (
                      <div key={idx} className={`flex gap-1 mb-1 ${pair[1] ? 'items-start' : 'justify-center'}`}>
                        <div className={pair[1] ? 'flex-1 min-w-0' : 'w-1/2'}>
                          <PdfPageBlock block={pair[0].block} chapterId={pair[0].chapterId} isDarkMode={pdfDarkMode} />
                        </div>
                        {pair[1] ? (
                          <div className="flex-1 min-w-0">
                            <PdfPageBlock block={pair[1].block} chapterId={pair[1].chapterId} isDarkMode={pdfDarkMode} />
                          </div>
                        ) : null}
                      </div>
                    ))
                  }
                  // Single-page layout with chapter headings
                  return activeDocument.chapters.map((chapter) => (
                    <section key={chapter.id} className="[content-visibility:auto] [contain-intrinsic-size:1200px]">
                      {!isUtilityHeading(chapter.title) && activeDocument.chapters.length > 1 ? (
                        <h2 className="m-0 mb-2 mt-4 text-[0.72rem] font-display font-semibold text-text-muted uppercase tracking-[0.16em]">
                          {chapter.title}
                        </h2>
                      ) : null}
                      <div className="flex flex-col gap-1">
                        {chapter.content.map((block) => (
                          <ReaderBlockView
                            key={block.id}
                            block={block}
                            chapterId={chapter.id}
                            documentId={activeDocument.id}
                            highlights={documentHighlights}
                            searchQuery={isReaderSearchOpen ? searchQuery : ''}
                            activeSearchBlockId={activeSearchBlockId}
                            onPreviewImage={setPreviewImage}
                            pdfDarkMode={pdfDarkMode}
                          />
                        ))}
                      </div>
                    </section>
                  ))
                })()
              ) : (
                // ── Non-PDF: regular block renderer ──────────────────────────────
                activeDocument.chapters.map((chapter) => (
                  <section
                    key={chapter.id}
                    className="[content-visibility:auto] [contain-intrinsic-size:900px] [&+&]:mt-10 [&+&]:pt-10 [&+&]:border-t [&+&]:border-border-subtle"
                  >
                    {!isUtilityHeading(chapter.title) ? (
                      <h2 className="m-0 mb-5 text-[0.78rem] font-display font-semibold text-text-muted uppercase tracking-[0.16em]">
                        {chapter.title}
                      </h2>
                    ) : null}
                    {chapter.content.map((block) => (
                      <ReaderBlockView
                        key={block.id}
                        block={block}
                        chapterId={chapter.id}
                        documentId={activeDocument.id}
                        highlights={documentHighlights}
                        searchQuery={isReaderSearchOpen ? searchQuery : ''}
                        activeSearchBlockId={activeSearchBlockId}
                        onPreviewImage={setPreviewImage}
                      />
                    ))}
                  </section>
                ))
              )}
            </div>
          </div>

          {/* Image lightbox */}
          {previewImage ? (
            <ImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} />
          ) : null}
        </section>
      ) : null}

      {confirmDialog ? (
        <ConfirmDialog dialog={confirmDialog} onDismiss={() => setConfirmDialog(null)} />
      ) : null}

      <Dialog
        open={isUrlDialogOpen}
        onOpenChange={(open) => {
          setIsUrlDialogOpen(open)
          if (!open) {
            setUrlInput('')
          }
        }}
        title="Import from URL"
        description="Paste a blog/article URL. Paper Magic will extract a reader-friendly Markdown version."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void handleUrlImport()
          }}
          className="grid gap-4"
        >
          <Input
            autoFocus
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="https://example.com/article"
          />
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => setIsUrlDialogOpen(false)}
              disabled={isImporting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={isImporting}
            >
              Import URL
            </Button>
          </div>
        </form>
      </Dialog>

      {renameDialog ? (
        <Dialog
          open={!!renameDialog}
          onOpenChange={(open) => { if (!open) setRenameDialog(null) }}
          title="Rename"
          description="Enter a new title for the document."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              const newTitle = formData.get('title') as string
              if (newTitle && newTitle.trim()) {
                handleRenameDocument(renameDialog.document, newTitle)
                setRenameDialog(null)
              }
            }}
            className="grid gap-4"
          >
            <input
              autoFocus
              name="title"
              type="text"
              defaultValue={renameDialog.value}
              className="w-full min-h-12 px-4 border border-border-strong bg-[#040404] text-text-primary font-[inherit] outline-none"
              placeholder="Document title"
            />
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => setRenameDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="md"
              >
                Save
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      <SettingsPage
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        currentDocumentId={mode === 'reader' ? activeDocumentId : null}
      />

    </div>
    </TooltipProvider>
  )
}

export default App
