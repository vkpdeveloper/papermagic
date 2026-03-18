import * as RadixTooltip from '@radix-ui/react-tooltip'

interface TooltipProps {
  children: React.ReactNode
  content: React.ReactNode
  shortcut?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
}

export function Tooltip({ children, content, shortcut, side = 'bottom', sideOffset = 6 }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={400}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={sideOffset}
          className="z-[9999] flex items-center gap-2 px-[10px] py-[6px] bg-[#1a1a1a] border border-white/[0.12] text-text-primary text-[0.72rem] tracking-[0.04em] shadow-[0_4px_16px_rgba(0,0,0,0.5)] select-none animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1"
        >
          <span>{content}</span>
          {shortcut ? (
            <kbd className="inline-flex items-center gap-0.5 px-[6px] py-[2px] bg-white/[0.08] border border-white/[0.12] text-text-muted text-[0.68rem] font-mono tracking-normal">
              {shortcut}
            </kbd>
          ) : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <RadixTooltip.Provider>{children}</RadixTooltip.Provider>
}
