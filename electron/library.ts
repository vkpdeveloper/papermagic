import type { BookmarkInput, DocumentRecord, HighlightInput, PersistedState, ReaderPreferences, ReadingProgress } from '../src/types'
import {
  addBookmark,
  addHighlight,
  buildBookmark,
  buildHighlight,
  createDatabaseContext,
  findExistingDocumentBySource,
  loadState,
  savePreferences,
  saveProgress,
  upsertDocument,
} from './database'
import { importDocumentFromPath, importDocumentFromUrl } from './importers'

export interface LibraryStore {
  loadState: () => Promise<PersistedState>
  importPaths: (paths: string[]) => Promise<DocumentRecord[]>
  importUrl: (url: string) => Promise<DocumentRecord>
  saveProgress: (progress: ReadingProgress) => Promise<void>
  savePreferences: (preferences: ReaderPreferences) => Promise<ReaderPreferences>
  addBookmark: (bookmark: BookmarkInput) => Promise<ReturnType<typeof buildBookmark>>
  addHighlight: (highlight: HighlightInput) => Promise<ReturnType<typeof buildHighlight>>
}

export function createLibraryStore(userDataPath: string): LibraryStore {
  const context = createDatabaseContext(userDataPath)

  return {
    loadState: async () => loadState(context),
    importPaths: async (paths) => {
      const importedDocuments: DocumentRecord[] = []

      for (const filePath of paths) {
        const existingDocumentId = findExistingDocumentBySource(context, filePath, filePath)

        if (existingDocumentId) {
          continue
        }

        const document = await importDocumentFromPath(filePath, context.libraryRoot)
        upsertDocument(context, document)
        importedDocuments.push(document)
      }

      return importedDocuments
    },
    importUrl: async (url) => {
      const existingDocumentId = findExistingDocumentBySource(context, undefined, url)

      if (existingDocumentId) {
        const state = loadState(context)
        const existingDocument = state.documents.find((document) => document.id === existingDocumentId)
        if (existingDocument) {
          return existingDocument
        }
      }

      const document = await importDocumentFromUrl(url, context.libraryRoot)
      upsertDocument(context, document)
      return document
    },
    saveProgress: async (progress) => {
      saveProgress(context, progress)
    },
    savePreferences: async (preferences) => savePreferences(context, preferences),
    addBookmark: async (bookmarkInput) => {
      const bookmark = buildBookmark(bookmarkInput)
      return addBookmark(context, bookmark)
    },
    addHighlight: async (highlightInput) => {
      const highlight = buildHighlight(highlightInput)
      return addHighlight(context, highlight)
    },
  }
}
