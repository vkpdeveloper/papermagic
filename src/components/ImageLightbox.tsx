import { X as XIcon } from 'lucide-react'
import { Button } from './ui/Button'

interface ImagePreviewState {
  src: string
  alt: string
  caption?: string
}

export function ImageLightbox({
  image,
  onClose,
}: {
  image: ImagePreviewState
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[36] grid place-items-center p-7 bg-black/[0.92] max-sm:p-5"
      onClick={onClose}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="absolute top-6 right-6 max-sm:top-4 max-sm:right-4 bg-black/80"
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <XIcon size={18} strokeWidth={2} aria-hidden="true" />
        <span>Close</span>
      </Button>
      <figure
        className="m-0 max-w-[min(92vw,1280px)] max-h-[86vh]"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={image.src}
          alt={image.alt}
          className="block max-w-full max-h-[80vh] object-contain"
        />
        {image.caption ? (
          <figcaption className="mt-3 text-text-muted text-center">{image.caption}</figcaption>
        ) : null}
      </figure>
    </div>
  )
}
