import { contextBridge, ipcRenderer } from 'electron'
import type { PaperMagicApi } from '../src/types'

const api: PaperMagicApi = {
  loadState: () => ipcRenderer.invoke('paper:load-state'),
  importWithDialog: () => ipcRenderer.invoke('paper:import-with-dialog'),
  importPaths: (paths) => ipcRenderer.invoke('paper:import-paths', paths),
  importUrl: (url) => ipcRenderer.invoke('paper:import-url', url),
  removeDocument: (documentId) => ipcRenderer.invoke('paper:remove-document', documentId),
  renameDocument: (documentId, title) => ipcRenderer.invoke('paper:rename-document', documentId, title),
  saveProgress: (progress) => ipcRenderer.invoke('paper:save-progress', progress),
  savePreferences: (preferences) => ipcRenderer.invoke('paper:save-preferences', preferences),
  addBookmark: (bookmark) => ipcRenderer.invoke('paper:add-bookmark', bookmark),
  addHighlight: (highlight) => ipcRenderer.invoke('paper:add-highlight', highlight),
  removeHighlight: (highlightId) => ipcRenderer.invoke('paper:remove-highlight', highlightId),
  removeBookmark: (bookmarkId) => ipcRenderer.invoke('paper:remove-bookmark', bookmarkId),
  loadSettings: () => ipcRenderer.invoke('paper:load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('paper:save-settings', settings),
  validateApiKey: (provider, apiKey, modelId) => ipcRenderer.invoke('paper:validate-api-key', provider, apiKey, modelId),
  getProviderModels: (provider) => ipcRenderer.invoke('paper:get-provider-models', provider),
}

contextBridge.exposeInMainWorld('paperMagic', api)
