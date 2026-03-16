# Paper Magic

Offline-first desktop reader for PDFs, EPUBs, and saved web pages.

Paper Magic normalizes every source into one shared reading model so the library and reader stay consistent across formats. The app uses Electron, React, SQLite, and Drizzle, and stores documents, progress, bookmarks, highlights, and extracted web content locally.

## Features

- Import local `PDF`, `EPUB`, `HTML`, `Markdown`, and text files
- Save web articles from a URL using the `@steipete/summarize` CLI extraction pipeline
- Unified dark-mode reader with scroll mode and page mode
- Persistent reading progress, highlights, bookmarks, and reader preferences
- Offline-first local library backed by SQLite

## Development

```bash
npm install
npm run build
```

For local development:

```bash
npm run dev
```

## Packaging

Production builds are created with Electron Builder:

```bash
npm run build
```

The packaged output is written to `release/`.
