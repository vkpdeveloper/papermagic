import * as RadixSelect from '@radix-ui/react-select'
import { Check as CheckIcon, ChevronDown as ChevronDownIcon } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
  description?: string
}

interface SelectProps {
  value: string | undefined
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
}

export function Select({ value, onValueChange, options, placeholder = 'Select…', disabled, className }: SelectProps) {
  return (
    <RadixSelect.Root value={value ?? ''} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        className={[
          'inline-flex items-center justify-between gap-2',
          'min-h-10 px-3 py-2 w-full',
          'bg-[#0e0f11] border border-[#2a2b2e] text-text-primary text-sm',
          'hover:border-[#3a3b3e] transition-colors duration-150',
          'focus:outline-none focus:border-[#555]',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'data-[placeholder]:text-text-secondary',
          className ?? '',
        ].join(' ')}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDownIcon size={14} className="text-text-secondary shrink-0" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={[
            'z-[200] min-w-[var(--radix-select-trigger-width)]',
            'bg-[#0e0f11] border border-[#2a2b2e]',
            'overflow-hidden',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          ].join(' ')}
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                className={[
                  'relative flex items-center gap-2 px-8 py-2 text-sm text-text-primary',
                  'cursor-pointer select-none outline-none',
                  'hover:bg-white/[0.06] focus:bg-white/[0.06]',
                  'data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
                ].join(' ')}
              >
                <RadixSelect.ItemIndicator className="absolute left-2 flex items-center justify-center">
                  <CheckIcon size={12} className="text-text-primary" />
                </RadixSelect.ItemIndicator>
                <div>
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.description && (
                    <p className="text-xs text-text-secondary mt-0.5">{option.description}</p>
                  )}
                </div>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
