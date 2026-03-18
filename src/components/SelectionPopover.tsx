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
    <button
      className="fixed z-[32] -translate-x-1/2 -translate-y-full px-3 py-2 border border-border-strong bg-[#000] text-text-primary font-semibold cursor-pointer"
      style={{ left: x, top: y }}
      onClick={onClick}
    >
      Highlight
    </button>
  )
}
