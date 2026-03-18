import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon'
}

export function Button({ variant = 'primary', className = '', children, ...props }: ButtonProps) {
  const base = 'min-h-14 px-[18px] rounded-none transition-[border-color,background,color] duration-[160ms] ease-in-out border-0 font-[inherit] cursor-pointer'

  const variants: Record<string, string> = {
    primary: `${base} bg-text-primary text-[#000] font-bold`,
    secondary: `${base} bg-[#000] text-text-primary border border-border-strong`,
    ghost: `${base} bg-transparent text-text-secondary border border-border-subtle`,
    danger: `${base} bg-[#c0392b] text-white font-bold hover:bg-[#a93226]`,
    icon: 'inline-flex items-center justify-center w-10 h-10 min-h-0 p-0 rounded-none border-0 font-[inherit] cursor-pointer',
  }

  return (
    <button className={`${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}

export function ButtonInner({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center justify-center gap-2">{children}</span>
}
