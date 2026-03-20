export type AppMode = 'library' | 'reader'
export type DocumentSource = 'pdf' | 'epub'
export type ReadingMode = 'scroll' | 'page'
export type ReaderBlockType = 'heading' | 'paragraph' | 'quote' | 'list' | 'code' | 'image' | 'math' | 'table' | 'pdf-page'

export interface ReaderBlock {
  id: string
  type: ReaderBlockType
  text?: string
  items?: string[]
  level?: number
  alt?: string
  caption?: string
  src?: string
  language?: string
  ordered?: boolean
  pageNumber?: number
  pageWidth?: number
  pageHeight?: number
}

export interface Chapter {
  id: string
  title: string
  content: ReaderBlock[]
  outlineDepth?: number
}

export interface TocItem {
  id: string
  title: string
  chapterId: string
  blockId: string
  level: number
}

export interface DocumentMetadata {
  importedAt: string
  importVersion: number
  originLabel: string
  wordCount: number
  estimatedMinutes: number
  extractedWith: string
  coverImageUrl?: string
  note?: string
  sourcePath?: string
  cacheDirectory?: string
  warnings?: string[]
}

export interface DocumentRecord {
  id: string
  title: string
  author: string
  coverHue: number
  sourceType: DocumentSource
  description: string
  chapters: Chapter[]
  toc: TocItem[]
  metadata: DocumentMetadata
  preferredMode: ReadingMode
}

export interface ReadingProgress {
  documentId: string
  progress: number
  chapterId: string
  blockId: string
  pageIndex: number
  readingMode: ReadingMode
  lastOpenedAt: string
}

export interface Highlight {
  id: string
  documentId: string
  chapterId: string
  blockId: string
  text: string
  createdAt: string
}

export interface Bookmark {
  id: string
  documentId: string
  chapterId: string
  blockId: string
  label: string
  createdAt: string
}

export interface ReaderPreferences {
  fontSize: number
  readingWidth: number
}

export interface PersistedState {
  documents: DocumentRecord[]
  progress: ReadingProgress[]
  highlights: Highlight[]
  bookmarks: Bookmark[]
  preferences: ReaderPreferences
}

export type BookmarkInput = Omit<Bookmark, 'id' | 'createdAt'>
export type HighlightInput = Omit<Highlight, 'id' | 'createdAt'>

export interface FlatBlock {
  chapterId: string
  chapterTitle: string
  block: ReaderBlock
}

export interface SearchResult {
  id: string
  chapterId: string
  blockId: string
  chapterTitle: string
  text: string
  context: string
}

export type AiProvider = 'google' | 'openai' | 'anthropic'

export interface AppSettings {
  aiEnabled: boolean
  aiProvider: AiProvider | null
  aiModel: string | null
  aiApiKey: string | null
}

export interface PaperMagicApi {
  loadState: () => Promise<PersistedState>
  importWithDialog: () => Promise<DocumentRecord[]>
  importPaths: (paths: string[]) => Promise<DocumentRecord[]>
  removeDocument: (documentId: string) => Promise<void>
  renameDocument: (documentId: string, title: string) => Promise<void>
  saveProgress: (progress: ReadingProgress) => Promise<void>
  savePreferences: (preferences: ReaderPreferences) => Promise<ReaderPreferences>
  addBookmark: (bookmark: BookmarkInput) => Promise<Bookmark>
  addHighlight: (highlight: HighlightInput) => Promise<Highlight>
  removeHighlight: (highlightId: string) => Promise<void>
  removeBookmark: (bookmarkId: string) => Promise<void>
  loadSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  validateApiKey: (provider: AiProvider, apiKey: string, modelId: string) => Promise<boolean>
  getProviderModels: (provider: AiProvider) => Promise<Array<{ value: string; label: string; description: string }>>
  // Real-time document updates during extraction (page-by-page streaming)
  onDocumentUpdated: (callback: (doc: DocumentRecord) => void) => void
}
