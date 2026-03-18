import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { Ollama } from "ollama";
import type { DatabaseContext } from "./database";
import {
  getPendingRefinementChapters,
  saveRefinedChapter,
  markChapterRefinementStatus,
  isDocumentFullyRefined,
  forceResetDocumentRefinement,
  getAllChapterRowsForDocument,
  updateDocumentToc,
  type ChapterRefinementRow,
} from "./database";
import { getOllamaBaseUrl, OLLAMA_MODEL } from "./ollama";
import type { AppSettings, ReaderBlock, ChapterRefinementUpdate } from "../src/types";
import { markdownToBlocks, createId, buildToc } from "../src/content";

// ── LLM call abstraction ──────────────────────────────────────────────────────

async function callLlm(
  settings: AppSettings,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const provider = settings.refinementProvider;

  if (provider === "local") {
    // Ollama path
    const client = new Ollama({ host: getOllamaBaseUrl() });
    const response = await client.chat({
      model: OLLAMA_MODEL,
      stream: false,
      think: false,
      options: { temperature: 0.7, num_predict: 8192 },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });
    return (response.message.content ?? "").trim();
  }

  // Cloud path via ai-sdk
  const apiKey = settings.refinementApiKey ?? "";
  const model = settings.refinementModel;

  let languageModel;
  if (provider === "google") {
    languageModel = createGoogleGenerativeAI({ apiKey })(model);
  } else if (provider === "openai") {
    languageModel = createOpenAI({ apiKey })(model);
  } else if (provider === "anthropic") {
    languageModel = createAnthropic({ apiKey })(model);
  } else {
    throw new Error(`Unknown refinement provider: ${String(provider)}`);
  }

  const { text } = await generateText({
    model: languageModel,
    system: systemPrompt,
    prompt: userMessage,
    maxOutputTokens: 8192,
    temperature: 0.7,
  });
  return text.trim();
}

type RefinementEventCallback = (update: ChapterRefinementUpdate) => void;

let eventCallback: RefinementEventCallback | null = null;
let isRunning = false;
let shouldStop = false;
let activeAbortController: AbortController | null = null;

export function setRefinementEventCallback(cb: RefinementEventCallback) {
  eventCallback = cb;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a text formatting assistant. You receive plain text extracted from a PDF and must reformat it as clean, readable Markdown.

Rules:
- Merge lines that were split mid-sentence by PDF line breaks into full paragraphs
- Fix hyphenation artifacts where a word is split across lines (e.g. "for-\\nmat" → "format")
- Use ## for section headings and ### for sub-sections — NEVER use **bold** as a substitute for a heading
- If a heading text already appears at the start of the following paragraph, remove the duplicate from the paragraph body
- Use - for bullet lists, > for block quotes, \`\`\`lang for code blocks — always include the language identifier (e.g. \`\`\`python, \`\`\`rust, \`\`\`javascript, \`\`\`c, \`\`\`cpp, \`\`\`java, \`\`\`bash, \`\`\`text if unknown)
- Convert any mathematical equations or formulas to LaTeX: inline math as $...$ and block equations as $$...$$

Code block rules:
- Any lines that look like source code (keywords, operators, indentation patterns, function calls, type annotations) MUST be wrapped in a fenced code block with the correct language tag
- Fix code that was mangled by PDF extraction: restore proper indentation using spaces, rejoin lines that were broken mid-statement (e.g. a line ending with an operator, open bracket, or comma should be joined with the next line), and remove any line numbers or column-ruler characters that were captured from the PDF
- Inline identifiers, function names, keywords, and short code snippets within prose should use backtick inline code: \`like_this\`
- Do NOT rewrite, simplify, or alter the logic of any code — only fix formatting and structure

Multi-column PDF artifacts:
- PDFs are often extracted column-by-column, so you may see sentences from the LEFT column immediately followed by sentences from the RIGHT column, interleaved in a confusing order. Reconstruct the correct logical reading order by identifying which sentence fragments belong together.
- Bullet points extracted from multi-column PDFs often appear with only a few words per line — merge these fragments into proper complete bullet items.

Footnotes and captions:
- Lines that start with a superscript number or a small number followed by text (e.g. "1 Changes are needed...") are footnotes. Move them to the very end of the section as a ## Notes block, formatted as a numbered list.
- Lines that match "Figure N:" or "Table N:" patterns are captions. Keep them in place but format as _Figure N: description_ (italic).
- Copyright/attribution lines (e.g. "Copyright © ...") should be placed at the end as a > blockquote.

Do NOT:
- Summarize, rephrase, add, or remove any content
- Merge distinct paragraphs — only merge broken/split ones
- Return explanations, JSON, or any wrapper — ONLY the clean Markdown text`;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(...args: unknown[]) {
  console.log("[refinement]", ...args);
}

// ── Block word count ──────────────────────────────────────────────────────────

function countWords(blocks: ReaderBlock[]): number {
  let count = 0;
  for (const b of blocks) {
    if (b.text) count += b.text.split(/\s+/).filter(Boolean).length;
    if (b.items) count += b.items.join(" ").split(/\s+/).filter(Boolean).length;
  }
  return count;
}

// ── Serialise blocks → plain text (skipping images) ──────────────────────────

function blocksToPlainText(blocks: ReaderBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === "image") continue;
    if (b.type === "heading") {
      const hashes = "#".repeat(Math.max(1, Math.min(b.level ?? 2, 6)));
      lines.push(`${hashes} ${b.text ?? ""}`);
    } else if (b.type === "list") {
      for (const item of b.items ?? []) lines.push(`- ${item}`);
    } else if (b.type === "quote") {
      lines.push(`> ${b.text ?? ""}`);
    } else if (b.type === "code") {
      lines.push(`\`\`\`${b.language ?? ""}`);
      lines.push(b.text ?? "");
      lines.push("```");
    } else if (b.type === "math") {
      lines.push("$$");
      lines.push(b.text ?? "");
      lines.push("$$");
    } else if (b.type === "table") {
      lines.push(b.text ?? "");
    } else {
      lines.push(b.text ?? "");
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── Section splitting ─────────────────────────────────────────────────────────
// A section is a heading block (optional) + all non-heading blocks that follow
// it, stopping just before the next heading. Image blocks are kept in-place.
// Sections are also capped at MAX_SECTION_WORDS to keep model input manageable.

const MAX_SECTION_WORDS = 600;

interface Section {
  blocks: ReaderBlock[]; // full original blocks (heading + body + images)
  textBlocks: ReaderBlock[]; // non-image blocks only (what we send to model)
  imageBlocks: ReaderBlock[]; // image blocks with their position among text blocks
  imagePosAfter: number[]; // index in textBlocks AFTER which each image sits
}

function blockWords(block: ReaderBlock): number {
  if (block.text) return block.text.split(/\s+/).filter(Boolean).length;
  if (block.items)
    return block.items.join(" ").split(/\s+/).filter(Boolean).length;
  return 0;
}

function buildSection(blocks: ReaderBlock[]): Section {
  const textBlocks = blocks.filter((b) => b.type !== "image");
  const imageBlocks: ReaderBlock[] = [];
  const imagePosAfter: number[] = [];

  let textIdx = 0;
  for (const b of blocks) {
    if (b.type === "image") {
      imageBlocks.push(b);
      imagePosAfter.push(textIdx);
    } else {
      textIdx++;
    }
  }

  return { blocks, textBlocks, imageBlocks, imagePosAfter };
}

function splitIntoSections(blocks: ReaderBlock[]): Section[] {
  const sections: Section[] = [];
  let current: ReaderBlock[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length === 0) return;
    sections.push(buildSection(current));
    current = [];
    currentWords = 0;
  };

  for (const block of blocks) {
    const isHeading = block.type === "heading";
    const words = blockWords(block);

    // A heading or exceeding the word cap starts a new section
    if (
      (isHeading && current.length > 0) ||
      (currentWords + words > MAX_SECTION_WORDS &&
        current.length > 0 &&
        !isHeading)
    ) {
      flush();
    }
    current.push(block);
    currentWords += words;
  }
  flush();

  return sections;
}

// ── Re-merge images into refined text blocks ──────────────────────────────────

function remergeImages(
  section: Section,
  refinedText: ReaderBlock[],
): ReaderBlock[] {
  if (section.imageBlocks.length === 0) return refinedText;

  const origTextLen = section.textBlocks.length;
  const result: ReaderBlock[] = [];
  let refinedIdx = 0;

  for (let i = 0; i < section.imageBlocks.length; i++) {
    const img = section.imageBlocks[i];
    const posAfter = section.imagePosAfter[i];
    // Scale position proportionally to the refined text length
    const insertAfter =
      origTextLen === 0
        ? 0
        : Math.round((posAfter / origTextLen) * refinedText.length);

    while (refinedIdx < insertAfter && refinedIdx < refinedText.length) {
      result.push(refinedText[refinedIdx++]);
    }
    result.push(img);
  }

  while (refinedIdx < refinedText.length) {
    result.push(refinedText[refinedIdx++]);
  }

  return result;
}

// ── Refine one section ────────────────────────────────────────────────────────

async function refineSection(
  chapterId: string,
  section: Section,
  sectionIdx: number,
  signal: AbortSignal,
  settings: AppSettings,
): Promise<ReaderBlock[]> {
  // Sections with no text content (image-only) — return as-is
  if (section.textBlocks.length === 0) return section.blocks;

  const plainText = blocksToPlainText(section.textBlocks);

  try {
    const raw = await callLlm(
      settings,
      SYSTEM_PROMPT,
      `Here is PDF-extracted text (may have multi-column interleaving, split lines, footnote numbers, hyphenation artifacts). Reformat as clean Markdown:\n\n${plainText}`,
    );

    if (signal.aborted) return section.blocks;
    if (!raw) return section.blocks;

    const markdown = raw
      .replace(/^```(?:markdown)?\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();
    const refinedText = markdownToBlocks(markdown);
    if (refinedText.length === 0) return section.blocks;

    // Re-attach original IDs to preserve highlight/bookmark references
    for (
      let i = 0;
      i < Math.min(section.textBlocks.length, refinedText.length);
      i++
    ) {
      if (section.textBlocks[i].id)
        refinedText[i].id = section.textBlocks[i].id;
    }
    for (let i = section.textBlocks.length; i < refinedText.length; i++) {
      refinedText[i].id = createId("ref");
    }

    return remergeImages(section, refinedText);
  } catch (err) {
    if (signal.aborted) return section.blocks;
    log(`    section ${sectionIdx} of ${chapterId}: error — ${String(err)}`);
    return section.blocks;
  }
}

// ── Group consecutive short chapters so nothing gets skipped ─────────────────
// Rows within the same document are merged until the combined word count
// reaches MIN_GROUP_WORDS (400) or a row is already big enough on its own.
// Each group is processed as a single LLM call.

const MIN_GROUP_WORDS = 400;

function groupChapterRows(rows: ChapterRefinementRow[]): ChapterRefinementRow[][] {
  const groups: ChapterRefinementRow[][] = [];
  let current: ChapterRefinementRow[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      currentWords = 0;
    }
  };

  for (const row of rows) {
    const blocks: ReaderBlock[] = JSON.parse(row.contentJson) as ReaderBlock[];
    const words = countWords(blocks);

    // Different document — always start a new group
    if (current.length > 0 && row.documentId !== current[0].documentId) {
      flush();
    }

    current.push(row);
    currentWords += words;

    // Flush once we have enough words
    if (currentWords >= MIN_GROUP_WORDS) {
      flush();
    }
  }

  flush();
  return groups;
}

// ── Refine a group of chapter rows as one combined LLM pass ───────────────────

async function refineGroup(
  group: ChapterRefinementRow[],
  signal: AbortSignal,
  settings: AppSettings,
): Promise<ReaderBlock[][] | null> {
  // Combine all blocks across the group
  const allBlocks: ReaderBlock[] = group.flatMap(
    (row) => JSON.parse(row.contentJson) as ReaderBlock[],
  );
  const wordCount = countWords(allBlocks);
  const ids = group.map((r) => r.id).join(", ");

  const sections = splitIntoSections(allBlocks);
  const t0 = Date.now();
  log(
    `  →     group [${ids}] | ${wordCount} words | ${allBlocks.length} blocks | ${sections.length} sections`,
  );

  // Refine all sections in parallel
  const refinedSections = await Promise.all(
    sections.map((section, idx) =>
      refineSection(group[0].id, section, idx, signal, settings),
    ),
  );

  if (signal.aborted) return null;

  const refined = refinedSections.flat();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    `  ✓     group [${ids}] | ${elapsed}s | ${allBlocks.length} → ${refined.length} blocks`,
  );

  // Split refined blocks back into per-chapter slices proportional to original sizes
  const originalSizes = group.map(
    (row) => (JSON.parse(row.contentJson) as ReaderBlock[]).length,
  );
  const totalOriginal = originalSizes.reduce((a, b) => a + b, 0);
  const result: ReaderBlock[][] = [];
  let offset = 0;

  for (let i = 0; i < group.length; i++) {
    const isLast = i === group.length - 1;
    if (isLast) {
      result.push(refined.slice(offset));
    } else {
      const share = Math.max(
        1,
        Math.round((originalSizes[i] / totalOriginal) * refined.length),
      );
      result.push(refined.slice(offset, offset + share));
      offset += share;
    }
  }

  return result;
}

// ── Queue processor ───────────────────────────────────────────────────────────

const CONCURRENCY = 4;

async function processGroup(
  context: DatabaseContext,
  group: ChapterRefinementRow[],
  index: number,
  total: number,
  signal: AbortSignal,
  settings: AppSettings,
): Promise<void> {
  if (shouldStop || signal.aborted) return;

  for (const row of group) {
    log(`[${index}/${total}] processing chapter ${row.id} (doc ${row.documentId})`);
    markChapterRefinementStatus(context, row.id, "processing");
  }

  let refinedPerChapter: ReaderBlock[][] | null = null;
  try {
    refinedPerChapter = await refineGroup(group, signal, settings);
  } catch (err) {
    log(`  group error — ${String(err)}`);
  }

  if (signal.aborted) return;

  for (let i = 0; i < group.length; i++) {
    const row = group[i];
    const refined = refinedPerChapter?.[i] ?? null;

    if (refined && refined.length > 0) {
      saveRefinedChapter(context, row.id, JSON.stringify(refined), "done");
      log(`[${index}/${total}] done ✓ chapter ${row.id}`);
      eventCallback?.({
        documentId: row.documentId,
        chapterId: row.id,
        refinedContent: refined,
        status: "done",
      });
    } else {
      const original = JSON.parse(row.contentJson) as ReaderBlock[];
      saveRefinedChapter(context, row.id, row.contentJson, "failed");
      log(`[${index}/${total}] failed ✗ chapter ${row.id} — keeping original content`);
      eventCallback?.({
        documentId: row.documentId,
        chapterId: row.id,
        refinedContent: original,
        status: "failed",
      });
    }
  }

  // After saving all chapters in this group, check if the whole document is done
  // and if so, rebuild + persist the TOC from the refined content
  const documentId = group[0].documentId;
  rebuildDocumentTocIfComplete(context, documentId);
}

function rebuildDocumentTocIfComplete(context: DatabaseContext, documentId: string): void {
  const allRows = getAllChapterRowsForDocument(context, documentId);
  const allDone = allRows.every((r) => r.refinedContentJson !== null);
  if (!allDone) return;

  const chapters = allRows.map((r) => ({
    id: r.id,
    title: r.title,
    content: JSON.parse(r.refinedContentJson ?? r.contentJson) as ReaderBlock[],
    outlineDepth: r.outlineDepth,
  }));

  const toc = buildToc(chapters);
  updateDocumentToc(context, documentId, toc);
  log(`rebuilt TOC for document ${documentId} (${toc.length} items)`);
}

async function runQueue(
  context: DatabaseContext,
  signal: AbortSignal,
  settings: AppSettings,
): Promise<void> {
  const rows = getPendingRefinementChapters(context);
  if (rows.length === 0) {
    log("queue empty, nothing to refine");
    return;
  }

  const groups = groupChapterRows(rows);
  log(
    `starting refinement queue: ${rows.length} chapters → ${groups.length} groups, concurrency=${CONCURRENCY}, provider=${settings.refinementProvider}, model=${settings.refinementModel}`,
  );

  let completed = 0;
  const total = rows.length;

  // Process groups in batches of CONCURRENCY
  for (
    let i = 0;
    i < groups.length && !shouldStop && !signal.aborted;
    i += CONCURRENCY
  ) {
    const batch = groups.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((group) => {
        completed += group.length;
        return processGroup(context, group, completed, total, signal, settings);
      }),
    );
    log(
      `batch done — ${Math.min(completed, total)}/${total} chapters processed`,
    );
  }

  log(`refinement queue complete — ${total} chapters processed`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startRefinementWorker(context: DatabaseContext, settings: AppSettings): void {
  if (isRunning) {
    log("worker already running");
    return;
  }
  isRunning = true;
  shouldStop = false;
  activeAbortController = new AbortController();
  log("worker started");

  const { signal } = activeAbortController;

  // Run in background — don't await
  void runQueue(context, signal, settings).finally(() => {
    isRunning = false;
    activeAbortController = null;
    log("worker stopped");
  });
}

export function stopRefinementWorker(): void {
  log("stop requested");
  shouldStop = true;
  activeAbortController?.abort();
  activeAbortController = null;
}

// Force a full re-run regardless of current status — used by the manual "rerun" action in Settings.
export function forceRequeueDocument(
  context: DatabaseContext,
  documentId: string,
  settings: AppSettings,
): void {
  log(`force-requeueing document ${documentId}`);
  forceResetDocumentRefinement(context, documentId);

  if (!isRunning) {
    startRefinementWorker(context, settings);
  } else {
    log("worker already running — reset chapters will be picked up in next batch");
  }
}

export function queueDocumentForRefinement(
  context: DatabaseContext,
  documentId: string,
  settings: AppSettings,
): void {
  // Skip if all chapters are already refined — prevents re-running on app restart
  // or duplicate import calls. Only the explicit rerunRefinement path should force a reset.
  if (isDocumentFullyRefined(context, documentId)) {
    log(`document ${documentId} already fully refined — skipping`);
    return;
  }

  log(`queuing document ${documentId} for refinement`);

  if (!isRunning) {
    startRefinementWorker(context, settings);
  } else {
    log(
      "worker already running — new chapters will be picked up in next batch",
    );
  }
}
