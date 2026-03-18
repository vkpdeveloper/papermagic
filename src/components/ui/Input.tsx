import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

// ─── Base Input ───────────────────────────────────────────────────────────────

type InputSize = 'sm' | 'md' | 'lg'
type InputVariant = 'default' | 'ghost' | 'mono'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  /** Visual size of the input */
  size?: InputSize
  /** Style variant */
  variant?: InputVariant
  /** Optional icon/element rendered on the left inside the input */
  prefix?: ReactNode
  /** Optional icon/element rendered on the right inside the input */
  suffix?: ReactNode
  /** Additional class names applied to the outer wrapper (only used when prefix/suffix present) */
  wrapperClassName?: string
}

const sizeClasses: Record<InputSize, string> = {
  sm: 'min-h-8 px-3 text-xs',
  md: 'min-h-10 px-4 text-sm',
  lg: 'min-h-14 px-4 text-sm',
}

const variantClasses: Record<InputVariant, string> = {
  default: 'bg-[#040404] border border-border-strong text-text-primary placeholder:text-text-muted',
  ghost:   'bg-transparent border-0 text-text-primary placeholder:text-text-muted',
  mono:    'bg-[#050505] border border-border-strong text-text-primary font-mono placeholder:text-text-muted',
}

/**
 * Reusable `<Input>` primitive.
 *
 * Variants: `default` | `ghost` | `mono`
 * Sizes:    `sm` | `md` | `lg`
 *
 * Pass `prefix` / `suffix` for icon decorators — they are rendered inside an
 * outer wrapper div so that the input still fills the available width.
 *
 * @example
 * <Input placeholder="Search…" size="lg" />
 * <Input variant="mono" type="password" size="md" prefix={<KeyIcon size={13} />} />
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    variant = 'default',
    prefix,
    suffix,
    className = '',
    wrapperClassName = '',
    ...props
  },
  ref,
) {
  const base =
    'w-full outline-none transition-[border-color] duration-150 font-[inherit] disabled:opacity-50 disabled:cursor-not-allowed'

  const inputEl = (
    <input
      ref={ref}
      className={`${base} ${sizeClasses[size]} ${variantClasses[variant]} ${prefix || suffix ? 'px-0 min-h-0 bg-transparent border-0' : ''} ${className}`}
      {...props}
    />
  )

  if (!prefix && !suffix) return inputEl

  // Wrapper mode — the border / background lives on the wrapper
  const wrapperSize: Record<InputSize, string> = {
    sm: 'min-h-8 px-3 gap-2',
    md: 'min-h-10 px-3 gap-2.5',
    lg: 'min-h-14 px-4 gap-[10px]',
  }

  const wrapperVariant: Record<InputVariant, string> = {
    default: 'bg-[#040404] border border-border-strong',
    ghost:   'bg-transparent border-0',
    mono:    'bg-[#050505] border border-border-strong',
  }

  return (
    <div
      className={`flex items-center ${wrapperSize[size]} ${wrapperVariant[variant]} ${wrapperClassName}`}
    >
      {prefix ? (
        <span className="shrink-0 text-text-muted flex items-center">{prefix}</span>
      ) : null}
      <input
        ref={ref}
        className={`flex-1 min-w-0 p-0 bg-transparent border-0 outline-none font-[inherit] text-text-primary placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed ${size === 'sm' ? 'text-xs' : 'text-sm'} ${variant === 'mono' ? 'font-mono' : ''} ${className}`}
        {...props}
      />
      {suffix ? (
        <span className="shrink-0 text-text-muted flex items-center">{suffix}</span>
      ) : null}
    </div>
  )
})
