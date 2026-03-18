import * as RadixContextMenu from '@radix-ui/react-context-menu'

interface ContextMenuItemProps {
  label: string
  shortcut?: string
  destructive?: boolean
  disabled?: boolean
  onSelect: () => void
}

interface ContextMenuSeparatorProps {
  type: 'separator'
}

type ContextMenuEntry = ContextMenuItemProps | ContextMenuSeparatorProps

interface ContextMenuProps {
  children: React.ReactNode
  items: ContextMenuEntry[]
}

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparatorProps {
  return 'type' in entry && entry.type === 'separator'
}

export function ContextMenu({ children, items }: ContextMenuProps) {
  return (
    <RadixContextMenu.Root>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className="z-[9999] min-w-[180px] overflow-hidden bg-[#111] border border-white/[0.1] shadow-[0_8px_32px_rgba(0,0,0,0.6)] py-1"
        >
          {items.map((item, index) => {
            if (isSeparator(item)) {
              return (
                <RadixContextMenu.Separator
                  key={index}
                  className="my-1 h-px bg-white/[0.08]"
                />
              )
            }

            return (
              <RadixContextMenu.Item
                key={index}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={`flex items-center justify-between gap-6 px-3 py-[7px] text-[0.82rem] tracking-[0.01em] cursor-pointer select-none outline-none transition-colors duration-[120ms] data-[highlighted]:bg-white/[0.08] data-[disabled]:opacity-40 data-[disabled]:cursor-default ${
                  item.destructive ? 'text-[#f3b3b3] data-[highlighted]:text-[#ffbdbd]' : 'text-text-primary'
                }`}
              >
                <span>{item.label}</span>
                {item.shortcut ? (
                  <kbd className="shrink-0 text-text-muted text-[0.72rem] font-mono tracking-normal">
                    {item.shortcut}
                  </kbd>
                ) : null}
              </RadixContextMenu.Item>
            )
          })}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  )
}
