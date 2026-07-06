import { join } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  Tray,
  Menu
} from 'electron'
import type { StartSessionInput } from '../shared/types'
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, SUMMON_HOTKEY } from './config'
import { parseContextFile } from './context-files'
import { AnthropicLlm } from './llm/anthropic'
import { MockLlm } from './llm/mock'
import type { LlmClient } from './llm/types'
import { listPresets } from './prompts'
import { SessionManager } from './session'
import { Store } from './store/store'
import { DeepgramProvider } from './stt/deepgram'
import { MockSttProvider } from './stt/mock'
import type { SttProvider } from './stt/types'

loadDotenv({ path: join(app.getAppPath(), '.env') })

const PROMPTS_DIR = join(app.getAppPath(), 'prompts')
const MOCK_MODE = process.env.MOCK_MODE === '1'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

// Device ids chosen in the setup form; the overlay renderer (which owns
// audio capture) fetches them via getCurrentSession.
let currentDeviceIds: { micDeviceId?: string; systemDeviceId?: string } = {}

const store = new Store(join(app.getPath('userData'), 'copilot.db'))

function buildStt(): SttProvider {
  if (MOCK_MODE) return new MockSttProvider()
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set (add it to .env)')
  return new DeepgramProvider(key)
}

function buildLlm(): LlmClient {
  if (MOCK_MODE) return new MockLlm({ delayMs: 300 })
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (add it to .env)')
  return new AnthropicLlm(key)
}

let manager: SessionManager | null = null

function getManager(): SessionManager {
  if (!manager) {
    manager = new SessionManager({
      store,
      stt: buildStt(),
      llm: buildLlm(),
      promptsDir: PROMPTS_DIR,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS
    })
    manager.on('transcript', (chunk) => broadcast({ type: 'transcript', chunk }))
    manager.on('status', (status) => {
      broadcast({ type: 'status', status })
      updateTray()
    })
    manager.on('suggestion', (suggestion) => broadcast({ type: 'suggestion', suggestion }))
    manager.on('ended', (sessionId) => broadcast({ type: 'session-ended', sessionId }))
    manager.on('error', (err) => console.error('[session]', err))
  }
  return manager
}

function broadcast(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('copilot:event', payload)
  }
}

function rendererUrl(page: 'main-window' | 'overlay'): { url?: string; file?: string } {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return { url: `${devUrl}/${page}/index.html` }
  return { file: join(__dirname, `../renderer/${page}/index.html`) }
}

function loadPage(win: BrowserWindow, page: 'main-window' | 'overlay'): void {
  const target = rendererUrl(page)
  if (target.url) void win.loadURL(target.url)
  else void win.loadFile(target.file!)
}

function createMainWindow(): void {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
    return
  }
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    title: 'Meeting Copilot',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })
  loadPage(mainWindow, 'main-window')
  // Menu-bar app behavior: closing the window hides it, the app lives in the tray.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createOverlayWindow(): void {
  if (overlayWindow) {
    // Never steal focus mid-call — surface the window without activating it.
    if (!overlayWindow.isVisible()) overlayWindow.showInactive()
    return
  }
  overlayWindow = new BrowserWindow({
    width: 380,
    height: 480,
    minWidth: 300,
    minHeight: 300,
    maxWidth: 560,
    title: 'Copilot',
    // Deliberately a normal, visible window (principle #1): it shows up in
    // screen shares like any other window. Only "on top" so it stays glanceable.
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // Keep it visible over full-screen meeting apps.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadPage(overlayWindow, 'overlay')
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
}

function updateTray(): void {
  if (!tray) return
  const status = manager?.listeningStatus ?? 'idle'
  // The visible capture indicator (R8): the menu bar always tells the truth.
  if (status === 'listening') tray.setTitle('● Listening')
  else if (status === 'degraded') tray.setTitle('◐ Degraded')
  else if (status === 'ending') tray.setTitle('… Saving')
  else tray.setTitle('◦ Copilot')
  tray.setContextMenu(buildTrayMenu())
}

function buildTrayMenu(): Menu {
  const active = manager?.active ?? null
  return Menu.buildFromTemplate([
    { label: active ? `Session: ${active.title}` : 'No active session', enabled: false },
    { type: 'separator' },
    { label: 'Open Copilot', click: () => createMainWindow() },
    {
      label: 'Show Suggestion Window',
      enabled: !!active,
      click: () => createOverlayWindow()
    },
    {
      label: 'End Session',
      enabled: !!active,
      click: () => void endSession()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
}

async function endSession() {
  const detail = await getManager().endSession()
  currentDeviceIds = {}
  overlayWindow?.close()
  updateTray()
  return detail
}

function registerIpc(): void {
  ipcMain.handle('presets:list', () => listPresets(PROMPTS_DIR))

  ipcMain.handle('session:start', async (_e, input: StartSessionInput) => {
    const mgr = getManager()
    const session = await mgr.startSession({
      title: input.title,
      scenario: input.scenario,
      contextDocs: input.contextDocs
    })
    currentDeviceIds = { micDeviceId: input.micDeviceId, systemDeviceId: input.systemDeviceId }
    createOverlayWindow()
    updateTray()
    broadcast({ type: 'session-started', session })
    return session
  })

  ipcMain.handle('session:end', () => endSession())

  ipcMain.handle('session:current', () => ({
    session: manager?.active ?? null,
    status: manager?.listeningStatus ?? 'idle',
    ...currentDeviceIds
  }))

  ipcMain.handle('summon', () => getManager().summon())

  ipcMain.handle('suggestion:rate', (_e, id: number, rating: number) => {
    store.rateSuggestion(id, rating)
  })

  ipcMain.handle('sessions:list', () => store.listSessions())
  ipcMain.handle('session:detail', (_e, id: string) => store.getSessionDetail(id))
  ipcMain.handle('session:delete', (_e, id: string) => getManager().deleteSession(id))

  ipcMain.handle('context:pick-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Prep material', extensions: ['pdf', 'md', 'txt'] }]
    })
    if (result.canceled) return []
    const docs = []
    for (const p of result.filePaths) docs.push(await parseContextFile(p))
    return docs
  })

  // High-frequency path: fire-and-forget PCM chunks from the overlay renderer.
  ipcMain.on('audio:chunk', (_e, buf: ArrayBuffer) => {
    manager?.sendAudio(new Uint8Array(buf))
  })
}

app.whenReady().then(async () => {
  registerIpc()

  tray = new Tray(nativeImage.createEmpty())
  updateTray()

  globalShortcut.register(SUMMON_HOTKEY, () => {
    if (manager?.active) {
      createOverlayWindow()
      void getManager().summon()
    } else {
      createMainWindow()
    }
  })

  createMainWindow()

  // Close out any session left dangling by a crash (transcript is already on disk).
  try {
    const recovered = await getManager().recoverOrphanSessions()
    if (recovered > 0) console.log(`Recovered ${recovered} orphaned session(s)`)
  } catch (err) {
    // Missing API keys shouldn't block app startup; recovery re-runs next launch.
    console.error('Orphan recovery skipped:', err instanceof Error ? err.message : err)
    manager = null
  }

  app.on('activate', () => createMainWindow())
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  store.close()
})

// Menu-bar app: stay alive with all windows closed.
app.on('window-all-closed', () => {
  /* keep running in the tray */
})
