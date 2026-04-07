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
    <div className="fixed top-10 right-6 z-[9999] pointer-events-none w-[min(460px,calc(100vw-48px))]">
      <div className="flex items-center gap-1.5 h-10 px-3 bg-[#0a0a0a] border border-border-medium shadow-[0_6px_24px_rgba(0,0,0,0.8)] pointer-events-auto">
        <SearchIcon size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-text-muted" />
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
          <span className="shrink-0 text-[0.72rem] text-text-muted whitespace-nowrap px-1 tabular-nums">
            {searchResultIndex + 1}/{searchResults.length}
          </span>
        ) : searchQuery ? (
          <span className="shrink-0 text-[0.72rem] text-text-faint whitespace-nowrap px-1">No results</span>
        ) : null}
        <Button
          variant="icon"
          size="sm"
          className="shrink-0 border border-border-subtle text-sm disabled:opacity-30"
          onClick={() => onNavigate(-1)}
          disabled={searchResults.length === 0}
          aria-label="Previous result"
        >
          ↑
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="shrink-0 border border-border-subtle text-sm disabled:opacity-30"
          onClick={() => onNavigate(1)}
          disabled={searchResults.length === 0}
          aria-label="Next result"
        >
          ↓
        </Button>
        <Button
          variant="icon"
          size="sm"
          className="shrink-0"
          onClick={onClose}
          aria-label="Close search"
        >
          <XIcon size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
