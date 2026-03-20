/**
 * pdf-extractor-preload.ts
 *
 * Preload for the hidden PDF extractor BrowserWindow.
 * Bridges ipcRenderer into window.extractorBridge so the worker script
 * running in the renderer can communicate with the main process.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('extractorBridge', {
  // Listen for a job dispatched from the main process
  onExtractPdf: (callback: (jobId: string, pdfBase64: string) => void) => {
    ipcRenderer.on('extractor:extract-pdf', (_event, jobId: string, pdfBase64: string) => {
      callback(jobId, pdfBase64)
    })
  },

  // Listen for a model pre-download request
  onDownloadModel: (callback: () => void) => {
    ipcRenderer.on('extractor:download-model', () => {
      callback()
    })
  },

  // Send extraction result back to main
  sendResult: (jobId: string, markdown: string) => {
    ipcRenderer.send('extractor:result', jobId, markdown)
  },

  // Send extraction error back to main
  sendError: (jobId: string, errorMessage: string) => {
    ipcRenderer.send('extractor:error', jobId, errorMessage)
  },

  // Send per-job progress back to main
  sendProgress: (jobId: string, progress: {
    stage: string
    message: string
    progress?: number
    currentPage?: number
    totalPages?: number
    error?: string
  }) => {
    ipcRenderer.send('extractor:progress', jobId, progress)
  },

  // Send model download progress back to main (broadcast to all windows)
  sendModelProgress: (progress: {
    stage: string
    message: string
    progress?: number
    error?: string
  }) => {
    ipcRenderer.send('extractor:model-progress', progress)
  },

  // Notify main that model is fully ready
  sendModelReady: () => {
    ipcRenderer.send('extractor:model-ready')
  },
})
