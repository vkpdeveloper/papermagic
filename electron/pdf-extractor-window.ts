/**
 * pdf-extractor-window.ts
 *
 * Manages a long-lived hidden BrowserWindow that hosts the Extract2MD + WebLLM
 * renderer. The main process calls into this module to:
 *   1. Ensure the window is created and loaded.
 *   2. Trigger PDF-to-markdown extraction jobs.
 *   3. Trigger model pre-download jobs (for the Settings page).
 *
 * Communication pattern:
 *   Main → Renderer  :  webContents.send('extractor:*')
 *   Renderer → Main  :  ipcMain.handle / ipcMain.on('extractor:*')
 *
 * The renderer page is at public/pdf-extractor.html.
 */

import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolved at module load time via the same env vars as main.ts
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const RENDERER_DIST = path.join(process.env.APP_ROOT ?? path.join(__dirname, '..'), 'dist')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExtractorProgressEvent {
  stage: string
  message: string
  progress?: number
  currentPage?: number
  totalPages?: number
  error?: string
}

export type ExtractorProgressCallback = (event: ExtractorProgressEvent) => void

// ─── Singleton window state ───────────────────────────────────────────────────

let extractorWindow: BrowserWindow | null = null
// Pending extraction jobs keyed by a unique job id
const pendingJobs = new Map<
  string,
  {
    resolve: (markdown: string) => void
    reject: (err: Error) => void
    progressCallback?: ExtractorProgressCallback
  }
>()

let jobCounter = 0

// ─── Window lifecycle ─────────────────────────────────────────────────────────

function getExtractorPageUrl(): string {
  if (VITE_DEV_SERVER_URL) {
    // In dev the extractor page is served from the Vite dev server
    return `${VITE_DEV_SERVER_URL}pdf-extractor.html`
  }
  return `file://${path.join(RENDERER_DIST, 'pdf-extractor.html')}`
}

export function ensureExtractorWindow(): BrowserWindow {
  if (extractorWindow && !extractorWindow.isDestroyed()) {
    return extractorWindow
  }

  extractorWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // needed so WebLLM can fetch model shards from CDN in file:// context
      preload: path.join(__dirname, 'pdf-extractor-preload.mjs'),
    },
  })

  extractorWindow.loadURL(getExtractorPageUrl())

  extractorWindow.webContents.on('did-finish-load', () => {
    // Nothing to do on load — jobs are dispatched on demand
  })

  extractorWindow.on('closed', () => {
    extractorWindow = null
    // Reject all pending jobs if the window was unexpectedly closed
    for (const [jobId, job] of pendingJobs) {
      job.reject(new Error('Extractor window was closed unexpectedly'))
      pendingJobs.delete(jobId)
    }
  })

  return extractorWindow
}

// ─── IPC result listeners (registered once) ───────────────────────────────────

let ipcListenersRegistered = false

export function registerExtractorIpcListeners(callbacks?: { onModelReady?: () => void }): void {
  if (ipcListenersRegistered) return
  ipcListenersRegistered = true

  // The renderer sends progress updates back here
  ipcMain.on('extractor:progress', (_event, jobId: string, progress: ExtractorProgressEvent) => {
    const job = pendingJobs.get(jobId)
    if (job?.progressCallback) {
      job.progressCallback(progress)
    }
  })

  // The renderer sends the final result here
  ipcMain.on('extractor:result', (_event, jobId: string, markdown: string) => {
    const job = pendingJobs.get(jobId)
    if (job) {
      pendingJobs.delete(jobId)
      job.resolve(markdown)
    }
  })

  // The renderer sends an error here
  ipcMain.on('extractor:error', (_event, jobId: string, errorMessage: string) => {
    const job = pendingJobs.get(jobId)
    if (job) {
      pendingJobs.delete(jobId)
      job.reject(new Error(errorMessage))
    }
  })

  // Model download progress (not tied to a PDF job)
  ipcMain.on('extractor:model-progress', (_event, progress: ExtractorProgressEvent) => {
    // Forward to the main window as a broadcast so the Settings page can listen
    const mainWindows = BrowserWindow.getAllWindows().filter((w) => w !== extractorWindow)
    for (const win of mainWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('paper:local-model-progress', progress)
      }
    }
  })

  // Model download complete
  ipcMain.on('extractor:model-ready', () => {
    callbacks?.onModelReady?.()
    const mainWindows = BrowserWindow.getAllWindows().filter((w) => w !== extractorWindow)
    for (const win of mainWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('paper:local-model-ready')
      }
    }
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract the text content of a PDF file as Markdown using WebLLM (Qwen).
 *
 * @param pdfBase64  Base64-encoded PDF bytes
 * @param onProgress Optional progress callback for UI updates
 * @returns Resolved Markdown string
 */
export function extractPdfToMarkdown(
  pdfBase64: string,
  onProgress?: ExtractorProgressCallback,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = ensureExtractorWindow()
    const jobId = `job-${++jobCounter}-${Date.now()}`

    pendingJobs.set(jobId, { resolve, reject, progressCallback: onProgress })

    // Wait until the page is ready before dispatching the job
    const dispatch = () => {
      win.webContents.send('extractor:extract-pdf', jobId, pdfBase64)
    }

    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', dispatch)
    } else {
      dispatch()
    }
  })
}

/**
 * Trigger a model pre-download in the extractor window.
 * Progress events are forwarded to the main window via 'paper:local-model-progress'.
 */
export function downloadLocalModel(): void {
  const win = ensureExtractorWindow()

  const dispatch = () => {
    win.webContents.send('extractor:download-model')
  }

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', dispatch)
  } else {
    dispatch()
  }
}
