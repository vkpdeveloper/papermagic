import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { buildSearchResults, flattenDocument } from './content'
import { defaultPreferences } from './storage'
import type {
  AppMode,
  Bookmark,
  DocumentRecord,
  FlatBlock,
  Highlight,
  PersistedState,
  ReaderBlock,
  ReadingMode,
  ReadingProgress,
  SearchResult,
} from './types'

type ReaderPanel = 'toc' | 'search' | 'notes' | null

interface SelectionDraft {
  chapterId: string
  blockId: string
  text: string
  x: number
  y: number
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

function coverStyle(document: DocumentRecord): React.CSSProperties {
  return {
    background: `linear-gradient(145deg, hsl(${document.coverHue} 50% 18%), hsl(${(document.coverHue + 26) % 360} 44% 10%))`,
    boxShadow: `inset 0 1px 0 hsla(${document.coverHue} 85% 80% / 0.14)`,
  }
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

    return <mark key={`${blockId}-${index}`}>{part}</mark>
  })
}

function buildPages(flatBlocks: FlatBlock[]) {
  const pages: FlatBlock[][] = []
  let currentPage: FlatBlock[] = []
  let weight = 0

  const blockWeight = (block: ReaderBlock) => {
    switch (block.type) {
      case 'heading':
        return 1
      case 'list':
        return 2
      case 'code':
        return 3
      case 'quote':
        return 2
      case 'image':
        return 4
      default:
        return 2
    }
  }

  flatBlocks.forEach((flatBlock) => {
    const nextWeight = blockWeight(flatBlock.block)
    if (currentPage.length > 0 && weight + nextWeight > 9) {
      pages.push(currentPage)
      currentPage = []
      weight = 0
    }

    currentPage.push(flatBlock)
    weight += nextWeight
  })

  if (currentPage.length > 0) {
    pages.push(currentPage)
  }

  return pages
}

function sourceLabel(sourceType: DocumentRecord['sourceType']): string {
  switch (sourceType) {
    case 'epub':
      return 'Book'
    case 'pdf':
      return 'Article'
    default:
      return 'Web'
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

function ReaderBlockView(props: {
  block: ReaderBlock
  chapterId: string
  documentId: string
  highlights: Highlight[]
}) {
  const { block, chapterId, documentId, highlights } = props

  switch (block.type) {
    case 'heading':
      return (
        <h3 className="reader-block type-heading" data-chapter-id={chapterId} data-block-id={block.id}>
          {block.text}
        </h3>
      )
    case 'quote':
      return (
        <blockquote className="reader-block type-quote" data-chapter-id={chapterId} data-block-id={block.id}>
          {renderWithHighlights(block.text ?? '', highlights, documentId, block.id)}
        </blockquote>
      )
    case 'list':
      return (
        <ul className="reader-block type-list" data-chapter-id={chapterId} data-block-id={block.id}>
          {(block.items ?? []).map((item, index) => (
            <li key={`${block.id}-${index}`}>{item}</li>
          ))}
        </ul>
      )
    case 'code':
      return (
        <pre className="reader-block type-code" data-chapter-id={chapterId} data-block-id={block.id}>
          <code>{block.text}</code>
        </pre>
      )
    case 'image':
      return (
        <figure className="reader-block type-image" data-chapter-id={chapterId} data-block-id={block.id}>
          <img loading="lazy" src={block.src} alt={block.alt ?? block.caption ?? 'Imported image'} />
          {block.caption ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      )
    default:
      return (
        <p className="reader-block type-paragraph" data-chapter-id={chapterId} data-block-id={block.id}>
          {renderWithHighlights(block.text ?? '', highlights, documentId, block.id)}
        </p>
      )
  }
}

function App() {
  const [persistedState, setPersistedState] = useState<PersistedState | null>(null)
  const [mode, setMode] = useState<AppMode>('library')
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [activePanel, setActivePanel] = useState<ReaderPanel>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [urlInput, setUrlInput] = useState('')
  const [importMessage, setImportMessage] = useState('Import a PDF, EPUB, or URL to build the local library.')
  const [isImporting, setIsImporting] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const readerRef = useRef<HTMLDivElement | null>(null)
  const hideControlsTimerRef = useRef<number | null>(null)
  const progressSaveTimerRef = useRef<number | null>(null)
  const preferenceSaveTimerRef = useRef<number | null>(null)
  const latestProgressRef = useRef<ReadingProgress | null>(null)
  const latestPreferencesRef = useRef(defaultPreferences)

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
      if (hideControlsTimerRef.current) {
        window.clearTimeout(hideControlsTimerRef.current)
      }
      if (progressSaveTimerRef.current) {
        window.clearTimeout(progressSaveTimerRef.current)
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

  const queueProgressSave = (progress: ReadingProgress) => {
    latestProgressRef.current = progress

    setPersistedState((currentState) => {
      if (!currentState) {
        return currentState
      }

      return {
        ...currentState,
        progress: upsertProgress(currentState.progress, progress),
      }
    })

    if (progressSaveTimerRef.current) {
      window.clearTimeout(progressSaveTimerRef.current)
    }

    progressSaveTimerRef.current = window.setTimeout(() => {
      const latestProgress = latestProgressRef.current
      if (latestProgress) {
        void window.paperMagic.saveProgress(latestProgress)
      }
    }, 180)
  }

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
      setImportMessage(message)
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
    setImportMessage(message)
  }

  const activeDocument =
    persistedState?.documents.find((document) => document.id === activeDocumentId) ?? null
  const activeProgress =
    activeDocument && persistedState
      ? persistedState.progress.find((progress) => progress.documentId === activeDocument.id) ?? null
      : null
  const activeReadingMode: ReadingMode =
    activeProgress?.readingMode ?? activeDocument?.preferredMode ?? 'scroll'
  const flatBlocks = useMemo(() => (activeDocument ? flattenDocument(activeDocument) : []), [activeDocument])
  const pages = useMemo(() => buildPages(flatBlocks), [flatBlocks])
  const documentHighlights =
    activeDocument && persistedState
      ? persistedState.highlights.filter((highlight) => highlight.documentId === activeDocument.id)
      : []
  const documentBookmarks =
    activeDocument && persistedState
      ? persistedState.bookmarks.filter((bookmark) => bookmark.documentId === activeDocument.id)
      : []
  const searchResults = useMemo(
    () => (activeDocument ? buildSearchResults(activeDocument, searchQuery) : []),
    [activeDocument, searchQuery],
  )

  useEffect(() => {
    if (!activeDocument) {
      return
    }

    if (activeReadingMode === 'page') {
      setPageIndex(activeProgress?.pageIndex ?? 0)
      return
    }

    setPageIndex(0)
  }, [activeDocument, activeProgress?.pageIndex, activeReadingMode])

  useEffect(() => {
    if (mode !== 'reader') {
      return
    }

    const showControls = () => {
      setControlsVisible(true)
      if (hideControlsTimerRef.current) {
        window.clearTimeout(hideControlsTimerRef.current)
      }
      hideControlsTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false)
      }, 2200)
    }

    const handleKeyboard = (event: KeyboardEvent) => {
      showControls()

      if (!activeDocument) {
        return
      }

      const metaKeyPressed = event.metaKey || event.ctrlKey

      if (metaKeyPressed && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setActivePanel('search')
        return
      }

      if (metaKeyPressed && event.key.toLowerCase() === 't') {
        event.preventDefault()
        setActivePanel((currentPanel) => (currentPanel === 'toc' ? null : 'toc'))
        return
      }

      if (event.key === 'Escape') {
        setActivePanel(null)
        setSelectionDraft(null)
        return
      }

      if (event.key.toLowerCase() === 'j' && readerRef.current) {
        readerRef.current.scrollBy({ top: 160, behavior: 'smooth' })
        return
      }

      if (event.key.toLowerCase() === 'k' && readerRef.current) {
        readerRef.current.scrollBy({ top: -160, behavior: 'smooth' })
        return
      }

      if (event.key === ' ' && activeReadingMode === 'page') {
        event.preventDefault()
        setPageIndex((current) => clamp(current + 1, 0, Math.max(0, pages.length - 1)))
      }
    }

    showControls()
    window.addEventListener('mousemove', showControls)
    window.addEventListener('touchstart', showControls)
    window.addEventListener('keydown', handleKeyboard)

    return () => {
      window.removeEventListener('mousemove', showControls)
      window.removeEventListener('touchstart', showControls)
      window.removeEventListener('keydown', handleKeyboard)
      if (hideControlsTimerRef.current) {
        window.clearTimeout(hideControlsTimerRef.current)
      }
    }
  }, [activeDocument, activeReadingMode, mode, pages.length])

  useEffect(() => {
    if (!activeDocument || activeReadingMode !== 'page') {
      return
    }

    const block = pages[pageIndex]?.[0]

    if (!block) {
      return
    }

    queueProgressSave({
      documentId: activeDocument.id,
      progress: pages.length <= 1 ? 1 : pageIndex / (pages.length - 1),
      chapterId: block.chapterId,
      blockId: block.block.id,
      pageIndex,
      readingMode: 'page',
      lastOpenedAt: new Date().toISOString(),
    })
  }, [activeDocument, activeReadingMode, pageIndex, pages])

  useEffect(() => {
    if (!activeDocument || mode !== 'reader' || activeReadingMode !== 'scroll') {
      return
    }

    const targetBlockId = activeProgress?.blockId
    if (!targetBlockId) {
      return
    }

    const timer = window.setTimeout(() => {
      const target = readerRef.current?.querySelector<HTMLElement>(`[data-block-id="${targetBlockId}"]`)
      target?.scrollIntoView({ block: 'start' })
    }, 60)

    return () => {
      window.clearTimeout(timer)
    }
  }, [activeDocument?.id, activeProgress?.blockId, activeReadingMode, mode])

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
    setActivePanel(null)
    setSearchQuery('')
    setSelectionDraft(null)

    const existingProgress = persistedState.progress.find((progress) => progress.documentId === documentId)
    const fallbackBlock = document.chapters[0]?.content[0]
    const fallbackChapter = document.chapters[0]

    if (fallbackBlock && fallbackChapter) {
      queueProgressSave({
        documentId,
        progress: existingProgress?.progress ?? 0,
        chapterId: existingProgress?.chapterId ?? fallbackChapter.id,
        blockId: existingProgress?.blockId ?? fallbackBlock.id,
        pageIndex: existingProgress?.pageIndex ?? 0,
        readingMode: existingProgress?.readingMode ?? document.preferredMode,
        lastOpenedAt: new Date().toISOString(),
      })
    }
  }

  const exitReader = () => {
    setMode('library')
    setActivePanel(null)
    setSelectionDraft(null)
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
      setImportMessage(error instanceof Error ? error.message : 'The selected files could not be imported.')
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
      setImportMessage('Dropped files could not be resolved into local paths.')
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
      setImportMessage(error instanceof Error ? error.message : 'The dropped files could not be imported.')
    } finally {
      setIsImporting(false)
    }
  }

  const importUrlValue = async (url: string) => {
    if (!url.trim()) {
      return
    }

    setIsImporting(true)

    try {
      const document = await window.paperMagic.importUrl(url.trim())
      mergeImportedDocuments([document], `Saved ${document.title} to the local library.`)
      setUrlInput('')
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'The URL could not be imported in this environment.')
    } finally {
      setIsImporting(false)
    }
  }

  const handleReaderScroll = () => {
    if (!readerRef.current || !activeDocument || activeReadingMode !== 'scroll') {
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

    if (activeReadingMode === 'page') {
      const nextPageIndex = pages.findIndex((page) => page.some((entry) => entry.block.id === blockId))
      if (nextPageIndex >= 0) {
        setPageIndex(nextPageIndex)
      }
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

  const toggleReadingMode = () => {
    if (!activeDocument) {
      return
    }

    const nextMode: ReadingMode = activeReadingMode === 'scroll' ? 'page' : 'scroll'
    const fallbackBlock = activeDocument.chapters[0]?.content[0]
    const fallbackChapter = activeDocument.chapters[0]

    if (!fallbackBlock || !fallbackChapter) {
      return
    }

    queueProgressSave({
      documentId: activeDocument.id,
      progress: activeProgress?.progress ?? 0,
      chapterId: activeProgress?.chapterId ?? fallbackChapter.id,
      blockId: activeProgress?.blockId ?? fallbackBlock.id,
      pageIndex: activeProgress?.pageIndex ?? 0,
      readingMode: nextMode,
      lastOpenedAt: new Date().toISOString(),
    })
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

  const sections = useMemo(() => {
    if (!persistedState) {
      return []
    }

    return [
      {
        title: 'Recently Read',
        documents: [...persistedState.documents]
          .sort((left, right) => {
            const leftProgress = persistedState.progress.find((progress) => progress.documentId === left.id)
            const rightProgress = persistedState.progress.find((progress) => progress.documentId === right.id)
            return (
              new Date(rightProgress?.lastOpenedAt ?? 0).getTime() -
              new Date(leftProgress?.lastOpenedAt ?? 0).getTime()
            )
          })
          .slice(0, 4),
      },
      {
        title: 'Books',
        documents: persistedState.documents.filter((document) => document.sourceType === 'epub'),
      },
      {
        title: 'Articles',
        documents: persistedState.documents.filter((document) => document.sourceType === 'pdf'),
      },
      {
        title: 'Saved Web Pages',
        documents: persistedState.documents.filter((document) => document.sourceType === 'web'),
      },
    ]
  }, [persistedState])

  if (isBootstrapping) {
    return (
      <div className="app-shell">
        <main className="library-shell">
          <section className="hero-panel">
            <div className="hero-copy">
              <p className="eyebrow">Paper Magic</p>
              <h1>Loading your offline reading library.</h1>
              <p className="hero-description">
                Opening the local database, restoring progress, and preparing the shared reading surface.
              </p>
            </div>
          </section>
        </main>
      </div>
    )
  }

  if (loadError || !persistedState) {
    return (
      <div className="app-shell">
        <main className="library-shell">
          <section className="hero-panel">
            <div className="hero-copy">
              <p className="eyebrow">Paper Magic</p>
              <h1>Local library unavailable.</h1>
              <p className="hero-description">{loadError ?? 'The application state could not be initialized.'}</p>
            </div>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div
      className={`app-shell ${mode === 'reader' ? 'reader-open' : ''}`}
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
          return
        }

        const droppedUrl = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
        if (droppedUrl) {
          void importUrlValue(droppedUrl)
        }
      }}
    >
      {isDragging ? (
        <div className="drop-overlay">
          <div className="drop-card">
            <span>Drop files to import into Paper Magic</span>
            <p>PDF, EPUB, HTML, Markdown, and text files are normalized into the same reading surface.</p>
          </div>
        </div>
      ) : null}

      {mode === 'library' ? (
        <main className="library-shell">
          <section className="hero-panel">
            <div className="hero-copy">
              <p className="eyebrow">Paper Magic</p>
              <h1>One dark reading surface for PDFs, EPUBs, and saved web pages.</h1>
              <p className="hero-description">
                The app normalizes every source into the same local-first document model, stores it in SQLite,
                and keeps the reader consistent even when the input format changes.
              </p>
              <div className="hero-metrics">
                <div>
                  <strong>{persistedState.documents.length}</strong>
                  <span>Documents</span>
                </div>
                <div>
                  <strong>{persistedState.bookmarks.length}</strong>
                  <span>Bookmarks</span>
                </div>
                <div>
                  <strong>{persistedState.highlights.length}</strong>
                  <span>Highlights</span>
                </div>
              </div>
            </div>
            <div className="pipeline-panel">
              <p className="pipeline-label">Normalization pipeline</p>
              <div className="pipeline-flow">
                <span>Source</span>
                <span>Extraction</span>
                <span>Unified document</span>
                <span>Reader</span>
              </div>
              <p className="pipeline-note">{importMessage}</p>
            </div>
          </section>

          <section className="import-panel">
            <div className="import-actions">
              <button className="primary-button" onClick={() => void handleImportDialog()} disabled={isImporting}>
                {isImporting ? 'Importing…' : 'Import files'}
              </button>
              <div className="url-import">
                <input
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="Paste a URL to save a readable article"
                />
                <button
                  className="secondary-button"
                  onClick={() => void importUrlValue(urlInput)}
                  disabled={isImporting}
                >
                  {isImporting ? 'Importing…' : 'Save URL'}
                </button>
              </div>
            </div>
            <p className="import-caption">
              Drag and drop anywhere in the library. URL imports use the Summarize CLI extraction pipeline and cache
              the normalized result locally for offline reading.
            </p>
          </section>

          {persistedState.documents.length === 0 ? (
            <section className="import-panel">
              <div className="section-heading">
                <h2>Empty Library</h2>
                <span>Start with one import</span>
              </div>
              <p className="hero-description">
                PDFs are reconstructed into semantic reading blocks, EPUBs are parsed into chapters, and web pages
                are extracted into Markdown before they ever reach the reader.
              </p>
            </section>
          ) : null}

          {sections
            .filter((section) => section.documents.length > 0)
            .map((section) => (
              <section key={section.title} className="library-section">
                <div className="section-heading">
                  <h2>{section.title}</h2>
                  <span>{section.documents.length} items</span>
                </div>
                <div className="document-grid">
                  {section.documents.map((document) => {
                    const progress = persistedState.progress.find((item) => item.documentId === document.id)
                    return (
                      <article
                        key={`${section.title}-${document.id}`}
                        className="document-card"
                        onClick={() => openDocument(document.id)}
                      >
                        <div className="cover-art" style={coverStyle(document)}>
                          <span className="cover-type">{sourceLabel(document.sourceType)}</span>
                          <strong>{document.title}</strong>
                          <small>{document.author}</small>
                        </div>
                        <div className="document-meta">
                          <div className="document-title-row">
                            <h3>{document.title}</h3>
                            <span>{document.metadata.estimatedMinutes} min</span>
                          </div>
                          <p>{document.description}</p>
                          <div className="document-footer">
                            <span>{document.author}</span>
                            <span>{progress ? formatPercent(progress.progress) : 'New'}</span>
                          </div>
                          <div className="progress-track">
                            <div
                              className="progress-fill"
                              style={{ width: `${Math.max(6, (progress?.progress ?? 0) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            ))}
        </main>
      ) : null}

      {mode === 'reader' && activeDocument ? (
        <section className="reader-shell">
          <aside className={`reader-sidebar ${activePanel ? 'visible' : ''}`}>
            {activePanel === 'toc' ? (
              <div className="panel-content">
                <div className="panel-header">
                  <h2>Contents</h2>
                  <button onClick={() => setActivePanel(null)}>Close</button>
                </div>
                {activeDocument.toc.map((item) => (
                  <button
                    key={item.id}
                    className={`toc-item toc-level-${item.level}`}
                    onClick={() => jumpToLocation(item.chapterId, item.blockId)}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            ) : null}

            {activePanel === 'search' ? (
              <div className="panel-content">
                <div className="panel-header">
                  <h2>Search</h2>
                  <button onClick={() => setActivePanel(null)}>Close</button>
                </div>
                <input
                  className="panel-input"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search the current document"
                />
                <div className="result-list">
                  {searchResults.map((result: SearchResult) => (
                    <button
                      key={result.id}
                      className="search-result"
                      onClick={() => jumpToLocation(result.chapterId, result.blockId)}
                    >
                      <strong>{result.chapterTitle}</strong>
                      <span>{result.context}</span>
                    </button>
                  ))}
                  {searchQuery && searchResults.length === 0 ? (
                    <p className="empty-state">No matches in this document.</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activePanel === 'notes' ? (
              <div className="panel-content">
                <div className="panel-header">
                  <h2>Annotations</h2>
                  <button onClick={() => setActivePanel(null)}>Close</button>
                </div>
                <div className="annotation-group">
                  <h3>Bookmarks</h3>
                  {documentBookmarks.map((bookmark: Bookmark) => (
                    <button
                      key={bookmark.id}
                      className="annotation-item"
                      onClick={() => jumpToLocation(bookmark.chapterId, bookmark.blockId)}
                    >
                      <strong>{bookmark.label}</strong>
                      <span>{formatDate(bookmark.createdAt)}</span>
                    </button>
                  ))}
                  {documentBookmarks.length === 0 ? <p className="empty-state">No bookmarks yet.</p> : null}
                </div>
                <div className="annotation-group">
                  <h3>Highlights</h3>
                  {documentHighlights.map((highlight: Highlight) => (
                    <button
                      key={highlight.id}
                      className="annotation-item"
                      onClick={() => jumpToLocation(highlight.chapterId, highlight.blockId)}
                    >
                      <strong>{highlight.text}</strong>
                      <span>{formatDate(highlight.createdAt)}</span>
                    </button>
                  ))}
                  {documentHighlights.length === 0 ? <p className="empty-state">Select text to highlight.</p> : null}
                </div>
              </div>
            ) : null}
          </aside>

          <div className={`reader-controls ${controlsVisible ? 'visible' : ''}`}>
            <div className="reader-topbar">
              <button className="secondary-button" onClick={exitReader}>
                Library
              </button>
              <div className="reader-title">
                <strong>{activeDocument.title}</strong>
                <span>
                  {activeDocument.author} · {formatPercent(activeProgress?.progress ?? 0)}
                </span>
              </div>
              <div className="reader-actions">
                <button className="ghost-button" onClick={() => setActivePanel(activePanel === 'toc' ? null : 'toc')}>
                  TOC
                </button>
                <button
                  className="ghost-button"
                  onClick={() => setActivePanel(activePanel === 'search' ? null : 'search')}
                >
                  Search
                </button>
                <button
                  className="ghost-button"
                  onClick={() => setActivePanel(activePanel === 'notes' ? null : 'notes')}
                >
                  Notes
                </button>
              </div>
            </div>
            <div className="reader-bottombar">
              <button className="ghost-button" onClick={toggleReadingMode}>
                {activeReadingMode === 'scroll' ? 'Switch to page mode' : 'Switch to scroll mode'}
              </button>
              <button className="ghost-button" onClick={() => void addBookmark()}>
                Add bookmark
              </button>
              <label>
                Font
                <input
                  type="range"
                  min="16"
                  max="24"
                  value={persistedState.preferences.fontSize}
                  onChange={(event) =>
                    queuePreferenceSave({
                      ...persistedState.preferences,
                      fontSize: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Width
                <input
                  type="range"
                  min="680"
                  max="820"
                  value={persistedState.preferences.readingWidth}
                  onChange={(event) =>
                    queuePreferenceSave({
                      ...persistedState.preferences,
                      readingWidth: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </div>

          {selectionDraft ? (
            <button
              className="selection-popover"
              style={{
                left: selectionDraft.x,
                top: selectionDraft.y,
              }}
              onClick={() => void addHighlight()}
            >
              Highlight
            </button>
          ) : null}

          <div
            ref={readerRef}
            className={`reader-surface mode-${activeReadingMode}`}
            onScroll={handleReaderScroll}
            onMouseUp={handleSelectionChange}
            onKeyUp={handleSelectionChange}
          >
            <div
              className="reader-column"
              style={{
                maxWidth: `${clamp(
                  persistedState.preferences.readingWidth,
                  defaultPreferences.readingWidth,
                  defaultPreferences.readingWidth + 100,
                )}px`,
                fontSize: `${persistedState.preferences.fontSize}px`,
              }}
            >
              <header className="document-header">
                <p className="eyebrow">{sourceLabel(activeDocument.sourceType)}</p>
                <h1>{activeDocument.title}</h1>
                <p>{activeDocument.description}</p>
                <div className="document-tags">
                  <span>{activeDocument.author}</span>
                  <span>{activeDocument.metadata.estimatedMinutes} min</span>
                  <span>{activeDocument.metadata.extractedWith}</span>
                </div>
                {activeDocument.metadata.note ? <p className="document-note">{activeDocument.metadata.note}</p> : null}
              </header>

              {activeReadingMode === 'scroll'
                ? activeDocument.chapters.map((chapter) => (
                    <section key={chapter.id} className="chapter-block">
                      <h2>{chapter.title}</h2>
                      {chapter.content.map((block) => (
                        <ReaderBlockView
                          key={block.id}
                          block={block}
                          chapterId={chapter.id}
                          documentId={activeDocument.id}
                          highlights={documentHighlights}
                        />
                      ))}
                    </section>
                  ))
                : (
                    <div className="page-mode">
                      <article className="page-card">
                        {pages[pageIndex]?.map((entry) => (
                          <ReaderBlockView
                            key={entry.block.id}
                            block={entry.block}
                            chapterId={entry.chapterId}
                            documentId={activeDocument.id}
                            highlights={documentHighlights}
                          />
                        ))}
                      </article>
                      <div className="page-controls">
                        <button
                          className="secondary-button"
                          onClick={() => setPageIndex((current) => clamp(current - 1, 0, Math.max(0, pages.length - 1)))}
                        >
                          Previous
                        </button>
                        <span>
                          Page {Math.min(pageIndex + 1, Math.max(1, pages.length))} of {Math.max(1, pages.length)}
                        </span>
                        <button
                          className="secondary-button"
                          onClick={() => setPageIndex((current) => clamp(current + 1, 0, Math.max(0, pages.length - 1)))}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}

export default App
