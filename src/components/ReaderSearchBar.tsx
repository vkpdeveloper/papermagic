import type { RefObject } from 'react'
import { Search as SearchIcon, X as XIcon } from 'lucide-react'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

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
    <div className="fixed top-10 right-6 z-[9999] pointer-events-none w-[min(480px,calc(100vw-48px))]">
      <div className="flex items-center gap-1.5 h-11 px-3 bg-[#111] border border-[#2a2a2a] rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.6)] pointer-events-auto">
        <SearchIcon size={15} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-text-muted" />
        <Input
          ref={inputRef as RefObject<HTMLInputElement>}
          variant="ghost"
          size="sm"
          className="flex-1"
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
        <Button
          variant="icon"
          size="sm"
          className="shrink-0 bg-white/[0.04] border border-[#222] rounded text-sm disabled:opacity-30"
          onClick={() => onNavigate(-1)}
          disabled={searchResults.length === 0}
          aria-label="Previous result"
        >
          ↑
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="shrink-0 bg-white/[0.04] border border-[#222] rounded text-sm disabled:opacity-30"
          onClick={() => onNavigate(1)}
          disabled={searchResults.length === 0}
          aria-label="Next result"
        >
          ↓
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="shrink-0 rounded"
          onClick={onClose}
          aria-label="Close search"
        >
          <XIcon size={15} strokeWidth={1.9} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
