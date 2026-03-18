import * as RadixDialog from '@radix-ui/react-dialog'
import { X as XIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
}

export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/[0.88] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <RadixDialog.Content className="fixed top-1/2 left-1/2 z-[51] w-[min(600px,calc(100vw-40px))] max-h-[min(calc(100vh-80px),760px)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 border border-border-strong bg-[#000] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-7 pt-7 pb-5 border-b border-border-subtle">
            <div>
              <RadixDialog.Title className="m-0 text-[1.35rem] font-display font-bold leading-[1.05] tracking-[-0.03em]">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="m-0 mt-1.5 text-sm text-text-muted">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close
              className="w-8 h-8 shrink-0 inline-flex items-center justify-center bg-transparent border border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary transition-colors duration-150 cursor-pointer mt-0.5"
              aria-label="Close"
            >
              <XIcon size={14} strokeWidth={1.9} />
            </RadixDialog.Close>
          </div>

          {/* Body */}
          <div className="px-7 py-6">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
