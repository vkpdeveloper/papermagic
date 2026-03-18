import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2 as CheckCircleIcon,
  Loader2 as Loader2Icon,
  Sparkles as SparklesIcon,
  Eye as EyeIcon,
  EyeOff as EyeOffIcon,
} from 'lucide-react'
import type { AppSettings, AiProvider } from '../types'
import { Select } from './ui/Select'
import { Dialog } from './ui/Dialog'

interface SettingsPageProps {
  open: boolean
  onClose: () => void
}

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

export function SettingsPage({ open, onClose }: SettingsPageProps) {
  const [settings, setSettings] = useState<AppSettings>({
    aiEnabled: false,
    aiProvider: null,
    aiModel: null,
    aiApiKey: null,
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [keyValid, setKeyValid] = useState<boolean | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<Array<{ value: string; label: string; description: string }>>([])

  useEffect(() => {
    if (!open) return

    setIsLoading(true)
    const load = async () => {
      try {
        const loaded = await window.paperMagic.loadSettings()
        setSettings(loaded)

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

      if (valid) {
        toast.success('API key verified — AI features ready!')
      } else {
        toast.error('API key invalid or request failed', {
          description: 'Double-check your key and make sure billing is enabled.',
        })
      }
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

  const selectedProvider = PROVIDERS.find((p) => p.value === settings.aiProvider) ?? null

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
        <div className="grid gap-6">
          {/* AI Features Section */}
          <section className="border border-border-subtle p-5">
            <div className="flex items-start gap-3 mb-5">
              <SparklesIcon size={16} strokeWidth={1.8} className="text-text-secondary mt-0.5 shrink-0" />
              <div>
                <h3 className="m-0 text-sm font-semibold text-text-primary">AI Features</h3>
                <p className="mt-1 text-xs text-text-muted leading-relaxed">
                  Automatically generate descriptive titles for imported documents using an AI provider of your choice.
                </p>
              </div>
            </div>

            <div className="grid gap-5">
              {/* Enable toggle */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="m-0 text-sm text-text-primary">Enable AI title generation</p>
                  <p className="m-0 mt-0.5 text-xs text-text-muted">
                    Applies to documents imported after this setting is saved.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.aiEnabled}
                  onClick={() => handleToggleAi(!settings.aiEnabled)}
                  className={[
                    'relative inline-flex shrink-0 h-6 w-11 cursor-pointer items-center rounded-full border-2 border-transparent',
                    'transition-colors duration-200 ease-in-out',
                    'focus:outline-none',
                    settings.aiEnabled ? 'bg-white' : 'bg-white/[0.14]',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'pointer-events-none inline-block h-5 w-5 rounded-full shadow-lg',
                      'transform transition duration-200 ease-in-out',
                      settings.aiEnabled ? 'translate-x-5 bg-[#090a0c]' : 'translate-x-0 bg-white/50',
                    ].join(' ')}
                  />
                </button>
              </div>

              {settings.aiEnabled ? (
                <>
                  {/* Provider selector */}
                  <div className="grid gap-2">
                    <label className="text-sm text-text-primary">Provider</label>
                    <Select
                      value={settings.aiProvider ?? undefined}
                      onValueChange={(value) => void handleProviderChange(value as AiProvider)}
                      options={PROVIDERS.map((p) => ({ value: p.value, label: p.label, description: p.description }))}
                      placeholder="Select a provider…"
                    />
                  </div>

                  {/* Model selector */}
                  {models.length > 0 ? (
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
                  ) : null}

                  {/* API Key */}
                  {selectedProvider ? (
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-text-primary">API Key</label>
                        <button
                          type="button"
                          onClick={() => void handleValidateKey()}
                          disabled={isValidating || !settings.aiApiKey}
                          className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-transparent border-0 p-0 font-[inherit]"
                        >
                          {isValidating ? <Loader2Icon size={12} className="animate-spin" /> : null}
                          {isValidating ? 'Validating…' : 'Test key'}
                        </button>
                      </div>

                      <div className="relative">
                        <input
                          type={showKey ? 'text' : 'password'}
                          value={settings.aiApiKey ?? ''}
                          onChange={(e) => {
                            setKeyValid(null)
                            setSettings((prev) => ({ ...prev, aiApiKey: e.target.value || null }))
                          }}
                          placeholder={selectedProvider.keyPlaceholder}
                          className="w-full bg-[#050505] border border-border-strong text-text-primary text-xs font-mono px-3 py-2.5 pr-9 outline-none focus:border-white/30 transition-colors duration-150 placeholder:text-text-muted"
                          spellCheck={false}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          onClick={() => setShowKey((v) => !v)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors duration-150 bg-transparent border-0 p-0 cursor-pointer"
                          aria-label={showKey ? 'Hide key' : 'Show key'}
                        >
                          {showKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                        </button>
                      </div>

                      <div className="flex items-center justify-between">
                        <p className="m-0 text-xs text-text-muted">{selectedProvider.keyHint}</p>
                        {keyValid !== null ? (
                          <div className="flex items-center gap-1.5 text-xs">
                            <CheckCircleIcon
                              size={12}
                              strokeWidth={2}
                              className={keyValid ? 'text-[#4ade80]' : 'text-white/20'}
                            />
                            <span className={keyValid ? 'text-[#4ade80]' : 'text-text-muted'}>
                              {keyValid ? 'Valid' : 'Invalid'}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>

          {/* Footer actions */}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="min-h-10 px-5 bg-transparent text-text-secondary border border-border-subtle hover:border-border-strong hover:text-text-primary transition-colors duration-150 cursor-pointer font-[inherit] text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="min-h-10 px-5 bg-text-primary text-[#000] font-bold border-0 cursor-pointer font-[inherit] text-sm disabled:opacity-60 transition-opacity duration-150"
            >
              {isSaving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
