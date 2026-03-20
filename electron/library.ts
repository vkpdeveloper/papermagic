import fs from 'node:fs/promises'
import path from 'node:path'
import { documentNeedsRepair } from '../src/content'
import type { AppSettings, BookmarkInput, DocumentRecord, HighlightInput, PersistedState, ReaderPreferences, ReadingProgress } from '../src/types'
import {
  addBookmark,
  addHighlight,
  buildBookmark,
  buildHighlight,
  createDatabaseContext,
  findExistingDocumentBySource,
  loadSettings,
  loadState,
  removeBookmark,
  removeDocument,
  removeHighlight,
  savePreferences,
  saveProgress,
  saveSettings,
  upsertDocument,
} from './database'
import { importDocumentFromPath } from './importers'
import { validateApiKey, PROVIDER_MODELS } from './ai'
import type { AiProvider } from './ai'

export interface LibraryStore {
  loadState: () => Promise<PersistedState>
  importPaths: (paths: string[]) => Promise<DocumentRecord[]>
  removeDocument: (documentId: string) => Promise<void>
  renameDocument: (documentId: string, title: string) => Promise<void>
  saveProgress: (progress: ReadingProgress) => Promise<void>
  savePreferences: (preferences: ReaderPreferences) => Promise<ReaderPreferences>
  addBookmark: (bookmark: BookmarkInput) => Promise<ReturnType<typeof buildBookmark>>
  addHighlight: (highlight: HighlightInput) => Promise<ReturnType<typeof buildHighlight>>
  removeHighlight: (highlightId: string) => Promise<void>
  removeBookmark: (bookmarkId: string) => Promise<void>
  loadSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  validateApiKey: (provider: AiProvider, apiKey: string, modelId: string) => Promise<boolean>
  getProviderModels: (provider: AiProvider) => Promise<Array<{ value: string; label: string; description: string }>>
}

function resolveDocumentCacheDirectory(document: DocumentRecord, libraryRoot: string): string {
  const fallbackDirectory = path.join(libraryRoot, document.id)
  const candidateDirectory = document.metadata.cacheDirectory ?? fallbackDirectory
  const resolvedLibraryRoot = path.resolve(libraryRoot)
  const resolvedCandidate = path.resolve(candidateDirectory)

  if (resolvedCandidate === resolvedLibraryRoot || !resolvedCandidate.startsWith(`${resolvedLibraryRoot}${path.sep}`)) {
    return fallbackDirectory
  }

  return resolvedCandidate
}

export function createLibraryStore(
  userDataPath: string,
  options?: { onDocumentUpdate?: (doc: DocumentRecord) => void },
): LibraryStore {
  const context = createDatabaseContext(userDataPath)

  const repairUnreadableDocuments = async (): Promise<void> => {
    const state = loadState(context)

    for (const document of state.documents) {
      if (!documentNeedsRepair(document) || !document.metadata.sourcePath) {
        continue
      }

      try {
        removeDocument(context, document.id)
        const repairedDocument = await importDocumentFromPath(document.metadata.sourcePath, context.libraryRoot, {
          documentId: document.id,
        })
        upsertDocument(context, repairedDocument)
      } catch {
        continue
      }
    }
  }

  return {
    loadState: async () => {
      await repairUnreadableDocuments()
      return loadState(context)
    },
    importPaths: async (paths) => {
      const importedDocuments: DocumentRecord[] = []

      for (const filePath of paths) {
        const existingDocumentId = findExistingDocumentBySource(context, filePath, filePath)

        if (existingDocumentId) {
          continue
        }

        // Resolve with the stub as soon as the first onUpdate fires (cover + title ready),
        // then continue extraction in the background, streaming each page into the DB.
        let isFirst = true
        let resolveStub!: (doc: DocumentRecord) => void
        let rejectStub!: (err: unknown) => void
        const stubPromise = new Promise<DocumentRecord>((resolve, reject) => {
          resolveStub = resolve
          rejectStub = reject
        })

        void importDocumentFromPath(filePath, context.libraryRoot, {
          onUpdate: (doc) => {
            upsertDocument(context, doc)
            if (isFirst) {
              isFirst = false
              resolveStub(doc)
            } else {
              options?.onDocumentUpdate?.(doc)
            }
          },
        }).then((finalDoc) => {
          upsertDocument(context, finalDoc)
          options?.onDocumentUpdate?.(finalDoc)
        }).catch((err) => {
          if (isFirst) {
            isFirst = false
            rejectStub(err)
          }
        })

        try {
          const stub = await stubPromise
          importedDocuments.push(stub)
        } catch {
          // Import failed before producing any content — skip silently
        }
      }

      return importedDocuments
    },
    removeDocument: async (documentId) => {
      const state = loadState(context)
      const document = state.documents.find((entry) => entry.id === documentId)

      if (!document) {
        return
      }

      removeDocument(context, documentId)
      await fs.rm(resolveDocumentCacheDirectory(document, context.libraryRoot), { recursive: true, force: true })
    },
    renameDocument: async (documentId, title) => {
      const state = loadState(context)
      const document = state.documents.find((entry) => entry.id === documentId)

      if (!document) {
        return
      }

      upsertDocument(context, { ...document, title })
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
    removeHighlight: async (highlightId) => {
      removeHighlight(context, highlightId)
    },
    removeBookmark: async (bookmarkId) => {
      removeBookmark(context, bookmarkId)
    },
    loadSettings: async () => loadSettings(context),
    saveSettings: async (settings) => saveSettings(context, settings),
    validateApiKey: async (provider, apiKey, modelId) => validateApiKey(provider, apiKey, modelId),
    getProviderModels: async (provider) => PROVIDER_MODELS[provider] ?? [],
  }
}

