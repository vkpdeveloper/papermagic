import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Button } from './ui'

interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
}

export function ConfirmDialog(props: {
  dialog: ConfirmDialogState
  onDismiss: () => void
}) {
  const { dialog, onDismiss } = props

  return (
    <AlertDialog.Root open onOpenChange={(open) => { if (!open) onDismiss() }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/[0.88]" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-[51] w-[min(440px,calc(100vw-40px))] p-7 border border-border-strong bg-[#000] -translate-x-1/2 -translate-y-1/2 outline-none">
          <AlertDialog.Title className="m-0 mb-[10px] uppercase tracking-[0.18em] text-[0.68rem] text-text-muted">
            {dialog.title}
          </AlertDialog.Title>
          <AlertDialog.Description className="m-0 mb-6 text-text-secondary leading-[1.6]">
            {dialog.message}
          </AlertDialog.Description>
          <div className="grid grid-cols-2 gap-[10px]">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="danger" onClick={dialog.onConfirm}>
                {dialog.confirmLabel ?? 'Confirm'}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
