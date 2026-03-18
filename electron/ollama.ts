import { Ollama } from 'ollama'
import { spawn, exec } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { OllamaSetupProgress } from '../src/types'

const execAsync = promisify(exec)

export const OLLAMA_MODEL = 'qwen3.5:0.8b'

// Ports to probe in order: system service default, then our fallback
const CANDIDATE_PORTS = [11434, 11435]
const SPAWN_PORT = 11435
const SPAWN_NUM_PARALLEL = 4

// Resolved at runtime once the server is confirmed up
let resolvedBaseUrl = ''
let ollamaProcess: ChildProcess | null = null
let progressCallback: ((p: OllamaSetupProgress) => void) | null = null

export function setOllamaProgressCallback(cb: (p: OllamaSetupProgress) => void) {
  progressCallback = cb
}

export function getOllamaBaseUrl(): string {
  return resolvedBaseUrl
}

function emit(status: OllamaSetupProgress['status'], message: string, progress?: number) {
  progressCallback?.({ status, message, progress })
}

// ── Port / server detection ───────────────────────────────────────────────────

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(800)
    socket
      .once('connect', () => { socket.destroy(); resolve(true) })
      .once('error', () => { socket.destroy(); resolve(false) })
      .once('timeout', () => { socket.destroy(); resolve(false) })
      .connect(port, '127.0.0.1')
  })
}

async function findRunningOllamaPort(): Promise<number | null> {
  for (const port of CANDIDATE_PORTS) {
    if (await isPortOpen(port)) {
      console.log(`[ollama] found running server on port ${port}`)
      return port
    }
  }
  return null
}

async function isModelAvailableOnPort(port: number): Promise<boolean> {
  try {
    const client = new Ollama({ host: `http://127.0.0.1:${port}` })
    const { models } = await client.list()
    const modelBase = OLLAMA_MODEL.split(':')[0]
    const found = models.some(
      (m) => m.name === OLLAMA_MODEL || m.name.startsWith(modelBase)
    )
    console.log(`[ollama] model ${OLLAMA_MODEL} on port ${port}:`, found ? 'found' : 'not found')
    if (!found) {
      console.log(`[ollama] available models on port ${port}:`, models.map(m => m.name).join(', ') || '(none)')
    }
    return found
  } catch {
    return false
  }
}

// ── Binary detection ──────────────────────────────────────────────────────────

const KNOWN_PATHS = [
  '/usr/local/bin/ollama',
  '/usr/bin/ollama',
  path.join(os.homedir(), '.local', 'bin', 'ollama'),
  path.join(os.homedir(), 'bin', 'ollama'),
]

if (process.platform === 'darwin') {
  KNOWN_PATHS.push('/opt/homebrew/bin/ollama')
}

if (process.platform === 'win32') {
  KNOWN_PATHS.push(
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env['ProgramFiles'] ?? '', 'Ollama', 'ollama.exe'),
  )
}

async function findOllamaBinary(): Promise<string | null> {
  for (const p of KNOWN_PATHS) {
    try {
      await fs.access(p, fs.constants.X_OK)
      return p
    } catch { /* not there */ }
  }
  try {
    const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama'
    const { stdout } = await execAsync(cmd)
    const found = stdout.trim().split('\n')[0]?.trim()
    if (found) return found
  } catch { /* not in PATH */ }
  return null
}

// ── Installation ──────────────────────────────────────────────────────────────

async function installOllama(): Promise<void> {
  emit('installing', 'Installing Ollama…')
  console.log('[ollama] installing…')

  if (process.platform === 'linux' || process.platform === 'darwin') {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: os.homedir() },
      })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.stdout?.on('data', (d: Buffer) => {
        const line = d.toString().trim()
        if (line) emit('installing', line)
      })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Install script exited with code ${code}. ${stderr}`))
      })
      proc.on('error', reject)
    })
  } else if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), 'OllamaSetup.exe')
      const dl = spawn('powershell', [
        '-Command',
        `Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '${tmp}'; Start-Process '${tmp}' -ArgumentList '/S' -Wait`,
      ], { stdio: 'ignore' })
      dl.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(`Windows install failed: ${code}`)) })
      dl.on('error', reject)
    })
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`)
  }

  console.log('[ollama] installed successfully')
  emit('installing', 'Ollama installed successfully')
}

// ── Model pull ────────────────────────────────────────────────────────────────

export async function pullModel(): Promise<void> {
  emit('pulling', `Downloading ${OLLAMA_MODEL}…`, 0)
  console.log(`[ollama] pulling model ${OLLAMA_MODEL}…`)

  const client = new Ollama({ host: resolvedBaseUrl })
  const stream = await client.pull({ model: OLLAMA_MODEL, stream: true })

  for await (const chunk of stream) {
    if (chunk.status === 'success') {
      emit('pulling', `${OLLAMA_MODEL} ready`, 100)
      return
    }
    const pct = chunk.completed && chunk.total && chunk.total > 0
      ? Math.round((chunk.completed / chunk.total) * 100)
      : undefined
    emit('pulling', chunk.status ?? `Downloading ${OLLAMA_MODEL}…`, pct)
  }

  emit('pulling', `${OLLAMA_MODEL} ready`, 100)
}

// ── Spawn our own server (only if nothing is running) ─────────────────────────

async function spawnServer(binary: string): Promise<void> {
  emit('starting', 'Starting Ollama server…')
  console.log(`[ollama] spawning server on port ${SPAWN_PORT}…`)

  ollamaProcess = spawn(binary, ['serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${SPAWN_PORT}`,
      OLLAMA_NUM_PARALLEL: String(SPAWN_NUM_PARALLEL),
      OLLAMA_MAX_LOADED_MODELS: '1',
    },
  })

  ollamaProcess.on('error', (err) => console.error('[ollama] server error:', err))
  ollamaProcess.on('exit', (code) => {
    console.log('[ollama] server exited with code', code)
    ollamaProcess = null
  })

  const started = await new Promise<boolean>((resolve) => {
    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      if (await isPortOpen(SPAWN_PORT)) { clearInterval(interval); resolve(true) }
      else if (attempts >= 20) { clearInterval(interval); resolve(false) }
    }, 500)
  })

  if (!started) throw new Error('Ollama server did not start in time')
  resolvedBaseUrl = `http://127.0.0.1:${SPAWN_PORT}`
  console.log(`[ollama] server ready on ${resolvedBaseUrl}`)
}

export function stopServer(): void {
  if (ollamaProcess) {
    ollamaProcess.kill()
    ollamaProcess = null
  }
}

// ── Public lifecycle ──────────────────────────────────────────────────────────

/**
 * Full setup: find/install Ollama, find/pull model, connect to server.
 * Prefers any already-running Ollama instance before spawning our own.
 */
export async function ensureOllama(): Promise<void> {
  emit('checking', 'Checking for Ollama…')
  console.log('[ollama] ensureOllama starting…')

  // 1. Check if a server is already running anywhere
  const runningPort = await findRunningOllamaPort()

  if (runningPort) {
    resolvedBaseUrl = `http://127.0.0.1:${runningPort}`
    console.log(`[ollama] using existing server at ${resolvedBaseUrl}`)
    emit('starting', `Using existing Ollama server on port ${runningPort}`)

    if (await isModelAvailableOnPort(runningPort)) {
      emit('ready', 'Local AI ready')
      return
    }

    // Model missing — pull it via the existing server
    await pullModel()
    emit('ready', 'Local AI ready')
    return
  }

  // 2. No server running — ensure binary exists then spawn
  let binary = await findOllamaBinary()
  if (!binary) {
    await installOllama()
    binary = await findOllamaBinary()
    if (!binary) throw new Error('Ollama binary not found after installation')
  }

  await spawnServer(binary)

  if (!(await isModelAvailableOnPort(SPAWN_PORT))) {
    await pullModel()
  }

  emit('ready', 'Local AI ready')
}

/**
 * Called on subsequent app starts (setup already done). Silently connects
 * to whichever Ollama is running, or spawns one if needed.
 */
export async function startOllamaServer(): Promise<boolean> {
  try {
    const runningPort = await findRunningOllamaPort()
    if (runningPort) {
      resolvedBaseUrl = `http://127.0.0.1:${runningPort}`
      console.log(`[ollama] connected to existing server at ${resolvedBaseUrl}`)
      return true
    }

    const binary = await findOllamaBinary()
    if (!binary) return false
    await spawnServer(binary)
    return true
  } catch (err) {
    console.error('[ollama] startOllamaServer failed:', err)
    return false
  }
}

export async function getCurrentStatus(): Promise<OllamaSetupProgress> {
  const runningPort = await findRunningOllamaPort()
  if (!runningPort) return { status: 'error', message: 'Ollama server not running' }
  const modelOk = await isModelAvailableOnPort(runningPort)
  if (!modelOk) return { status: 'pulling', message: 'Model not yet downloaded' }
  return { status: 'ready', message: 'Local AI ready' }
}
