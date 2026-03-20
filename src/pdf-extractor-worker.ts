/**
 * pdf-extractor-worker.ts
 *
 * Runs inside the hidden extractor BrowserWindow renderer.
 * Uses Extract2MD (Scenario 3: quickConvertWithLLM — PDF.js + Qwen) to
 * extract PDF text and convert it to clean Markdown.
 *
 * Communicates with the main process via window.extractorBridge
 * (injected by pdf-extractor-preload.ts).
 *
 * Model used: Qwen3-0.6B-q4f16_1-MLC (small, fast, ~300 MB download)
 */

import { Extract2MDConverter, type Extract2MDConfig } from 'extract2md'

const QWEN_MODEL = 'Qwen3-0.6B-q4f16_1-MLC'

let modelLoaded = false

/**
 * Convert a base64-encoded PDF to Markdown.
 */
async function handleExtract(jobId: string, pdfBase64: string): Promise<void> {
  const bridge = window.extractorBridge

  try {
    bridge.sendProgress(jobId, { stage: 'init', message: 'Loading PDF extractor…' })

    // Convert base64 → Blob (File-like object that Extract2MD expects)
    const binaryString = atob(pdfBase64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const pdfBlob = new File([bytes.buffer], 'document.pdf', { type: 'application/pdf' })

    const config: Extract2MDConfig = {
      llm: {
        model: QWEN_MODEL,
        options: {
          temperature: 0.3,
          maxTokens: 8192,
        },
      },
      progressCallback: (progress) => {
        bridge.sendProgress(jobId, {
          stage: progress.stage ?? 'processing',
          message: progress.message ?? '',
          progress: progress.progress,
          currentPage: progress.currentPage,
          totalPages: progress.totalPages,
          error: progress.error,
        })
      },
    }

    const markdown = await Extract2MDConverter.quickConvertWithLLM(pdfBlob, config)

    // Mark model as loaded for subsequent calls
    modelLoaded = true

    bridge.sendResult(jobId, typeof markdown === 'string' ? markdown : String(markdown))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    bridge.sendError(jobId, message)
  }
}

/**
 * Pre-download and warm-up the Qwen model without extracting a real PDF.
 * Uses a tiny dummy PDF just to trigger model initialisation.
 */
async function handleDownloadModel(): Promise<void> {
  const bridge = window.extractorBridge

  if (modelLoaded) {
    bridge.sendModelReady()
    return
  }

  try {
    bridge.sendModelProgress({ stage: 'model_download_start', message: 'Starting Qwen model download…' })

    // Minimal valid 1-page PDF (just triggers WebLLM model load, discards output)
    const MINIMAL_PDF_B64 =
      'JVBERi0xLjAKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwNQolJUVPRgo='

    const bytes = Uint8Array.from(atob(MINIMAL_PDF_B64), (c) => c.charCodeAt(0))
    const dummyFile = new File([bytes.buffer], 'warmup.pdf', { type: 'application/pdf' })

    const config: Extract2MDConfig = {
      llm: {
        model: QWEN_MODEL,
        options: { temperature: 0.3, maxTokens: 16 },
      },
      progressCallback: (progress) => {
        bridge.sendModelProgress({
          stage: progress.stage ?? 'model_download',
          message: progress.message ?? '',
          progress: progress.progress,
        })
      },
    }

    await Extract2MDConverter.quickConvertWithLLM(dummyFile, config)

    modelLoaded = true
    bridge.sendModelReady()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    bridge.sendModelProgress({
      stage: 'model_download_error',
      message: message,
      error: message,
    })
  }
}

// ─── Wire up bridge listeners ─────────────────────────────────────────────────

if (window.extractorBridge) {
  window.extractorBridge.onExtractPdf((jobId, pdfBase64) => {
    void handleExtract(jobId, pdfBase64)
  })

  window.extractorBridge.onDownloadModel(() => {
    void handleDownloadModel()
  })
} else {
  console.error('[pdf-extractor-worker] extractorBridge not found — is the preload loaded?')
}
