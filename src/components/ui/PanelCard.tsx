export function PanelCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-border-subtle bg-[#000] ${className}`}>
      {children}
    </div>
  )
}
