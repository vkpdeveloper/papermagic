import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const electronRuntimeDependencies = [
  '@hyzyla/pdfium',
  'better-sqlite3',
  'drizzle-orm',
  'drizzle-orm/better-sqlite3',
  'fast-xml-parser',
  'jszip',
  'linkedom',
  'mupdf',
  'web-tree-sitter',
]

// https://vitejs.dev/config/
export default defineConfig({
  // Multi-page renderer build: main app + hidden PDF extractor window.
  // This ensures src/pdf-extractor-worker.ts is bundled by Vite so
  // bare module imports (e.g. 'extract2md') resolve correctly at runtime.
  build: {
    rollupOptions: {
      input: {
        index: path.join(__dirname, 'index.html'),
        'pdf-extractor': path.join(__dirname, 'pdf-extractor.html'),
      },
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    ...electron([
      {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: electronRuntimeDependencies,
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
      },
      {
        entry: 'electron/pdf-extractor-preload.ts',
      },
    ]),
    // Polyfill the Electron and Node.js API for Renderer process.
    // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
    // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
    ...(process.env.NODE_ENV === 'test'
      // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
      ? []
      : [renderer()]),
  ],
})
