import { Ollama } from 'ollama'
import type { DatabaseContext } from './database'
import {
  getPendingRefinementChapters,
  saveRefinedChapter,
  markChapterRefinementStatus,
  resetDocumentRefinement,
  type ChapterRefinementRow,
} from './database'
import { getOllamaBaseUrl, OLLAMA_MODEL } from './ollama'
import type { ReaderBlock, ChapterRefinementUpdate } from '../src/types'

function buildClient(): Ollama {
  return new Ollama({ host: getOllamaBaseUrl() })
}

type RefinementEventCallback = (update: ChapterRefinementUpdate) => void

let eventCallback: RefinementEventCallback | null = null
let isRunning = false
let shouldStop = false

export function setRefinementEventCallback(cb: RefinementEventCallback) {
  eventCallback = cb
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a text formatting assistant. You receive JSON blocks extracted from a PDF and must fix formatting issues without removing or altering any content.

Rules:
- Merge paragraph blocks that were split mid-sentence by PDF line breaks (join them into one block)
- Fix hyphenation artifacts where a word is split across lines (e.g. "for-\\nmat" → "format")
- Correct heading levels if obviously wrong (e.g. a chapter title marked as paragraph)
- Do NOT summarize, rephrase, add, or remove content
- Do NOT merge distinct paragraphs — only merge broken ones
- Preserve all list items, code blocks, and image blocks exactly
- Return ONLY a valid JSON array of blocks matching the input schema, nothing else`

// ── Logging ───────────────────────────────────────────────────────────────────

function log(...args: unknown[]) {
  console.log('[refinement]', ...args)
}

// ── Block word count ──────────────────────────────────────────────────────────

function countWords(blocks: ReaderBlock[]): number {
  let count = 0
  for (const b of blocks) {
    if (b.text) count += b.text.split(/\s+/).filter(Boolean).length
    if (b.items) count += b.items.join(' ').split(/\s+/).filter(Boolean).length
  }
  return count
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateRefinedBlocks(original: ReaderBlock[], refined: ReaderBlock[]): boolean {
  if (!Array.isArray(refined) || refined.length === 0) return false

  // Each block must have a valid type
  const validTypes = new Set(['heading', 'paragraph', 'quote', 'list', 'code', 'image'])
  for (const b of refined) {
    if (!b.type || !validTypes.has(b.type)) return false
    if (b.type === 'list' && (!Array.isArray(b.items) || b.items.length === 0)) return false
    if (b.type !== 'list' && b.type !== 'image' && !b.text) return false
  }

  // Word count must be within 15% of original
  const origWords = countWords(original)
  const refWords = countWords(refined)
  if (origWords === 0) return true
  const ratio = refWords / origWords
  return ratio >= 0.85 && ratio <= 1.15
}

// ── Single chapter refinement ─────────────────────────────────────────────────

async function refineChapter(row: ChapterRefinementRow): Promise<ReaderBlock[] | null> {
  const original: ReaderBlock[] = JSON.parse(row.contentJson) as ReaderBlock[]
  const wordCount = countWords(original)

  // Skip tiny chapters (< 50 words) — not worth the round-trip
  if (wordCount < 50) {
    log(`  skip  chapter ${row.id} (${wordCount} words — too short)`)
    return null
  }

  const t0 = Date.now()
  log(`  →     chapter ${row.id} | ${wordCount} words | ${original.length} blocks`)

  try {
    // think: false disables qwen3.5's thinking mode — without it the model puts
    // its entire response in message.thinking and leaves message.content empty.
    const response = await buildClient().chat({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      options: { temperature: 0.1, num_predict: 4096 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Here are the PDF-extracted blocks for one chapter. Fix formatting and return the corrected JSON array:\n\n${JSON.stringify(original)}`,
        },
      ],
    })

    const raw = (response.message.content ?? '').trim()

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    // Extract JSON array from response (model may wrap it in markdown fences)
    const match = raw.trim().match(/\[[\s\S]*\]/)
    if (!match) {
      log(`  ✗     chapter ${row.id} | ${elapsed}s | no JSON array in response`)
      log(`  raw response (first 500 chars): ${raw.slice(0, 500)}`)
      return null
    }

    const refined = JSON.parse(match[0]) as ReaderBlock[]

    if (!validateRefinedBlocks(original, refined)) {
      const refWords = countWords(refined)
      log(`  ✗     chapter ${row.id} | ${elapsed}s | validation failed (orig=${wordCount}w refined=${refWords}w blocks=${refined.length})`)
      log(`  raw response (first 500 chars): ${raw.slice(0, 500)}`)
      return null
    }

    // Re-attach IDs from original blocks to preserve highlight/bookmark references
    for (let i = 0; i < Math.min(original.length, refined.length); i++) {
      if (!refined[i].id) refined[i].id = original[i].id
    }
    for (let i = original.length; i < refined.length; i++) {
      refined[i].id = `ref-${row.id}-${i}`
    }

    log(`  ✓     chapter ${row.id} | ${elapsed}s | ${original.length} → ${refined.length} blocks`)
    return refined
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    log(`  ✗     chapter ${row.id} | ${elapsed}s | error: ${String(err)}`)
    return null
  }
}

// ── Queue processor ───────────────────────────────────────────────────────────

const CONCURRENCY = 4

async function processChapter(
  context: DatabaseContext,
  row: ChapterRefinementRow,
  index: number,
  total: number,
): Promise<void> {
  if (shouldStop) return

  log(`[${index}/${total}] processing chapter ${row.id} (doc ${row.documentId})`)
  markChapterRefinementStatus(context, row.id, 'processing')

  const refined = await refineChapter(row)

  if (refined) {
    saveRefinedChapter(context, row.id, JSON.stringify(refined), 'done')
    log(`[${index}/${total}] done ✓ chapter ${row.id}`)
    eventCallback?.({
      documentId: row.documentId,
      chapterId: row.id,
      refinedContent: refined,
      status: 'done',
    })
  } else {
    saveRefinedChapter(context, row.id, row.contentJson, 'failed')
    log(`[${index}/${total}] failed ✗ chapter ${row.id} — keeping original content`)
    eventCallback?.({
      documentId: row.documentId,
      chapterId: row.id,
      refinedContent: JSON.parse(row.contentJson) as ReaderBlock[],
      status: 'failed',
    })
  }
}

async function runQueue(context: DatabaseContext): Promise<void> {
  const rows = getPendingRefinementChapters(context)
  if (rows.length === 0) {
    log('queue empty, nothing to refine')
    return
  }

  log(`starting refinement queue: ${rows.length} chapters, concurrency=${CONCURRENCY}`)

  let completed = 0
  const total = rows.length

  // Process in batches of CONCURRENCY
  for (let i = 0; i < rows.length && !shouldStop; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map((row) => {
        completed++
        return processChapter(context, row, completed, total)
      }),
    )
    log(`batch done — ${Math.min(i + CONCURRENCY, total)}/${total} chapters processed`)
  }

  log(`refinement queue complete — ${total} chapters processed`)
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startRefinementWorker(context: DatabaseContext): void {
  if (isRunning) {
    log('worker already running')
    return
  }
  isRunning = true
  shouldStop = false
  log('worker started')

  // Run in background — don't await
  void runQueue(context).finally(() => {
    isRunning = false
    log('worker stopped')
  })
}

export function stopRefinementWorker(): void {
  log('stop requested')
  shouldStop = true
}

export function queueDocumentForRefinement(context: DatabaseContext, documentId: string): void {
  log(`queuing document ${documentId} for refinement`)
  resetDocumentRefinement(context, documentId)

  if (!isRunning) {
    startRefinementWorker(context)
  } else {
    log('worker already running — new chapters will be picked up in next batch')
  }
}
