/**
 * Type declarations for window.extractorBridge
 * Injected by electron/pdf-extractor-preload.ts via contextBridge.
 */

interface ExtractorProgressPayload {
  stage: string
  message: string
  progress?: number
  currentPage?: number
  totalPages?: number
  error?: string
}

interface ExtractorModelProgressPayload {
  stage: string
  message: string
  progress?: number
  error?: string
}

interface ExtractorBridge {
  onExtractPdf: (callback: (jobId: string, pdfBase64: string) => void) => void
  onDownloadModel: (callback: () => void) => void
  sendResult: (jobId: string, markdown: string) => void
  sendError: (jobId: string, errorMessage: string) => void
  sendProgress: (jobId: string, progress: ExtractorProgressPayload) => void
  sendModelProgress: (progress: ExtractorModelProgressPayload) => void
  sendModelReady: () => void
}

interface Window {
  extractorBridge: ExtractorBridge
}
