export function ProgressBar({ value }: { value: number }) {
  const width = `${Math.max(0, Math.min(100, value * 100))}%`
  return (
    <div className="h-1.5 mt-auto rounded-none bg-white/[0.08] overflow-hidden">
      <div className="h-full rounded-none bg-text-primary" style={{ width }} />
    </div>
  )
}
