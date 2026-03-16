export type AppMode = 'library' | 'reader'
export type DocumentSource = 'pdf' | 'epub' | 'web'
export type ReadingMode = 'scroll' | 'page'
export type ReaderBlockType = 'heading' | 'paragraph' | 'quote' | 'list' | 'code' | 'image'

export interface ReaderBlock {
  id: string
  type: ReaderBlockType
  text?: string
  items?: string[]
  level?: number
  alt?: string
  caption?: string
  src?: string
}

export interface Chapter {
  id: string
  title: string
  content: ReaderBlock[]
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
  originLabel: string
  wordCount: number
  estimatedMinutes: number
  extractedWith: string
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

export interface PaperMagicApi {
  loadState: () => Promise<PersistedState>
  importWithDialog: () => Promise<DocumentRecord[]>
  importPaths: (paths: string[]) => Promise<DocumentRecord[]>
  importUrl: (url: string) => Promise<DocumentRecord>
  saveProgress: (progress: ReadingProgress) => Promise<void>
  savePreferences: (preferences: ReaderPreferences) => Promise<ReaderPreferences>
  addBookmark: (bookmark: BookmarkInput) => Promise<Bookmark>
  addHighlight: (highlight: HighlightInput) => Promise<Highlight>
}
