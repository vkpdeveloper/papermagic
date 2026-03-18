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
  Loader2 as Loader2Icon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Upload as UploadIcon,
  X as XIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { buildSearchResults, buildToc, isUtilityHeading } from './content'
import { defaultPreferences } from './storage'
import type {
  AppMode,
  Bookmark,
  ChapterRefinementUpdate,
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
import { ConfirmDialog } from './components/ConfirmDialog'
import { Dialog } from './components/ui/Dialog'
import { DropOverlay } from './components/DropOverlay'
import { ImageLightbox } from './components/ImageLightbox'
import { SelectionPopover } from './components/SelectionPopover'
import { ReaderSearchBar } from './components/ReaderSearchBar'
import { SettingsPage } from './components/SettingsPage'
import { OllamaOnboarding } from './components/OllamaOnboarding'
import { Button } from './components/ui/Button'
import { Input } from './components/ui/Input'
import { Tooltip, TooltipProvider } from './components/ui/Tooltip'
import { ContextMenu } from './components/ui/ContextMenu'

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

    return <mark key={`${blockId}-${index}`} className="px-[0.14em] py-[0.06em] bg-white/[0.16] text-text-primary">{part}</mark>
  })
}

function sourceLabel(sourceType: DocumentRecord['sourceType']): string {
  switch (sourceType) {
    case 'epub':
      return 'EPUB'
    case 'pdf':
      return 'PDF'
    default:
      return 'URL'
  }
}

function documentAuthorLabel(document: DocumentRecord): string {
  const placeholderAuthors = new Set(['PDF import', 'EPUB import'])
  return placeholderAuthors.has(document.author) ? 'Unknown author' : document.author
}

function SourceIcon(props: {
  sourceType: DocumentRecord['sourceType']
  size?: number
  strokeWidth?: number
}) {
  const { sourceType, size = 16, strokeWidth = 1.8 } = props
  const Icon = sourceType === 'epub' ? BookOpenIcon : FileTextIcon
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
            ? 'bg-[rgba(255,200,60,0.72)] text-[#000] rounded-[2px] px-[0.1em] py-[0.05em]'
            : 'bg-[rgba(255,200,60,0.28)] text-text-primary rounded-[2px] px-[0.1em] py-[0.05em]'
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
}

const sdAllPlugins = { math: sdPlugins.math, code: sdPlugins.code, cjk: sdPlugins.cjk }
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

const ReaderBlockView = memo(function ReaderBlockView(props: {
  block: ReaderBlock
  chapterId: string
  documentId: string
  highlights: Highlight[]
  searchQuery?: string
  activeSearchBlockId?: string
  onPreviewImage?: (image: ImagePreviewState) => void
}) {
  const { block, chapterId, documentId, highlights, searchQuery = '', activeSearchBlockId, onPreviewImage } = props

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
    case 'heading':
      if (isUtilityHeading(block.text ?? '')) {
        return null
      }

      return (
        <h3
          className={`${blockBase} mt-[2.4em] mb-[0.9em] font-display font-semibold leading-[1.18]`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          {hasHighlights || hasSearch ? renderText(block.text ?? '') : <InlineMd text={block.text ?? ''} />}
        </h3>
      )
    case 'quote':
      return (
        <blockquote
          className={`${blockBase} pl-[18px] border-l border-border-strong text-text-secondary`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          {hasHighlights || hasSearch ? renderText(block.text ?? '') : <InlineMd text={block.text ?? ''} />}
        </blockquote>
      )
    case 'list':
      return (
        <ul
          className={`${blockBase} pl-[1.2em]`}
          data-chapter-id={chapterId}
          data-block-id={block.id}
        >
          {(block.items ?? []).map((item, index) => (
            <li key={`${block.id}-${index}`}>
              {hasHighlights || hasSearch ? item : <InlineMd text={item} />}
            </li>
          ))}
        </ul>
      )
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
            className="block w-full p-0 border-0 bg-transparent cursor-zoom-in outline-none"
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
              className="w-full max-h-[min(60vh,520px)] object-contain"
            />
          </button>
          {block.caption ? (
            <figcaption className="mt-2 text-text-muted text-[0.9em]">{block.caption}</figcaption>
          ) : null}
        </figure>
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
          className={blockBase}
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
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<ReaderPanel>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isImporting, setIsImporting] = useState(false)
  const [deletingDocumentIds, setDeletingDocumentIds] = useState<string[]>([])
  const [refiningDocumentIds, setRefiningDocumentIds] = useState<Set<string>>(new Set())
  const [isDragging, setIsDragging] = useState(false)
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
  const [showOnboarding, setShowOnboarding] = useState(false)
  const readerRef = useRef<HTMLDivElement | null>(null)
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
        const [state, refiningIds] = await Promise.all([
          window.paperMagic.loadState(),
          window.paperMagic.getRefiningDocumentIds(),
        ])
        if (cancelled) {
          return
        }

        setPersistedState(state)
        setActiveDocumentId((current) => current ?? state.documents[0]?.id ?? null)
        if (refiningIds.length > 0) {
          setRefiningDocumentIds(new Set(refiningIds))
        }
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

  useEffect(() => {
    setExpandedTocChapters([])
  }, [activeDocumentId])

  // Show onboarding if Ollama setup hasn't run yet
  useEffect(() => {
    void window.paperMagic.getOllamaStatus().then((status) => {
      // If status is checking/installing/pulling, onboarding is in progress
      if (['checking', 'installing', 'pulling', 'starting'].includes(status.status)) {
        setShowOnboarding(true)
      }
    })

    // Also show onboarding if we receive a non-ready/non-idle progress event right after boot
    const unsub = window.paperMagic.onOllamaProgress((progress) => {
      if (['checking', 'installing', 'pulling', 'starting'].includes(progress.status)) {
        setShowOnboarding(true)
      }
    })
    return unsub
  }, [])

  // Track which chapters have been refined mid-session so page-reset effect
  // can skip resetting position when only content changed (not document switch).
  const refinedChapterIdsRef = useRef<Set<string>>(new Set())
  // Track per-document refinement progress: documentId → count of completed chapters
  const docRefinementCountRef = useRef<Map<string, number>>(new Map())

  // Listen for chapter refinement updates and swap content in state
  useEffect(() => {
    const unsub = window.paperMagic.onChapterRefined((update: ChapterRefinementUpdate) => {
      refinedChapterIdsRef.current.add(update.chapterId)

      // Ensure the doc appears as refining (handles rerun case too).
      // If it wasn't already tracked, reset its completion counter (new run).
      setRefiningDocumentIds((prev) => {
        if (prev.has(update.documentId)) return prev
        docRefinementCountRef.current.set(update.documentId, 0)
        const next = new Set(prev)
        next.add(update.documentId)
        return next
      })

      // Track completion to remove doc from refining set when all chapters done
      const prevCount = docRefinementCountRef.current.get(update.documentId) ?? 0
      docRefinementCountRef.current.set(update.documentId, prevCount + 1)

      // Use startTransition so the content swap is low-priority and doesn't
      // interrupt the user's current interaction/scroll.
      startTransition(() => {
        setPersistedState((current) => {
          if (!current) return current
          const updatedDocs = current.documents.map((doc) => {
            if (doc.id !== update.documentId) return doc
            const updatedChapters = doc.chapters.map((ch) =>
              ch.id === update.chapterId ? { ...ch, content: update.refinedContent } : ch
            )
            // Rebuild TOC so navigation reflects refined headings
            return {
              ...doc,
              chapters: updatedChapters,
              toc: buildToc(updatedChapters),
            }
          })

          // Remove from refining set if all chapters for this doc are resolved
          const doc = updatedDocs.find((d) => d.id === update.documentId)
          if (doc) {
            const completedCount = docRefinementCountRef.current.get(update.documentId) ?? 0
            if (completedCount >= doc.chapters.length) {
              docRefinementCountRef.current.delete(update.documentId)
              setRefiningDocumentIds((prev) => {
                const next = new Set(prev)
                next.delete(update.documentId)
                return next
              })
            }
          }

          return { ...current, documents: updatedDocs }
        })
      })
    })
    return unsub
  }, [])

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

    // If the document identity didn't change (only chapter content was refined),
    // skip the position reset so reading position is preserved mid-refinement.
    if (prevDocumentIdRef.current === activeDocument.id && refinedChapterIdsRef.current.size > 0) {
      refinedChapterIdsRef.current.clear()
      return
    }

    prevDocumentIdRef.current = activeDocument.id
    refinedChapterIdsRef.current.clear()
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

  const jumpToLocation = (chapterId: string, blockId: string) => {
    if (!activeDocument) {
      return
    }

    const target = readerRef.current?.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
    if (!target) {
      return
    }

    target.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
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
  }

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
  }, [searchResultIndex, isReaderSearchOpen, searchResults])

  useEffect(() => {
    if (isReaderSearchOpen) {
      setSearchResultIndex(0)
    }
  }, [searchQuery, isReaderSearchOpen])

  const tocGroups = useMemo(() => buildTocGroups(activeDocument), [activeDocument])

  // Shared list-item classes for TOC items, annotation items
  const listItemBase = 'w-full px-[13px] py-3 text-left bg-white/[0.02] border border-border-subtle text-text-primary transition-[border-color,background,transform] duration-[160ms] cursor-pointer border-0 font-[inherit] outline-none'
  const listItemHover = 'hover:border-border-strong hover:bg-white/[0.04]'
  const listItemActive = 'border-border-strong! bg-white/[0.06]'

  if (isBootstrapping) {
    return (
      <div className="min-h-screen text-text-primary bg-bg-page">
        <main className="w-[min(1120px,calc(100vw-48px))] mx-auto py-7 pb-[88px]">
          <section className="border border-border-subtle bg-[#000] p-6">
            <p className="m-0 mb-[10px] uppercase tracking-[0.18em] text-[0.68rem] text-text-muted">Paper Magic</p>
            <h1 className="m-0 max-w-[13ch] text-[clamp(2rem,4.5vw,3.4rem)] font-display font-bold leading-[0.98] tracking-[-0.045em]">
              Loading your offline reading library.
            </h1>
            <p className="max-w-[44ch] mt-[14px] text-text-muted">
              Opening the local database and restoring your reading state.
            </p>
          </section>
        </main>
      </div>
    )
  }

  if (loadError || !persistedState) {
    return (
      <div className="min-h-screen text-text-primary bg-bg-page">
        <main className="w-[min(1120px,calc(100vw-48px))] mx-auto py-7 pb-[88px]">
          <section className="border border-border-subtle bg-[#000] p-6">
            <p className="m-0 mb-[10px] uppercase tracking-[0.18em] text-[0.68rem] text-text-muted">Paper Magic</p>
            <h1 className="m-0 max-w-[13ch] text-[clamp(2rem,4.5vw,3.4rem)] font-display font-bold leading-[0.98] tracking-[-0.045em]">
              Local library unavailable.
            </h1>
            <p className="max-w-[44ch] mt-[14px] text-text-muted">
              {loadError ?? 'The application state could not be initialized.'}
            </p>
          </section>
        </main>
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
        <main className="w-[min(1120px,calc(100vw-48px))] mx-auto pt-7 pb-[88px] max-sm:w-[min(calc(100vw-24px),1120px)] max-sm:pt-5">
          {/* Library header */}
          <section className="flex justify-between items-end gap-[18px] mb-5 max-sm:items-start">
            <div>
              <p className="m-0 mb-[10px] uppercase tracking-[0.18em] text-[0.68rem] text-text-muted">Paper Magic</p>
              <h1 className="m-0 text-[clamp(2rem,5vw,3rem)] font-display font-bold leading-[0.94] tracking-[-0.05em]">
                Library
              </h1>
            </div>
            <Button
              variant="icon"
              size="md"
              className="border border-border-subtle shrink-0"
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              aria-label="Open settings"
            >
              <SettingsIcon size={16} strokeWidth={1.9} />
            </Button>
          </section>

          {/* Import panel */}
          <section className="border border-border-subtle bg-[#000] p-6 mb-6 max-sm:p-[22px]">
            <div className="grid gap-[14px]">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 items-stretch max-sm:grid-cols-1">
                <Button
                  variant="primary"
                  onClick={() => void handleImportDialog()}
                  disabled={isImporting}
                >
                  <UploadIcon size={16} strokeWidth={1.9} aria-hidden="true" />
                  <span>{isImporting ? 'Importing…' : 'Import files'}</span>
                </Button>
              </div>
            </div>
          </section>

          {/* Empty state */}
          {persistedState.documents.length === 0 ? (
            <section className="border border-border-subtle bg-[#000] p-6">
              <div className="flex justify-between gap-4 items-baseline mb-3">
                <h2 className="m-0 text-base font-display font-semibold">Empty library</h2>
                <span className="text-text-muted text-[0.95rem]">Start with one import</span>
              </div>
              <p className="max-w-[44ch] text-text-muted">Drop a PDF or EPUB.</p>
            </section>
          ) : null}

          {/* Library section */}
          {libraryDocuments.length > 0 ? (
            <section className="mt-[18px]">
              <div className="flex justify-between gap-4 items-baseline mb-3 max-sm:flex-col max-sm:items-stretch">
                <div className="grid gap-1">
                  <h2 className="m-0 text-base font-display font-semibold">Library</h2>
                  <span className="text-text-muted text-[0.95rem]">{filteredLibraryDocuments.length} items</span>
                </div>
                <Input
                  ref={librarySearchRef}
                  size="md"
                  prefix={<SearchIcon size={15} strokeWidth={1.9} aria-hidden="true" />}
                  wrapperClassName="w-[min(100%,320px)] max-sm:w-full"
                  value={librarySearchQuery}
                  onChange={(event) => setLibrarySearchQuery(event.target.value)}
                  placeholder="Search title, author, or source"
                />
              </div>
              {filteredLibraryDocuments.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 max-sm:grid-cols-2">
                  {filteredLibraryDocuments.map((document) => {
                    const progress = persistedState.progress.find((item) => item.documentId === document.id)
                    const coverImageUrl = resolveDocumentCoverImage(document)
                    const progressValue = progress?.progress ?? 0
                    const progressWidth = `${Math.max(0, Math.min(100, progressValue * 100))}%`
                    const isDeletingDocument = deletingDocumentIds.includes(document.id)
                    const isRefining = refiningDocumentIds.has(document.id)
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
                        className={`border border-border-subtle bg-[#000] grid grid-rows-[auto_minmax(0,1fr)] gap-[14px] min-h-[420px] h-full p-3 text-left transition-[border-color,background] duration-[160ms] cursor-pointer hover:border-border-strong hover:bg-[#050505] ${isDeletingDocument ? 'opacity-70 pointer-events-none' : ''}`}
                        onClick={() => {
                          if (!isDeletingDocument) {
                            openDocument(document.id)
                          }
                        }}
                      >
                        {/* Cover art */}
                        <div
                          className={`relative min-h-0 aspect-[0.76] p-[14px] border border-white/[0.06] flex flex-col justify-between overflow-hidden ${coverImageUrl ? '' : ''}`}
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
                              <div className="absolute inset-0 bg-gradient-to-b from-black/[0.12] via-black/[0.2] to-black/[0.9]" />
                            </>
                          ) : null}
                          <span className="relative z-[1] inline-flex self-start items-center gap-1.5 px-2 py-[5px] border border-white/[0.12] bg-black/40 text-white/[0.82] text-[0.72rem] tracking-[0.08em] uppercase">
                            <SourceIcon sourceType={document.sourceType} size={14} strokeWidth={1.9} />
                            {sourceLabel(document.sourceType)}
                          </span>
                          {isRefining ? (
                            <span className="relative z-[1] inline-flex self-end items-center gap-1.5 px-2 py-[5px] border border-white/[0.12] bg-black/60 text-white/[0.7] text-[0.68rem] tracking-[0.06em] uppercase">
                              <Loader2Icon size={11} strokeWidth={2} className="animate-spin" />
                              Refining
                            </span>
                          ) : null}
                        </div>
                        {/* Document meta */}
                        <div className="min-w-0 flex flex-col gap-[10px]">
                          <div className="flex items-start justify-between gap-[10px]">
                            <p className="m-0 text-text-muted text-[0.72rem] tracking-[0.16em] uppercase">
                              {documentAuthorLabel(document)}
                            </p>
                          </div>
                          <h3 className="m-0 min-w-0 overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:3] [display:-webkit-box] text-[1.08rem] font-display font-semibold leading-[1.08] tracking-[-0.03em]">
                            {document.title}
                          </h3>
                          <div className="mt-auto pt-3 border-t border-border-subtle flex items-center justify-between gap-3 text-text-muted text-[0.72rem] tracking-[0.16em] uppercase">
                            <span>Progress</span>
                            <strong className="text-text-primary text-[0.95rem] font-display font-semibold tracking-[-0.02em] normal-case">
                              {progress ? formatPercent(progressValue) : 'Not started'}
                            </strong>
                          </div>
                          <div className="h-1.5 bg-white/[0.08] overflow-hidden" aria-hidden="true">
                            <div className="h-full bg-text-primary" style={{ width: progressWidth }} />
                          </div>
                        </div>
                      </article>
                      </ContextMenu>
                    )
                  })}
                </div>
              ) : (
                <p className="text-text-muted pt-2">No library items match that search.</p>
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
            className={`sticky top-0 h-screen overflow-y-auto border-r border-border-subtle bg-[#000] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden transition-[transform,opacity,border-color] duration-[180ms] max-sm:fixed max-sm:top-0 max-sm:left-0 max-sm:bottom-0 max-sm:w-screen max-sm:h-screen max-sm:z-30 ${
              isSidebarOpen
                ? 'max-sm:translate-x-0 max-sm:pointer-events-auto'
                : 'translate-x-[-100%] opacity-0 pointer-events-none border-transparent max-sm:opacity-100 max-sm:border-border-subtle'
            }`}
          >
            <div className="min-h-full flex flex-col">
              {/* Sidebar top */}
              <div className="px-[18px] pt-[18px] pb-[18px] border-b border-border-subtle">
                <div className="mb-[18px] flex items-center justify-between gap-[10px]">
                  <Button
                    variant="ghost"
                    onClick={exitReader}
                  >
                    <ChevronLeftIcon size={16} strokeWidth={1.9} aria-hidden="true" />
                    <span>Library</span>
                  </Button>
                  <div className="inline-flex items-center gap-[10px]">
                    <Tooltip content="Collapse sidebar" shortcut="Mod+B" side="bottom">
                      <Button
                        variant="icon"
                        size="md"
                        className="border border-border-subtle"
                        onClick={() => setIsSidebarOpen(false)}
                        aria-label="Collapse sidebar"
                      >
                        <PanelLeftCloseIcon size={16} strokeWidth={1.9} aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
                <p className="m-0 mb-[10px] uppercase tracking-[0.18em] text-[0.68rem] text-text-muted inline-flex items-center gap-1.5">
                  <SourceIcon sourceType={activeDocument.sourceType} size={13} strokeWidth={1.9} />
                  {sourceLabel(activeDocument.sourceType)}
                </p>
                <h1 className="m-0 text-[1.65rem] font-display font-bold leading-[1.02] tracking-[-0.04em]">
                  {activeDocument.title}
                </h1>
                <p className="mt-2 text-text-muted font-ui text-[0.88rem] tracking-[0.03em]">
                  {activeDocument.author}
                </p>
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
                <div className="flex items-center px-[18px] pb-[18px] pt-3 border-b border-border-subtle">
                  <span className="text-text-muted text-[0.88rem] tracking-[0.03em] tabular-nums">
                    {formatPercent(activeProgress?.progress ?? 0)}
                  </span>
                </div>

                {/* TOC panel */}
                {visibleReaderPanel === 'toc' ? (
                  <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-[18px] py-5">
                    <div className="flex justify-between items-center gap-3 mb-4">
                      <div className="grid gap-1">
                        <span className="inline-flex items-center gap-1.5 text-text-muted text-[0.72rem] tracking-[0.12em] uppercase">
                          <ListIcon size={14} strokeWidth={1.9} aria-hidden="true" />
                          Contents
                        </span>
                        <h2 className="m-0 text-base font-display font-semibold tracking-[-0.03em]">
                          Navigate the document
                        </h2>
                      </div>
                    </div>
                    <div className="grid gap-2">
                      {tocGroups.map((group) => {
                        const isExpanded = expandedTocChapters.includes(group.chapterId)
                        const isActiveChapter =
                          activeProgress?.chapterId === group.chapterId ||
                          group.items.some((item) => item.blockId === activeProgress?.blockId)

                        return (
                          <section key={group.chapterId} className="grid gap-2">
                            <button
                              className={`w-full px-[13px] py-3 flex items-center gap-[10px] border border-border-subtle bg-white/[0.02] text-text-primary text-left transition-[border-color,background] duration-[160ms] cursor-pointer font-[inherit] outline-none hover:border-border-strong hover:bg-white/[0.04] overflow-hidden ${isActiveChapter || isExpanded ? 'border-border-strong bg-white/[0.06]' : ''}`}
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
                              <span className="min-w-0 inline-flex items-center gap-[10px] overflow-hidden">
                                <ChevronRightIcon
                                  className={`shrink-0 transition-transform duration-[160ms] ${isExpanded ? 'rotate-90' : ''}`}
                                  size={15}
                                  strokeWidth={1.9}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 truncate">{group.title}</span>
                              </span>
                            </button>
                            {isExpanded ? (
                              <div className="grid gap-2 ml-3 pl-3 border-l border-border-subtle">
                                {group.items.map((item) => (
                                  <button
                                    key={item.id}
                                    className={`${listItemBase} ${listItemHover} flex items-center gap-[10px] ${item.level === 2 ? 'pl-3' : item.level === 3 ? 'pl-[18px]' : ''} ${activeProgress?.blockId === item.blockId ? listItemActive : ''}`}
                                    onClick={() => jumpToLocation(item.chapterId, item.blockId)}
                                  >
                                    <span className="min-w-0 inline-flex items-center gap-[9px] overflow-hidden">
                                      <ListIcon size={13} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
                                      <span className="min-w-0 truncate">{item.title}</span>
                                    </span>
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
                  <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-[18px] py-5">
                    <div className="flex justify-between items-center gap-3 mb-4">
                      <div className="grid gap-1">
                        <span className="inline-flex items-center gap-1.5 text-text-muted text-[0.72rem] tracking-[0.12em] uppercase">
                          <NotebookPenIcon size={14} strokeWidth={1.9} aria-hidden="true" />
                          Notes
                        </span>
                        <h2 className="m-0 text-base font-display font-semibold tracking-[-0.03em]">
                          Bookmarks and highlights
                        </h2>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setActivePanel('toc')}
                      >
                        <XIcon size={15} strokeWidth={1.9} aria-hidden="true" />
                        Done
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
              <Tooltip content="Open sidebar" shortcut="Mod+B" side="right">
                <Button
                  variant="icon"
                  size="md"
                  className="fixed top-[22px] left-[22px] z-20 bg-black/[0.82] backdrop-blur-[12px] border border-border-subtle max-sm:top-4 max-sm:left-4"
                  onClick={() => setIsSidebarOpen(true)}
                  aria-label="Open sidebar"
                >
                  <PanelLeftOpenIcon size={17} strokeWidth={1.9} aria-hidden="true" />
                </Button>
              </Tooltip>
            ) : null}
            <div
              className="w-[min(100%,var(--reader-width,840px))] mx-auto font-reading leading-[1.78] px-10 pt-8 pb-12 max-sm:px-[18px] max-sm:pb-10"
              style={readerColumnStyle}
            >
              {activeDocument.chapters.map((chapter) => (
                <section
                  key={chapter.id}
                  className="[content-visibility:auto] [contain-intrinsic-size:900px] [&+&]:mt-14"
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
              ))}
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

      {showOnboarding && (
        <OllamaOnboarding onComplete={() => setShowOnboarding(false)} />
      )}
    </div>
    </TooltipProvider>
  )
}

export default App
