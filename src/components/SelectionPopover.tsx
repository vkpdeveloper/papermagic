import { Button } from './ui/Button'

export function SelectionPopover({
  x,
  y,
  onClick,
}: {
  x: number
  y: number
  onClick: () => void
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="fixed z-[32] -translate-x-1/2 -translate-y-full font-semibold"
      style={{ left: x, top: y }}
      onClick={onClick}
    >
      Highlight
    </Button>
  )
}
