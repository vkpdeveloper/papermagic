import { contextBridge, ipcRenderer } from 'electron'
import type { PaperMagicApi } from '../src/types'

const api: PaperMagicApi = {
  loadState: () => ipcRenderer.invoke('paper:load-state'),
  importWithDialog: () => ipcRenderer.invoke('paper:import-with-dialog'),
  importPaths: (paths) => ipcRenderer.invoke('paper:import-paths', paths),
  importUrl: (url) => ipcRenderer.invoke('paper:import-url', url),
  saveProgress: (progress) => ipcRenderer.invoke('paper:save-progress', progress),
  savePreferences: (preferences) => ipcRenderer.invoke('paper:save-preferences', preferences),
  addBookmark: (bookmark) => ipcRenderer.invoke('paper:add-bookmark', bookmark),
  addHighlight: (highlight) => ipcRenderer.invoke('paper:add-highlight', highlight),
}

contextBridge.exposeInMainWorld('paperMagic', api)
