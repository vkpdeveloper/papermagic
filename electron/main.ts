import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createLibraryStore } from './library'
import { registerExtractorIpcListeners, downloadLocalModel } from './pdf-extractor-window'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let libraryStore: ReturnType<typeof createLibraryStore> | null = null

// Enable WebGPU for the hidden PDF extractor window (used by WebLLM / Qwen).
// Each platform uses a different GPU backend; enable the appropriate one.
app.commandLine.appendSwitch('enable-unsafe-webgpu')
if (process.platform === 'linux') {
  // Linux: Vulkan backend + sandbox workarounds
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
  app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaRenderer')
} else if (process.platform === 'darwin') {
  // macOS: Metal backend (default on Apple Silicon and Intel Macs with Metal support)
  app.commandLine.appendSwitch('enable-features', 'Metal')
} else if (process.platform === 'win32') {
  // Windows: D3D12 backend
  app.commandLine.appendSwitch('enable-features', 'D3D12')
}

function createWindow() {
  win = new BrowserWindow({
    title: 'Paper Magic',
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    backgroundColor: '#090a0c',
    minWidth: 1180,
    minHeight: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

function requireStore() {
  if (!libraryStore) {
    throw new Error('Paper Magic store is not initialized yet.')
  }

  return libraryStore
}

function registerIpcHandlers() {
  ipcMain.handle('paper:load-state', () => requireStore().loadState())
  ipcMain.handle('paper:import-with-dialog', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Readable documents',
          extensions: ['pdf', 'epub'],
        },
      ],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return []
    }

    return requireStore().importPaths(result.filePaths)
  })
  ipcMain.handle('paper:import-paths', (_event, paths: string[]) => requireStore().importPaths(paths))
  ipcMain.handle('paper:remove-document', (_event, documentId: string) => requireStore().removeDocument(documentId))
  ipcMain.handle('paper:rename-document', (_event, documentId: string, title: string) => requireStore().renameDocument(documentId, title))
  ipcMain.handle('paper:save-progress', (_event, progress) => requireStore().saveProgress(progress))
  ipcMain.handle('paper:save-preferences', (_event, preferences) => requireStore().savePreferences(preferences))
  ipcMain.handle('paper:add-bookmark', (_event, bookmark) => requireStore().addBookmark(bookmark))
  ipcMain.handle('paper:add-highlight', (_event, highlight) => requireStore().addHighlight(highlight))
  ipcMain.handle('paper:remove-highlight', (_event, highlightId: string) => requireStore().removeHighlight(highlightId))
  ipcMain.handle('paper:remove-bookmark', (_event, bookmarkId: string) => requireStore().removeBookmark(bookmarkId))
  ipcMain.handle('paper:load-settings', () => requireStore().loadSettings())
  ipcMain.handle('paper:save-settings', (_event, settings) => requireStore().saveSettings(settings))
  ipcMain.handle('paper:validate-api-key', (_event, provider, apiKey, modelId) => requireStore().validateApiKey(provider, apiKey, modelId))
  ipcMain.handle('paper:get-provider-models', (_event, provider) => requireStore().getProviderModels(provider))
  // Local model (WebLLM / Qwen) — triggers pre-download in hidden extractor window
  ipcMain.handle('paper:download-local-model', () => {
    downloadLocalModel()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  libraryStore = createLibraryStore(app.getPath('userData'))
  registerExtractorIpcListeners({
    onModelReady: () => {
      // Persist the flag so the Settings page can show the model as ready
      void requireStore().markLocalModelReady()
    },
  })
  registerIpcHandlers()
  createWindow()
})
