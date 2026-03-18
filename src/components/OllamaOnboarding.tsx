import { useEffect, useState } from 'react'
import {
  CheckCircle2 as CheckCircleIcon,
  Loader2 as Loader2Icon,
  AlertCircle as AlertCircleIcon,
  Cpu as CpuIcon,
} from 'lucide-react'
import type { OllamaSetupProgress, OllamaStatus } from '../types'

interface Step {
  statuses: OllamaStatus[]
  label: string
}

const STEPS: Step[] = [
  { statuses: ['checking', 'installing'], label: 'Installing Ollama' },
  { statuses: ['pulling'], label: 'Downloading AI model (qwen3.5)' },
  { statuses: ['starting'], label: 'Starting local server' },
]

function stepState(step: Step, current: OllamaStatus): 'done' | 'active' | 'pending' | 'error' {
  if (current === 'error') {
    // figure out which step errored by treating it as the currently active step
    const activeIndex = STEPS.findIndex((s) => s.statuses.includes(current))
    const thisIndex = STEPS.indexOf(step)
    if (activeIndex === -1) return 'pending'
    if (thisIndex < activeIndex) return 'done'
    if (thisIndex === activeIndex) return 'error'
    return 'pending'
  }

  if (current === 'ready') return 'done'

  const currentStepIndex = STEPS.findIndex((s) => s.statuses.includes(current))
  const thisIndex = STEPS.indexOf(step)

  if (currentStepIndex === -1) return 'pending'
  if (thisIndex < currentStepIndex) return 'done'
  if (thisIndex === currentStepIndex) return 'active'
  return 'pending'
}

interface Props {
  onComplete: () => void
}

export function OllamaOnboarding({ onComplete }: Props) {
  const [progress, setProgress] = useState<OllamaSetupProgress>({
    status: 'checking',
    message: 'Checking for Ollama…',
  })

  useEffect(() => {
    const unsub = window.paperMagic.onOllamaProgress((p) => {
      setProgress(p)
      if (p.status === 'ready') {
        // Small delay so user sees the "ready" state
        setTimeout(onComplete, 1200)
      }
    })
    return unsub
  }, [onComplete])

  const status = progress.status

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090a0c]">
      <div className="flex flex-col items-center gap-8 max-w-md w-full px-8">
        {/* Icon */}
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-white/[0.06] border border-white/[0.08]">
          <CpuIcon size={28} strokeWidth={1.5} className="text-text-secondary" />
        </div>

        {/* Title */}
        <div className="text-center">
          <h1 className="text-xl font-semibold text-text-primary m-0">Setting up your reading assistant</h1>
          <p className="mt-2 text-sm text-text-muted leading-relaxed m-0">
            Paper Magic uses a local AI model to reformat PDFs for a better reading experience.
            This only happens once.
          </p>
        </div>

        {/* Steps */}
        <div className="w-full grid gap-3">
          {STEPS.map((step) => {
            const state = stepState(step, status)
            return (
              <div
                key={step.label}
                className="flex items-center gap-3 p-3 rounded-lg border border-white/[0.06] bg-white/[0.03]"
              >
                <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                  {state === 'done' && (
                    <CheckCircleIcon size={16} strokeWidth={2} className="text-[#4ade80]" />
                  )}
                  {state === 'active' && (
                    <Loader2Icon size={16} strokeWidth={2} className="text-text-secondary animate-spin" />
                  )}
                  {state === 'error' && (
                    <AlertCircleIcon size={16} strokeWidth={2} className="text-red-400" />
                  )}
                  {state === 'pending' && (
                    <div className="w-4 h-4 rounded-full border border-white/20" />
                  )}
                </div>
                <span
                  className={[
                    'text-sm',
                    state === 'done' ? 'text-text-secondary' : '',
                    state === 'active' ? 'text-text-primary' : '',
                    state === 'error' ? 'text-red-400' : '',
                    state === 'pending' ? 'text-text-muted' : '',
                  ].join(' ')}
                >
                  {step.label}
                </span>
              </div>
            )
          })}
        </div>

        {/* Progress bar for pull */}
        {status === 'pulling' && progress.progress !== undefined && (
          <div className="w-full">
            <div className="h-1 w-full bg-white/[0.08] rounded-full overflow-hidden">
              <div
                className="h-full bg-white/40 rounded-full transition-all duration-300"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-text-muted text-center">{progress.progress}%</p>
          </div>
        )}

        {/* Status message */}
        <p className="text-xs text-text-muted text-center leading-relaxed">
          {status === 'error' ? (
            <span className="text-red-400">{progress.message}</span>
          ) : (
            progress.message
          )}
        </p>

        {/* Error skip option */}
        {status === 'error' && (
          <button
            type="button"
            onClick={onComplete}
            className="text-xs text-text-muted underline underline-offset-2 cursor-pointer bg-transparent border-0 p-0"
          >
            Skip and continue without local AI
          </button>
        )}

        {/* Ready state */}
        {status === 'ready' && (
          <div className="flex items-center gap-2 text-sm text-[#4ade80]">
            <CheckCircleIcon size={16} strokeWidth={2} />
            <span>All set! Entering Paper Magic…</span>
          </div>
        )}
      </div>
    </div>
  )
}
