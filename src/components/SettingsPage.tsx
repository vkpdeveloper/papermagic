import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
    CheckCircle2 as CheckCircleIcon,
    Loader2 as Loader2Icon,
    Eye as EyeIcon,
    EyeOff as EyeOffIcon,
    Download as DownloadIcon,
    Cpu as CpuIcon,
} from 'lucide-react'
import type { AppSettings, AiProvider } from '../types'
import { Select } from './ui/Select'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

interface SettingsPageProps {
    open: boolean
    onClose: () => void
    currentDocumentId?: string | null
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

export function SettingsPage({ open, onClose }: SettingsPageProps) {
    const [settings, setSettings] = useState<AppSettings>({
        aiEnabled: false,
        aiProvider: null,
        aiModel: null,
        aiApiKey: null,
        localAiModelReady: false,
    })
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)
    const [isValidating, setIsValidating] = useState(false)
    const [keyValid, setKeyValid] = useState<boolean | null>(null)
    const [showKey, setShowKey] = useState(false)
    const [models, setModels] = useState<Array<{ value: string; label: string; description: string }>>([])
    // Local AI model state
    const [isDownloadingModel, setIsDownloadingModel] = useState(false)
    const [modelDownloadProgress, setModelDownloadProgress] = useState<string | null>(null)

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

    // Register local model progress/ready listeners once
    useEffect(() => {
        window.paperMagic.onLocalModelProgress((progress) => {
            if (progress.error) {
                setIsDownloadingModel(false)
                setModelDownloadProgress(null)
                toast.error('Model download failed', { description: progress.error })
                return
            }
            const pct = progress.progress != null ? ` (${Math.round(progress.progress * 100)}%)` : ''
            setModelDownloadProgress(`${progress.message}${pct}`)
        })
        window.paperMagic.onLocalModelReady(() => {
            setIsDownloadingModel(false)
            setModelDownloadProgress(null)
            setSettings((prev) => ({ ...prev, localAiModelReady: true }))
            toast.success('Qwen model ready — PDFs will now be extracted as text')
        })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

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

    const handleDownloadModel = useCallback(async () => {
        setIsDownloadingModel(true)
        setModelDownloadProgress('Initialising…')
        try {
            await window.paperMagic.downloadLocalModel()
        } catch {
            setIsDownloadingModel(false)
            setModelDownloadProgress(null)
            toast.error('Failed to start model download')
        }
    }, [])

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
                <div className="flex flex-col gap-5">
                    {/* ── Local AI (PDF text extraction) ─────────────── */}
                    <div>
                        <h3 className="m-0 text-sm font-semibold text-text-primary">Local AI — PDF Text Extraction</h3>
                        <p className="mt-1 text-xs text-text-muted leading-relaxed">
                            Download the Qwen3-0.6B model (~300 MB) once to extract selectable, searchable text from PDFs instead of rendering them as images. Runs entirely on-device via WebGPU.
                        </p>
                    </div>

                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2">
                            <CpuIcon size={14} className={settings.localAiModelReady ? 'text-[#4ade80]' : 'text-text-muted'} />
                            <div>
                                <p className="m-0 text-sm text-text-primary">
                                    {settings.localAiModelReady ? 'Qwen model ready' : 'Qwen model not downloaded'}
                                </p>
                                {isDownloadingModel && modelDownloadProgress && (
                                    <p className="m-0 mt-0.5 text-xs text-text-muted">{modelDownloadProgress}</p>
                                )}
                            </div>
                        </div>
                        {!settings.localAiModelReady && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                loading={isDownloadingModel}
                                disabled={isDownloadingModel}
                                onClick={() => void handleDownloadModel()}
                            >
                                {isDownloadingModel ? (
                                    <>
                                        <Loader2Icon size={13} className="animate-spin mr-1" />
                                        Downloading…
                                    </>
                                ) : (
                                    <>
                                        <DownloadIcon size={13} className="mr-1" />
                                        Download model
                                    </>
                                )}
                            </Button>
                        )}
                        {settings.localAiModelReady && (
                            <div className="flex items-center gap-1.5 text-xs text-[#4ade80]">
                                <CheckCircleIcon size={12} strokeWidth={2} />
                                <span>Ready</span>
                            </div>
                        )}
                    </div>

                    <div className="border-t border-border-subtle" />

                    {/* ── Cloud AI ───────────────────────────────────── */}
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

                    <div className="flex justify-end gap-3 mt-auto pt-4 border-t border-border-subtle">
                        <Button type="button" variant="ghost" size="md" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" variant="primary" size="md" loading={isSaving} onClick={() => void handleSave()}>
                            {isSaving ? 'Saving…' : 'Save settings'}
                        </Button>
                    </div>
                </div>
            )}
        </Dialog>
    )
}
