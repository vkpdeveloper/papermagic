import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2 as CheckCircleIcon,
  Loader2 as Loader2Icon,
  Sparkles as SparklesIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
  Cpu as CpuIcon,
  RefreshCw as RefreshCwIcon,
} from 'lucide-react'
import type { AppSettings, AiProvider, OllamaSetupProgress } from '../types'
import { Select } from './ui/Select'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

interface SettingsPageProps {
  open: boolean
  onClose: () => void
  currentDocumentId?: string | null
}

type SettingsTab = 'cloud-ai' | 'local-ai'

const PROVIDERS: Array<{ value: AiProvider; label: string; description: string; keyPlaceholder: string; keyHint: string }> = [
  {
    value: 'google',
    label: 'Google Gemini',
    description: 'Gemini models by Google DeepMind',
    keyPlaceholder: 'AIza…',
    keyHint: 'Get your key at aistudio.google.com',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'GPT models by OpenAI',
    keyPlaceholder: 'sk-…',
    keyHint: 'Get your key at platform.openai.com',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models by Anthropic',
    keyPlaceholder: 'sk-ant-…',
    keyHint: 'Get your key at console.anthropic.com',
  },
]

const DEFAULT_MODELS: Record<AiProvider, string> = {
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex shrink-0 h-6 w-11 cursor-pointer items-center rounded-full border-2 border-transparent',
        'transition-colors duration-200 ease-in-out focus:outline-none',
        checked ? 'bg-white' : 'bg-white/[0.14]',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none inline-block h-5 w-5 rounded-full shadow-lg',
          'transform transition duration-200 ease-in-out',
          checked ? 'translate-x-5 bg-[#090a0c]' : 'translate-x-0 bg-white/50',
        ].join(' ')}
      />
    </button>
  )
}

function OllamaStatusBadge({ status }: { status: OllamaSetupProgress['status'] }) {
  const map: Record<OllamaSetupProgress['status'], { label: string; color: string }> = {
    idle: { label: 'Idle', color: 'text-text-muted' },
    checking: { label: 'Checking…', color: 'text-text-muted' },
    installing: { label: 'Installing…', color: 'text-amber-400' },
    pulling: { label: 'Downloading…', color: 'text-amber-400' },
    starting: { label: 'Starting…', color: 'text-amber-400' },
    ready: { label: 'Running', color: 'text-[#4ade80]' },
    error: { label: 'Unavailable', color: 'text-red-400' },
  }
  const { label, color } = map[status] ?? map.idle
  return <span className={`text-xs font-medium ${color}`}>{label}</span>
}

export function SettingsPage({ open, onClose, currentDocumentId }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>('cloud-ai')
  const [settings, setSettings] = useState<AppSettings>({
    aiEnabled: false,
    aiProvider: null,
    aiModel: null,
    aiApiKey: null,
    localAiEnabled: true,
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [keyValid, setKeyValid] = useState<boolean | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<Array<{ value: string; label: string; description: string }>>([])
  const [ollamaStatus, setOllamaStatus] = useState<OllamaSetupProgress>({ status: 'idle', message: '' })
  const [isRerunning, setIsRerunning] = useState(false)

  useEffect(() => {
    if (!open) return
    setIsLoading(true)

    const load = async () => {
      try {
        const [loaded, status] = await Promise.all([
          window.paperMagic.loadSettings(),
          window.paperMagic.getOllamaStatus(),
        ])
        setSettings(loaded)
        setOllamaStatus(status)

        if (loaded.aiProvider) {
          const providerModels = await window.paperMagic.getProviderModels(loaded.aiProvider)
          setModels(providerModels)
        }
      } catch {
        toast.error('Failed to load settings')
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [open])

  // Live Ollama status updates while settings is open
  useEffect(() => {
    if (!open) return
    return window.paperMagic.onOllamaProgress(setOllamaStatus)
  }, [open])

  const handleProviderChange = useCallback(async (provider: AiProvider) => {
    const providerModels = await window.paperMagic.getProviderModels(provider)
    setModels(providerModels)
    setKeyValid(null)
    setSettings((prev) => ({
      ...prev,
      aiProvider: provider,
      aiModel: DEFAULT_MODELS[provider],
      aiApiKey: null,
    }))
  }, [])

  const handleValidateKey = useCallback(async () => {
    if (!settings.aiProvider || !settings.aiApiKey || !settings.aiModel) return
    setIsValidating(true)
    setKeyValid(null)
    try {
      const valid = await window.paperMagic.validateApiKey(settings.aiProvider, settings.aiApiKey, settings.aiModel)
      setKeyValid(valid)
      if (valid) toast.success('API key verified — AI features ready!')
      else toast.error('API key invalid or request failed', { description: 'Double-check your key and make sure billing is enabled.' })
    } catch {
      toast.error('Failed to validate API key')
    } finally {
      setIsValidating(false)
    }
  }, [settings.aiProvider, settings.aiApiKey, settings.aiModel])

  const handleToggleAi = useCallback((enabled: boolean) => {
    setSettings((prev) => ({
      ...prev,
      aiEnabled: enabled,
      aiProvider: enabled ? (prev.aiProvider ?? 'google') : null,
      aiModel: enabled ? (prev.aiModel ?? DEFAULT_MODELS['google']) : null,
      aiApiKey: enabled ? prev.aiApiKey : null,
    }))
    if (enabled && !settings.aiProvider) {
      void window.paperMagic.getProviderModels('google').then(setModels)
    }
  }, [settings.aiProvider])

  const handleSave = useCallback(async () => {
    if (settings.aiEnabled && !settings.aiApiKey) {
      toast.error('API key required', { description: 'Enter your API key before saving.' })
      return
    }
    setIsSaving(true)
    try {
      const saved = await window.paperMagic.saveSettings(settings)
      setSettings(saved)
      toast.success('Settings saved')
      onClose()
    } catch {
      toast.error('Failed to save settings')
    } finally {
      setIsSaving(false)
    }
  }, [settings, onClose])

  const handleRerunRefinement = useCallback(async () => {
    if (!currentDocumentId) return
    setIsRerunning(true)
    try {
      await window.paperMagic.rerunRefinement(currentDocumentId)
      toast.success('Re-running content refinement for this document')
    } catch {
      toast.error('Failed to queue refinement')
    } finally {
      setIsRerunning(false)
    }
  }, [currentDocumentId])

  const selectedProvider = PROVIDERS.find((p) => p.value === settings.aiProvider) ?? null

  const TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'cloud-ai', label: 'Cloud AI', icon: <SparklesIcon size={14} strokeWidth={1.8} /> },
    { id: 'local-ai', label: 'Local AI', icon: <CpuIcon size={14} strokeWidth={1.8} /> },
  ]

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => { if (!isOpen) onClose() }}
      title="Settings"
      description="Configure Paper Magic to your preferences."
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-text-muted py-6">
          <Loader2Icon size={16} className="animate-spin" />
          <span>Loading settings…</span>
        </div>
      ) : (
        <div className="flex gap-6 min-h-[340px]">
          {/* Sidebar */}
          <nav className="flex flex-col gap-1 w-36 shrink-0 border-r border-border-subtle pr-4">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={[
                  'flex items-center gap-2 px-3 py-2 rounded text-sm text-left transition-colors duration-150',
                  tab === t.id
                    ? 'bg-white/[0.08] text-text-primary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-white/[0.04]',
                ].join(' ')}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 flex flex-col gap-5">
            {/* ── Cloud AI tab ── */}
            {tab === 'cloud-ai' && (
              <>
                <div>
                  <h3 className="m-0 text-sm font-semibold text-text-primary">Cloud AI</h3>
                  <p className="mt-1 text-xs text-text-muted leading-relaxed">
                    Automatically generate descriptive titles for imported documents using a cloud AI provider.
                  </p>
                </div>

                <div className="grid gap-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="m-0 text-sm text-text-primary">Enable AI title generation</p>
                      <p className="m-0 mt-0.5 text-xs text-text-muted">Applies to documents imported after saving.</p>
                    </div>
                    <Toggle checked={settings.aiEnabled} onChange={handleToggleAi} />
                  </div>

                  {settings.aiEnabled && (
                    <>
                      <div className="grid gap-2">
                        <label className="text-sm text-text-primary">Provider</label>
                        <Select
                          value={settings.aiProvider ?? undefined}
                          onValueChange={(value) => void handleProviderChange(value as AiProvider)}
                          options={PROVIDERS.map((p) => ({ value: p.value, label: p.label, description: p.description }))}
                          placeholder="Select a provider…"
                        />
                      </div>

                      {models.length > 0 && (
                        <div className="grid gap-2">
                          <label className="text-sm text-text-primary">Model</label>
                          <Select
                            value={settings.aiModel ?? undefined}
                            onValueChange={(value) => {
                              setKeyValid(null)
                              setSettings((prev) => ({ ...prev, aiModel: value }))
                            }}
                            options={models}
                            placeholder="Select a model…"
                          />
                        </div>
                      )}

                      {selectedProvider && (
                        <div className="grid gap-2">
                          <div className="flex items-center justify-between">
                            <label className="text-sm text-text-primary">API Key</label>
                            <Button
                              variant="link"
                              type="button"
                              size="sm"
                              className="text-xs"
                              loading={isValidating}
                              disabled={isValidating || !settings.aiApiKey}
                              onClick={() => void handleValidateKey()}
                            >
                              {isValidating ? 'Validating…' : 'Test key'}
                            </Button>
                          </div>
                          <div className="relative">
                            <Input
                              variant="mono"
                              size="md"
                              type={showKey ? 'text' : 'password'}
                              value={settings.aiApiKey ?? ''}
                              onChange={(e) => {
                                setKeyValid(null)
                                setSettings((prev) => ({ ...prev, aiApiKey: e.target.value || null }))
                              }}
                              placeholder={selectedProvider.keyPlaceholder}
                              suffix={
                                <button
                                  type="button"
                                  onClick={() => setShowKey((v) => !v)}
                                  className="text-text-muted hover:text-text-secondary transition-colors duration-150 bg-transparent border-0 p-0 cursor-pointer"
                                  aria-label={showKey ? 'Hide key' : 'Show key'}
                                >
                                  {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                                </button>
                              }
                              spellCheck={false}
                              autoComplete="off"
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <p className="m-0 text-xs text-text-muted">{selectedProvider.keyHint}</p>
                            {keyValid !== null && (
                              <div className="flex items-center gap-1.5 text-xs">
                                <CheckCircleIcon size={12} strokeWidth={2} className={keyValid ? 'text-[#4ade80]' : 'text-white/20'} />
                                <span className={keyValid ? 'text-[#4ade80]' : 'text-text-muted'}>{keyValid ? 'Valid' : 'Invalid'}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            {/* ── Local AI tab ── */}
            {tab === 'local-ai' && (
              <>
                <div>
                  <h3 className="m-0 text-sm font-semibold text-text-primary">Local AI</h3>
                  <p className="mt-1 text-xs text-text-muted leading-relaxed">
                    Uses a small on-device model (qwen3.5) via Ollama to reformat PDF content for a better reading experience.
                    Runs entirely offline — no data leaves your machine.
                  </p>
                </div>

                <div className="grid gap-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="m-0 text-sm text-text-primary">Enable content refinement</p>
                      <p className="m-0 mt-0.5 text-xs text-text-muted">Reformats imported PDFs in the background.</p>
                    </div>
                    <Toggle
                      checked={settings.localAiEnabled}
                      onChange={(v) => setSettings((prev) => ({ ...prev, localAiEnabled: v }))}
                    />
                  </div>

                  {/* Ollama server status */}
                  <div className="flex items-center justify-between p-3 rounded border border-border-subtle bg-white/[0.02]">
                    <div className="flex items-center gap-2">
                      <CpuIcon size={14} strokeWidth={1.8} className="text-text-muted" />
                      <span className="text-xs text-text-muted">Ollama server</span>
                    </div>
                    <OllamaStatusBadge status={ollamaStatus.status} />
                  </div>

                  {/* Model info */}
                  <div className="flex items-center justify-between p-3 rounded border border-border-subtle bg-white/[0.02]">
                    <div className="flex items-center gap-2">
                      <SparklesIcon size={14} strokeWidth={1.8} className="text-text-muted" />
                      <span className="text-xs text-text-muted">Model</span>
                    </div>
                    <span className="text-xs font-mono text-text-secondary">qwen3.5:0.8b</span>
                  </div>

                  {/* Re-run refinement for current document */}
                  {currentDocumentId && (
                    <div className="flex items-start justify-between gap-4 pt-1">
                      <div>
                        <p className="m-0 text-sm text-text-primary">Re-run for current document</p>
                        <p className="m-0 mt-0.5 text-xs text-text-muted">Queue this document for refinement again.</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        loading={isRerunning}
                        disabled={isRerunning || ollamaStatus.status !== 'ready'}
                        onClick={() => void handleRerunRefinement()}
                      >
                        <RefreshCwIcon size={13} />
                        Re-run
                      </Button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Footer */}
            <div className="flex justify-end gap-3 mt-auto pt-4 border-t border-border-subtle">
              <Button type="button" variant="ghost" size="md" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" variant="primary" size="md" loading={isSaving} onClick={() => void handleSave()}>
                {isSaving ? 'Saving…' : 'Save settings'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}
