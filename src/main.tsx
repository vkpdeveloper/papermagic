import React from 'react'
import ReactDOM from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { Toaster } from 'sonner'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/poppins/500.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import App from './App.tsx'
import './index.css'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HotkeysProvider
      defaultOptions={{
        hotkey: {
          preventDefault: true,
          stopPropagation: true,
        },
        hotkeySequence: {
          preventDefault: true,
          stopPropagation: true,
          timeout: 900,
        },
      }}
    >
      <App />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#111',
            border: '1px solid #222',
            color: '#e8e8e8',
            fontFamily: 'var(--font-ui, Inter, sans-serif)',
            fontSize: '13px',
            borderRadius: '6px',
          },
        }}
      />
    </HotkeysProvider>
  </React.StrictMode>,
)
