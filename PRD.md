# Product Requirements Document (PRD)

# Product Name

Paper Magic

---

# Vision

Create a **cross-platform reading application** that delivers a premium, distraction-free reading experience comparable to modern digital book platforms.

The application must allow users to read **PDFs, EPUBs, and web pages** within a **single unified reading interface**, eliminating format inconsistencies.

All content sources must be transformed into a **normalized internal document structure**, ensuring the user experiences identical UI and UX regardless of the original source format.

The application must operate **offline-first**, maintain a **local document library**, and prioritize **reading ergonomics, performance, and simplicity**.

The application supports **dark mode only**.

---

# Core Product Principles

### 1. Format Transparency

Users should never feel they are reading different file formats.

### 2. Single Reader Experience

All content types must render in the same reading engine.

### 3. Distraction-Free Reading

The interface must prioritize typography, whitespace, and focus.

### 4. Performance First

Large documents must load and scroll smoothly.

### 5. Local First

All documents, metadata, and progress are stored locally.

### 6. Dark Mode Only

No light theme support.

---

# Supported Content Sources

The system must support three primary content types.

---

# 1. PDF Documents

Imported from the local filesystem.

The system must extract:

- document text
- headings
- paragraphs
- lists
- optional images
- optional page boundaries

PDF layout information must be reconstructed into a **semantic reading structure**, avoiding rigid page-based layouts whenever possible.

---

# 2. EPUB Books

The system must extract:

- metadata
- chapters
- text
- images
- table of contents

EPUB files already contain structured content and should be mapped directly into the internal document model.

---

# 3. Web URLs

The system must support importing articles directly from URLs.

The process must follow these steps:

1. Fetch the HTML page
2. Extract the primary readable content
3. Remove navigation, advertisements, sidebars, and irrelevant elements
4. Convert the cleaned article content into **Markdown**
5. Store the resulting Markdown as a normalized document

The system must use the **Summarize CLI tool** for HTML content extraction and Markdown conversion.

Repository:

https://github.com/steipete/summarize

The extraction pipeline should function as follows:

```
URL
↓
Fetch HTML
↓
Summarize CLI extraction
↓
Markdown output
↓
Normalized document structure
```

The extraction process must preserve:

- headings
- paragraphs
- lists
- quotes
- images
- code blocks

The output Markdown must be clean, readable, and suitable for long-form reading.

---

# Content Normalization

All sources must be converted into a **unified internal document format** before rendering.

Internal structure:

```
Document
 ├ id
 ├ title
 ├ author
 ├ cover
 ├ source_type
 ├ chapters[]
 └ metadata
```

Chapter structure:

```
Chapter
 ├ id
 ├ title
 └ content
```

Content must be stored as **Markdown or semantic HTML**.

The reading interface must render **only this normalized structure**, regardless of the original source format.

---

# Application Architecture

The application contains two primary layers.

## System Layer

Responsibilities:

- filesystem access
- document parsing
- content extraction
- document normalization
- database management
- indexing and caching

## Interface Layer

Responsibilities:

- library interface
- reader interface
- navigation
- typography
- user interaction handling

---

# Primary Application Modes

The product operates in two modes:

```
Library Mode
Reader Mode
```

---

# Library Mode

## Purpose

Provide a visual gallery of all imported documents.

## Layout

Grid-based cover gallery designed for visual browsing.

Each item displays:

- cover image
- title
- reading progress

The interface should prioritize visual clarity rather than dense metadata.

---

# Library Sections

The library should support logical grouping of documents such as:

- Recently Read
- Books
- Articles
- Saved Web Pages

---

# Document Card

Each document card must include:

- cover image
- title
- reading progress indicator

If a document has no cover image, the system must **generate a cover automatically using the document title**.

---

# Reader Mode

## Purpose

Provide a clean, distraction-free reading environment.

---

# Layout

The reader layout must use a centered reading column.

```
| margin | reading column | margin |
```

Ideal reading width:

```
680px – 740px
```

Margins should scale with window size.

---

# Typography Requirements

Typography must prioritize reading comfort.

Recommended baseline:

Font size: approximately **19px**

Line height: approximately **1.7**

Paragraph spacing must be generous.

Headings must be clearly distinguishable.

Code blocks must support monospaced text rendering.

---

# Reader UI Behavior

The reading interface must remain hidden during reading.

Reader controls appear only when:

- mouse movement occurs
- the user taps the screen
- a keyboard shortcut is used

Controls include:

- return to library
- document search
- font size adjustment
- reading width adjustment
- table of contents
- bookmarks
- highlights
- reading progress

---

# Reading Modes

The system must support two reading styles.

## Scroll Mode

Continuous vertical scrolling.

Best suited for:

- articles
- web pages
- PDFs
- long-form documents

---

## Page Mode

Paginated reading with horizontal page transitions.

Best suited for:

- books
- EPUB content

---

# Table of Contents

Documents must support table of contents navigation.

If a source document includes a TOC it should be preserved.

If no TOC exists, the system must automatically generate one from document headings.

---

# Reading Progress

The system must track reading progress for each document.

Progress should be calculated using either:

- scroll position
- page index

Progress must persist between sessions.

Library cards must visually display reading progress.

---

# Highlights

Users must be able to highlight text within documents.

Highlight behavior:

1. User selects text
2. Highlight option appears
3. Highlighted text is saved locally

Highlights must store:

- document reference
- highlighted text
- location in document

Highlights must persist between sessions.

---

# Bookmarks

Users must be able to bookmark locations within a document.

Bookmark behavior:

- user saves current reading position
- bookmarks allow quick navigation to saved locations
- bookmarks may optionally include labels

Bookmarks must persist locally.

---

# Search

The reader must support full document search.

Search results must display:

- matched text
- surrounding context
- navigation between matches

---

# Performance Requirements

The application must remain responsive even for very large documents.

Performance strategies must include:

- lazy content rendering
- virtualized content display
- incremental parsing of large files
- non-blocking document processing

Scrolling must remain smooth for large documents.

---

# Document Import

Documents can be imported through:

- file open dialog
- drag and drop
- URL paste

When importing a URL, the system must automatically convert the page into a readable document using the Summarize extraction pipeline.

---

# Storage

All application data must be stored locally.

The system will use:

- **SQLite as the local database**
- **Drizzle ORM for database interaction and schema management**

For the initial version, **all storage is local-only**. No cloud synchronization is required.

Stored data includes:

- documents
- parsed document content
- document metadata
- reading progress
- highlights
- bookmarks

Example logical data model:

```
documents
 ├ id
 ├ title
 ├ author
 ├ cover
 ├ source_type
 ├ created_at

chapters
 ├ id
 ├ document_id
 ├ title
 ├ content

reading_progress
 ├ document_id
 ├ progress_position

highlights
 ├ id
 ├ document_id
 ├ text
 ├ location

bookmarks
 ├ id
 ├ document_id
 ├ location
 ├ label
```

Documents should be indexed to allow fast retrieval and search.

---

# Offline Behavior

All previously imported content must remain accessible offline.

Web pages imported through URLs must be cached locally after extraction.

---

# Keyboard Shortcuts

The reader must support keyboard navigation.

Examples:

```
j → scroll down
k → scroll up
space → next page
ctrl/cmd + f → search
ctrl/cmd + t → open table of contents
```

---

# Dark Mode Theme

The application must support **dark mode only**.

Design characteristics:

Background must be near-black.

Primary text must be soft light gray.

Secondary text should be muted gray.

Suggested palette:

```
Background: near black or deep charcoal
Primary text: light gray
Secondary text: muted gray
Accent: subtle neutral highlight
```

Pure white text should be avoided to reduce eye strain.

---

# Motion and Interaction

Animations must be subtle and responsive.

Recommended animation duration:

```
150ms – 250ms
```

Animations include:

- opening documents
- page transitions
- library navigation
- hover interactions

---

# Error Handling

The system must gracefully handle:

- malformed PDFs
- poorly structured HTML pages
- EPUB parsing errors
- network failures during URL import

If parsing fails, the system must still attempt to render readable text.

---

# Success Criteria

The product is successful if:

1. The reading experience is identical across PDFs, EPUBs, and URLs.
2. Large documents load without freezing the interface.
3. The UI remains clean and distraction-free.
4. Users can seamlessly move between library and reader.
5. Reading progress, highlights, and bookmarks persist reliably.
