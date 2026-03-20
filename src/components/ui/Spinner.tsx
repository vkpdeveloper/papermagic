import { LoaderIcon } from 'lucide-react'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <LoaderIcon
      role="status"
      aria-label="Loading"
      className={['size-4 animate-spin', className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}

export { Spinner }
