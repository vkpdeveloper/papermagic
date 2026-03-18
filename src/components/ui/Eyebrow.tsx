export function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`m-0 mb-[10px] uppercase tracking-[0.18em] text-[0.68rem] text-text-muted ${className}`}>
      {children}
    </p>
  )
}
