import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '../src/types'

const SETTINGS_DIRECTORY = path.join(os.homedir(), '.config', 'papermagic')
const SETTINGS_FILE_PATH = path.join(SETTINGS_DIRECTORY, 'settings.json')

const defaultSettings: AppSettings = {
  aiEnabled: false,
  aiProvider: null,
  aiModel: null,
  aiApiKey: null,
  firecrawlEnabled: false,
  firecrawlApiKey: null,
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function sanitizeSettings(input: unknown): AppSettings {
  const source = (input && typeof input === 'object') ? input as Record<string, unknown> : {}

  return {
    aiEnabled: normalizeBoolean(source.aiEnabled, defaultSettings.aiEnabled),
    aiProvider: (source.aiProvider === 'google' || source.aiProvider === 'openai' || source.aiProvider === 'anthropic')
      ? source.aiProvider
      : null,
    aiModel: normalizeString(source.aiModel),
    aiApiKey: normalizeString(source.aiApiKey),
    firecrawlEnabled: normalizeBoolean(source.firecrawlEnabled, defaultSettings.firecrawlEnabled),
    firecrawlApiKey: normalizeString(source.firecrawlApiKey),
  }
}

export function ensureSettingsFile(): void {
  fs.mkdirSync(SETTINGS_DIRECTORY, { recursive: true })

  if (!fs.existsSync(SETTINGS_FILE_PATH)) {
    fs.writeFileSync(SETTINGS_FILE_PATH, `${JSON.stringify(defaultSettings, null, 2)}\n`, 'utf8')
  }
}

export async function loadSettingsFromFile(): Promise<AppSettings> {
  ensureSettingsFile()

  try {
    const raw = await fsp.readFile(SETTINGS_FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const settings = sanitizeSettings(parsed)
    return settings
  } catch {
    await fsp.writeFile(SETTINGS_FILE_PATH, `${JSON.stringify(defaultSettings, null, 2)}\n`, 'utf8')
    return { ...defaultSettings }
  }
}

export async function saveSettingsToFile(settings: AppSettings): Promise<AppSettings> {
  ensureSettingsFile()
  const next = sanitizeSettings(settings)
  await fsp.writeFile(SETTINGS_FILE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

