import type { RefObject } from 'react'
import { Search as SearchIcon, X as XIcon } from 'lucide-react'

export function ReaderSearchBar({
  searchQuery,
  searchResults,
  searchResultIndex,
  onQueryChange,
  onNavigate,
  onClose,
  inputRef,
}: {
  searchQuery: string
  searchResults: Array<unknown>
  searchResultIndex: number
  onQueryChange: (query: string) => void
  onNavigate: (delta: number) => void
  onClose: () => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none w-[min(540px,calc(100vw-48px))]">
      <div className="flex items-center gap-1.5 h-11 px-3 bg-[#111] border border-[#2a2a2a] rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.6)] pointer-events-auto">
        <SearchIcon size={15} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-text-muted" />
        <input
          ref={inputRef as RefObject<HTMLInputElement>}
          className="flex-1 min-w-0 bg-transparent border-0 text-text-primary font-[inherit] text-sm outline-none placeholder:text-text-muted"
          value={searchQuery}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              inputRef.current?.blur()
              if (searchResults.length > 0) {
                onNavigate(event.shiftKey ? -1 : 1)
              }
            }
          }}
          placeholder="Search document…"
          autoFocus
        />
        {searchResults.length > 0 ? (
          <span className="shrink-0 text-xs text-text-muted whitespace-nowrap px-1">
            {searchResultIndex + 1}/{searchResults.length}
          </span>
        ) : searchQuery ? (
          <span className="shrink-0 text-xs text-white/30 whitespace-nowrap px-1">No results</span>
        ) : null}
        <button
          className="shrink-0 flex items-center justify-center w-7 h-7 bg-white/[0.04] border border-[#222] rounded text-text-secondary text-sm cursor-pointer transition-[background,color] duration-[120ms] disabled:opacity-30 disabled:cursor-default hover:not-disabled:bg-white/[0.08] hover:not-disabled:text-text-primary"
          onClick={() => onNavigate(-1)}
          disabled={searchResults.length === 0}
          aria-label="Previous result"
        >
          ↑
        </button>
        <button
          className="shrink-0 flex items-center justify-center w-7 h-7 bg-white/[0.04] border border-[#222] rounded text-text-secondary text-sm cursor-pointer transition-[background,color] duration-[120ms] disabled:opacity-30 disabled:cursor-default hover:not-disabled:bg-white/[0.08] hover:not-disabled:text-text-primary"
          onClick={() => onNavigate(1)}
          disabled={searchResults.length === 0}
          aria-label="Next result"
        >
          ↓
        </button>
        <button
          className="shrink-0 flex items-center justify-center w-7 h-7 bg-transparent border-0 rounded text-text-muted cursor-pointer transition-[background,color] duration-[120ms] hover:bg-white/[0.06] hover:text-text-primary"
          onClick={onClose}
          aria-label="Close search"
        >
          <XIcon size={15} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
