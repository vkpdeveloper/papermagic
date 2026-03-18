import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { asc, desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type {
  AppSettings,
  Bookmark,
  BookmarkInput,
  Chapter,
  DocumentMetadata,
  DocumentRecord,
  Highlight,
  HighlightInput,
  PersistedState,
  ReaderPreferences,
  ReadingProgress,
  TocItem,
} from '../src/types'
import { flattenDocument } from '../src/content'
import { defaultPreferences } from '../src/storage'
import {
  bookmarksTable,
  chaptersTable,
  documentsTable,
  highlightsTable,
  preferencesTable,
  progressTable,
  schema,
  settingsTable,
} from './schema'

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true })
}

export interface DatabaseContext {
  connection: Database.Database
  db: ReturnType<typeof drizzle<typeof schema>>
  dataRoot: string
  libraryRoot: string
}

function tableHasColumn(connection: Database.Database, tableName: string, columnName: string): boolean {
  const columns = connection.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

function readCoverImageUrlFromMetadataJson(metadataJson: string): string | null {
  try {
    const metadata = JSON.parse(metadataJson) as DocumentMetadata
    return typeof metadata.coverImageUrl === 'string' && metadata.coverImageUrl.length > 0 ? metadata.coverImageUrl : null
  } catch {
    return null
  }
}

function ensureDocumentCoverImageColumn(connection: Database.Database): void {
  if (!tableHasColumn(connection, 'documents', 'cover_image_url')) {
    connection.exec('ALTER TABLE documents ADD COLUMN cover_image_url TEXT;')
  }
}

function ensureAppSettingsAiApiKeyColumn(connection: Database.Database): void {
  if (!tableHasColumn(connection, 'app_settings', 'ai_api_key')) {
    connection.exec('ALTER TABLE app_settings ADD COLUMN ai_api_key TEXT;')
  }
}

function ensureLocalAiColumns(connection: Database.Database): void {
  if (!tableHasColumn(connection, 'app_settings', 'local_ai_enabled')) {
    connection.exec('ALTER TABLE app_settings ADD COLUMN local_ai_enabled INTEGER NOT NULL DEFAULT 1;')
  }
  if (!tableHasColumn(connection, 'app_settings', 'ollama_setup_complete')) {
    connection.exec('ALTER TABLE app_settings ADD COLUMN ollama_setup_complete INTEGER NOT NULL DEFAULT 0;')
  }
}

function ensureChapterRefinementColumns(connection: Database.Database): void {
  if (!tableHasColumn(connection, 'chapters', 'refined_content_json')) {
    connection.exec('ALTER TABLE chapters ADD COLUMN refined_content_json TEXT;')
  }
  if (!tableHasColumn(connection, 'chapters', 'refinement_status')) {
    connection.exec("ALTER TABLE chapters ADD COLUMN refinement_status TEXT NOT NULL DEFAULT 'pending';")
  }
}

function backfillDocumentCoverImageReferences(connection: Database.Database): void {
  const rows = connection
    .prepare('SELECT id, metadata_json, cover_image_url FROM documents WHERE cover_image_url IS NULL OR cover_image_url = ?')
    .all('') as Array<{ id: string; metadata_json: string; cover_image_url: string | null }>

  const updateStatement = connection.prepare('UPDATE documents SET cover_image_url = ? WHERE id = ?')

  for (const row of rows) {
    const coverImageUrl = readCoverImageUrlFromMetadataJson(row.metadata_json)

    if (!coverImageUrl) {
      continue
    }

    updateStatement.run(coverImageUrl, row.id)
  }
}

function createTables(connection: Database.Database): void {
  connection.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      cover_hue INTEGER NOT NULL,
      cover_image_url TEXT,
      source_type TEXT NOT NULL,
      description TEXT NOT NULL,
      toc_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      preferred_mode TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      title TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      document_id TEXT PRIMARY KEY,
      progress REAL NOT NULL,
      chapter_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      reading_mode TEXT NOT NULL,
      last_opened_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY,
      font_size INTEGER NOT NULL,
      reading_width INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS chapters_document_order_idx
      ON chapters (document_id, order_index);

    CREATE INDEX IF NOT EXISTS progress_last_opened_idx
      ON reading_progress (last_opened_at DESC);

    CREATE INDEX IF NOT EXISTS highlights_document_idx
      ON highlights (document_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS bookmarks_document_idx
      ON bookmarks (document_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_search
      USING fts5(document_id UNINDEXED, title, author, content);

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY,
      ai_enabled INTEGER NOT NULL DEFAULT 0,
      ai_provider TEXT,
      ai_model TEXT,
      ai_api_key TEXT
    );
  `)

  ensureDocumentCoverImageColumn(connection)
  backfillDocumentCoverImageReferences(connection)
  ensureAppSettingsAiApiKeyColumn(connection)
  ensureLocalAiColumns(connection)
  ensureChapterRefinementColumns(connection)
}

export function createDatabaseContext(userDataPath: string): DatabaseContext {
  const dataRoot = path.join(userDataPath, 'paper-magic')
  const libraryRoot = path.join(dataRoot, 'library')
  ensureDirectory(libraryRoot)

  const databasePath = path.join(dataRoot, 'papermagic.db')
  const connection = new Database(databasePath)
  createTables(connection)

  return {
    connection,
    db: drizzle(connection, { schema }),
    dataRoot,
    libraryRoot,
  }
}

function hydrateDocuments(context: DatabaseContext): DocumentRecord[] {
  const documentRows = context.db.select().from(documentsTable).all()
  const chapterRows = context.db.select().from(chaptersTable).orderBy(asc(chaptersTable.orderIndex)).all()
  const chapterMap = new Map<string, Chapter[]>()

  chapterRows.forEach((row) => {
    const chapters = chapterMap.get(row.documentId) ?? []
    chapters.push({
      id: row.id,
      title: row.title,
      content: parseJson(row.contentJson),
    })
    chapterMap.set(row.documentId, chapters)
  })

  return documentRows
    .map((row) => {
      const metadata = parseJson<DocumentMetadata>(row.metadataJson)

      if (row.coverImageUrl && metadata.coverImageUrl !== row.coverImageUrl) {
        metadata.coverImageUrl = row.coverImageUrl
      }

      return {
        id: row.id,
        title: row.title,
        author: row.author,
        coverHue: row.coverHue,
        sourceType: row.sourceType as DocumentRecord['sourceType'],
        description: row.description,
        chapters: chapterMap.get(row.id) ?? [],
        toc: parseJson<TocItem[]>(row.tocJson),
        metadata,
        preferredMode: row.preferredMode as DocumentRecord['preferredMode'],
      }
    })
    .sort(
      (left, right) =>
        new Date(right.metadata.importedAt).getTime() - new Date(left.metadata.importedAt).getTime(),
    )
}

export function loadState(context: DatabaseContext): PersistedState {
  const preferenceRow = context.db
    .select()
    .from(preferencesTable)
    .where(eq(preferencesTable.id, 1))
    .get()

  return {
    documents: hydrateDocuments(context),
    progress: context.db.select().from(progressTable).orderBy(desc(progressTable.lastOpenedAt)).all().map((row) => ({
      documentId: row.documentId,
      progress: row.progress,
      chapterId: row.chapterId,
      blockId: row.blockId,
      pageIndex: row.pageIndex,
      readingMode: row.readingMode as ReadingProgress['readingMode'],
      lastOpenedAt: row.lastOpenedAt,
    })),
    highlights: context.db
      .select()
      .from(highlightsTable)
      .orderBy(desc(highlightsTable.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        documentId: row.documentId,
        chapterId: row.chapterId,
        blockId: row.blockId,
        text: row.text,
        createdAt: row.createdAt,
      })),
    bookmarks: context.db
      .select()
      .from(bookmarksTable)
      .orderBy(desc(bookmarksTable.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        documentId: row.documentId,
        chapterId: row.chapterId,
        blockId: row.blockId,
        label: row.label,
        createdAt: row.createdAt,
      })),
    preferences: preferenceRow
      ? {
          fontSize: preferenceRow.fontSize,
          readingWidth: preferenceRow.readingWidth,
        }
      : defaultPreferences,
  }
}

function refreshSearchIndex(context: DatabaseContext, document: DocumentRecord): void {
  const content = flattenDocument(document)
    .map(({ chapterTitle, block }) => [chapterTitle, block.text, block.caption, block.items?.join(' ')].filter(Boolean).join(' '))
    .join('\n')

  context.connection.prepare('DELETE FROM documents_search WHERE document_id = ?').run(document.id)
  context.connection
    .prepare('INSERT INTO documents_search (document_id, title, author, content) VALUES (?, ?, ?, ?)')
    .run(document.id, document.title, document.author, content)
}

export function upsertDocument(context: DatabaseContext, document: DocumentRecord): void {
  context.db.transaction((tx) => {
    tx.insert(documentsTable)
      .values({
        id: document.id,
        title: document.title,
        author: document.author,
        coverHue: document.coverHue,
        coverImageUrl: document.metadata.coverImageUrl ?? null,
        sourceType: document.sourceType,
        description: document.description,
        tocJson: JSON.stringify(document.toc),
        metadataJson: JSON.stringify(document.metadata),
        preferredMode: document.preferredMode,
      })
      .onConflictDoUpdate({
        target: documentsTable.id,
        set: {
          title: document.title,
          author: document.author,
          coverHue: document.coverHue,
          coverImageUrl: document.metadata.coverImageUrl ?? null,
          sourceType: document.sourceType,
          description: document.description,
          tocJson: JSON.stringify(document.toc),
          metadataJson: JSON.stringify(document.metadata),
          preferredMode: document.preferredMode,
        },
      })
      .run()

    tx.delete(chaptersTable).where(eq(chaptersTable.documentId, document.id)).run()

    if (document.chapters.length > 0) {
      tx.insert(chaptersTable)
        .values(
          document.chapters.map((chapter, index) => ({
            id: chapter.id,
            documentId: document.id,
            title: chapter.title,
            orderIndex: index,
            contentJson: JSON.stringify(chapter.content),
          })),
        )
        .run()
    }
  })

  refreshSearchIndex(context, document)
}

export function saveProgress(context: DatabaseContext, progress: ReadingProgress): void {
  context.db
    .insert(progressTable)
    .values({
      documentId: progress.documentId,
      progress: progress.progress,
      chapterId: progress.chapterId,
      blockId: progress.blockId,
      pageIndex: progress.pageIndex,
      readingMode: progress.readingMode,
      lastOpenedAt: progress.lastOpenedAt,
    })
    .onConflictDoUpdate({
      target: progressTable.documentId,
      set: {
        progress: progress.progress,
        chapterId: progress.chapterId,
        blockId: progress.blockId,
        pageIndex: progress.pageIndex,
        readingMode: progress.readingMode,
        lastOpenedAt: progress.lastOpenedAt,
      },
    })
    .run()
}

export function savePreferences(context: DatabaseContext, preferences: ReaderPreferences): ReaderPreferences {
  const nextPreferences = {
    fontSize: Math.min(24, Math.max(16, Math.round(preferences.fontSize))),
    readingWidth: Math.min(1040, Math.max(700, Math.round(preferences.readingWidth))),
  }

  context.db
    .insert(preferencesTable)
    .values({
      id: 1,
      fontSize: nextPreferences.fontSize,
      readingWidth: nextPreferences.readingWidth,
    })
    .onConflictDoUpdate({
      target: preferencesTable.id,
      set: {
        fontSize: nextPreferences.fontSize,
        readingWidth: nextPreferences.readingWidth,
      },
    })
    .run()

  return nextPreferences
}

export function addHighlight(context: DatabaseContext, highlight: Highlight): Highlight {
  context.db
    .insert(highlightsTable)
    .values({
      id: highlight.id,
      documentId: highlight.documentId,
      chapterId: highlight.chapterId,
      blockId: highlight.blockId,
      text: highlight.text,
      createdAt: highlight.createdAt,
    })
    .run()

  return highlight
}

export function removeHighlight(context: DatabaseContext, highlightId: string): void {
  context.db.delete(highlightsTable).where(eq(highlightsTable.id, highlightId)).run()
}

export function addBookmark(context: DatabaseContext, bookmark: Bookmark): Bookmark {
  context.db
    .insert(bookmarksTable)
    .values({
      id: bookmark.id,
      documentId: bookmark.documentId,
      chapterId: bookmark.chapterId,
      blockId: bookmark.blockId,
      label: bookmark.label,
      createdAt: bookmark.createdAt,
    })
    .run()

  return bookmark
}

export function removeBookmark(context: DatabaseContext, bookmarkId: string): void {
  context.db.delete(bookmarksTable).where(eq(bookmarksTable.id, bookmarkId)).run()
}

export function buildHighlight(input: HighlightInput): Highlight {
  return {
    ...input,
    id: input.blockId ? `highlight-${crypto.randomUUID()}` : crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }
}

export function buildBookmark(input: BookmarkInput): Bookmark {
  return {
    ...input,
    id: input.blockId ? `bookmark-${crypto.randomUUID()}` : crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }
}

export function documentExistsForPath(context: DatabaseContext, sourcePath: string): boolean {
  const rows = context.db.select().from(documentsTable).all()
  return rows.some((row) => {
    const metadata = parseJson<DocumentRecord['metadata']>(row.metadataJson)
    return metadata.sourcePath === sourcePath
  })
}

export function documentExistsForOrigin(context: DatabaseContext, originLabel: string): boolean {
  const rows = context.db.select().from(documentsTable).all()
  return rows.some((row) => {
    const metadata = parseJson<DocumentRecord['metadata']>(row.metadataJson)
    return metadata.originLabel === originLabel
  })
}

export function removeDocument(context: DatabaseContext, documentId: string): void {
  context.db.delete(bookmarksTable).where(eq(bookmarksTable.documentId, documentId)).run()
  context.db.delete(highlightsTable).where(eq(highlightsTable.documentId, documentId)).run()
  context.db.delete(progressTable).where(eq(progressTable.documentId, documentId)).run()
  context.db.delete(chaptersTable).where(eq(chaptersTable.documentId, documentId)).run()
  context.db.delete(documentsTable).where(eq(documentsTable.id, documentId)).run()
  context.connection.prepare('DELETE FROM documents_search WHERE document_id = ?').run(documentId)
}

export function findExistingDocumentBySource(
  context: DatabaseContext,
  sourcePath: string | undefined,
  originLabel: string,
): string | null {
  const rows = context.db.select().from(documentsTable).all()

  for (const row of rows) {
    const metadata = parseJson<DocumentRecord['metadata']>(row.metadataJson)
    if ((sourcePath && metadata.sourcePath === sourcePath) || metadata.originLabel === originLabel) {
      return row.id
    }
  }

  return null
}

const defaultSettings: AppSettings = {
  aiEnabled: false,
  aiProvider: null,
  aiModel: null,
  aiApiKey: null,
  localAiEnabled: true,
}

export function loadSettings(context: DatabaseContext): AppSettings {
  const row = context.db.select().from(settingsTable).where(eq(settingsTable.id, 1)).get()

  if (!row) {
    return defaultSettings
  }

  return {
    aiEnabled: row.aiEnabled,
    aiProvider: (row.aiProvider as AppSettings['aiProvider']) ?? null,
    aiModel: row.aiModel ?? null,
    aiApiKey: row.aiApiKey ?? null,
    localAiEnabled: row.localAiEnabled ?? true,
  }
}

export function saveSettings(context: DatabaseContext, settings: AppSettings): AppSettings {
  context.db
    .insert(settingsTable)
    .values({
      id: 1,
      aiEnabled: settings.aiEnabled,
      aiProvider: settings.aiProvider ?? null,
      aiModel: settings.aiModel ?? null,
      aiApiKey: settings.aiApiKey ?? null,
      localAiEnabled: settings.localAiEnabled,
    })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: {
        aiEnabled: settings.aiEnabled,
        aiProvider: settings.aiProvider ?? null,
        aiModel: settings.aiModel ?? null,
        aiApiKey: settings.aiApiKey ?? null,
        localAiEnabled: settings.localAiEnabled,
      },
    })
    .run()

  return settings
}

export function isOllamaSetupComplete(context: DatabaseContext): boolean {
  const row = context.db.select().from(settingsTable).where(eq(settingsTable.id, 1)).get()
  return row?.ollamaSetupComplete ?? false
}

export function markOllamaSetupComplete(context: DatabaseContext): void {
  context.db
    .insert(settingsTable)
    .values({ id: 1, aiEnabled: false, localAiEnabled: true, ollamaSetupComplete: true })
    .onConflictDoUpdate({ target: settingsTable.id, set: { ollamaSetupComplete: true } })
    .run()
}

export interface ChapterRefinementRow {
  id: string
  documentId: string
  orderIndex: number
  contentJson: string
  refinementStatus: string
}

export function getPendingRefinementChapters(context: DatabaseContext): ChapterRefinementRow[] {
  return context.connection
    .prepare(
      `SELECT id, document_id as documentId, order_index as orderIndex, content_json as contentJson, refinement_status as refinementStatus
       FROM chapters WHERE refinement_status = 'pending' ORDER BY order_index ASC`
    )
    .all() as ChapterRefinementRow[]
}

export function saveRefinedChapter(
  context: DatabaseContext,
  chapterId: string,
  refinedContentJson: string,
  status: 'done' | 'failed',
): void {
  context.connection
    .prepare('UPDATE chapters SET refined_content_json = ?, refinement_status = ? WHERE id = ?')
    .run(refinedContentJson, status, chapterId)
}

export function markChapterRefinementStatus(
  context: DatabaseContext,
  chapterId: string,
  status: string,
): void {
  context.connection
    .prepare('UPDATE chapters SET refinement_status = ? WHERE id = ?')
    .run(status, chapterId)
}

export function resetDocumentRefinement(context: DatabaseContext, documentId: string): void {
  context.connection
    .prepare("UPDATE chapters SET refinement_status = 'pending', refined_content_json = NULL WHERE document_id = ?")
    .run(documentId)
}
