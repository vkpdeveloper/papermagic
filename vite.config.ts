import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const electronRuntimeDependencies = [
  '@hyzyla/pdfium',
  '@mendable/firecrawl-js',
  '@mozilla/readability',
  'better-sqlite3',
  'chromium-bidi',
  'devtools-protocol',
  'drizzle-orm',
  'drizzle-orm/better-sqlite3',
  'fast-xml-parser',
  'jsdom',
  'jszip',
  'linkedom',
  'mupdf',
  'playwright',
  'playwright-core',
  'turndown',
  'turndown-plugin-gfm',
  'undici',
  'web-tree-sitter',
]

// Preload vite config: force CJS output with .mjs extension so Electron
// can load the scripts regardless of the package.json "type": "module" setting.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const preloadViteConfig: any = {
  build: {
    lib: {
      formats: ['cjs'],
      fileName: () => '[name].mjs',
    },
  },
}

// https://vitejs.dev/config/
export default defineConfig({
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
        vite: preloadViteConfig,
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
