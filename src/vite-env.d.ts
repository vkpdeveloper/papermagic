/// <reference types="vite/client" />

import type { PaperMagicApi } from './types'

declare global {
  interface Window {
    paperMagic: PaperMagicApi
  }
}

export {}
