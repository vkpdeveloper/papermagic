import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 as Loader2Icon } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon' | 'link'
type ButtonSize    = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style of the button */
  variant?: ButtonVariant
  /** Size of the button (not applied to `icon` variant — use className for that) */
  size?: ButtonSize
  /** Shows a spinner and disables the button */
  loading?: boolean
}

// ─── Style maps ───────────────────────────────────────────────────────────────

const base =
  'inline-flex items-center justify-center rounded-none transition-[border-color,background,color,opacity] duration-[160ms] ease-in-out border-0 font-[inherit] cursor-pointer outline-none disabled:opacity-50 disabled:cursor-not-allowed'

const variantClasses: Record<ButtonVariant, string> = {
  primary:   `${base} bg-text-primary text-[#000] font-bold hover:bg-white`,
  secondary: `${base} bg-[#000] text-text-primary border border-border-strong hover:border-white/30`,
  ghost:     `${base} bg-transparent text-text-secondary border border-border-subtle hover:border-border-strong hover:text-text-primary`,
  danger:    `${base} bg-[#c0392b] text-white font-bold hover:bg-[#a93226]`,
  icon:      `${base} bg-transparent text-text-secondary hover:bg-white/[0.06] hover:text-text-primary`,
  link:      'inline-flex items-center gap-1.5 bg-transparent border-0 p-0 font-[inherit] cursor-pointer outline-none text-text-secondary hover:text-text-primary transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 text-xs gap-1.5',
  md: 'min-h-10 px-5 text-sm gap-2',
  lg: 'min-h-14 px-[18px] text-sm gap-2',
}

// Icon variant has its own fixed square sizes
const iconSizeClasses: Record<ButtonSize, string> = {
  sm: 'w-7 h-7',
  md: 'w-9 h-9',
  lg: 'w-10 h-10',
}

// ─── Button ───────────────────────────────────────────────────────────────────

/**
 * Reusable `<Button>` primitive.
 *
 * Variants: `primary` | `secondary` | `ghost` | `danger` | `icon`
 * Sizes:    `sm` | `md` | `lg`
 *
 * Pass `loading` to show a spinner and disable the button automatically.
 *
 * @example
 * <Button>Import files</Button>
 * <Button variant="secondary" size="sm">Cancel</Button>
 * <Button variant="danger" loading={isDeleting}>Delete</Button>
 * <Button variant="icon" size="sm" aria-label="Close"><XIcon size={15} /></Button>
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'lg',
    loading = false,
    className = '',
    disabled,
    children,
    ...props
  },
  ref,
) {
  const isIcon = variant === 'icon'
  const isLink = variant === 'link'
  const sizeClass = isLink ? '' : isIcon ? iconSizeClasses[size] : sizeClasses[size]

  return (
    <button
      ref={ref}
      disabled={disabled ?? loading}
      className={`${variantClasses[variant]} ${sizeClass} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2Icon
          size={isIcon || isLink ? 12 : 15}
          strokeWidth={2}
          className="animate-spin shrink-0"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </button>
  )
})

// ─── ButtonInner ──────────────────────────────────────────────────────────────

/**
 * Flex wrapper for icon + label content inside a button.
 * Use when you need to compose an icon alongside text manually.
 */
export function ButtonInner({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center justify-center gap-2">{children}</span>
}
