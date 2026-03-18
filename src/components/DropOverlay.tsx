export function DropOverlay() {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/[0.92]">
      <div className="w-[min(520px,calc(100vw-40px))] p-7 border border-border-strong bg-[#000] text-center">
        <span className="block mb-[10px] text-[1.05rem] font-semibold">
          Drop files to import into Paper Magic
        </span>
        <p className="m-0 text-text-muted">
          PDF, EPUB, HTML, Markdown, and text files are normalized into the same reading surface.
        </p>
      </div>
    </div>
  )
}
