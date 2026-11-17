/**
 * Electron main process — оболочка окна ds-map.
 * Единственный экземпляр, безопасные webPreferences, подключение к сайдкару через WS.
 * Пристегивание к окну харнеса справа с_tracking'ом позиции.
 */

import electron from 'electron'
import type { BrowserWindow as BrowserWindowCtor, IpcMainInvokeEvent } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import WebSocket from 'ws'
import { findWindowByPid, computePanelBounds, type WindowBounds } from './window.js'

const { app, BrowserWindow, screen, ipcMain } = electron

let panel: BrowserWindowCtor | null = null
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let trackTimer: ReturnType<typeof setInterval> | null = null
let harnessPid: number | null = null
let lastBoundsKey = ''

const PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '0', 10)
const TOKEN = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1] ?? ''
const HARNESS_PID_ARG = process.argv.find((a) => a.startsWith('--harness-pid='))

const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'dsmap-config.json')

let config: { theme: 'dark' | 'light'; lang: 'ru' | 'en'; motion: 'full' | 'reduced' } = { theme: 'dark', lang: 'ru', motion: 'full' }

function loadConfig(): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.theme === 'light' || parsed.theme === 'dark') config.theme = parsed.theme as 'dark' | 'light'
    if (parsed.lang === 'ru' || parsed.lang === 'en') config.lang = parsed.lang as 'ru' | 'en'
    if (parsed.motion === 'full' || parsed.motion === 'reduced') config.motion = parsed.motion as 'full' | 'reduced'
  } catch {
    // config not found — defaults
  }
}

function saveConfig(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config), { mode: 0o600 })
  } catch {
    // ignore
  }
}

if (HARNESS_PID_ARG) {
  harnessPid = parseInt(HARNESS_PID_ARG.split('=')[1], 10)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => panel?.showInactive())
  app.whenReady().then(start)
}

async function start() {
  loadConfig()
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  // Начальная позиция: правый край экрана (fallback)
  const initial = computePanelBounds(null, width, height)

  panel = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    x: initial.x,
    y: initial.y,
    show: false,
    frame: true,
    resizable: true,
    minWidth: 320,
    skipTaskbar: true,
    alwaysOnTop: false,
    backgroundColor: '#0a0c11',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  await panel!.loadFile(path.join(__dirname, 'index.html'))
  panel!.showInactive()

  connectWS(PORT, TOKEN)

  // IPC handlers для конфига
  ipcMain.handle('config:get', () => ({ ...config }))
  ipcMain.handle('config:set', (_e: IpcMainInvokeEvent, patch: unknown) => {
    if (patch && typeof patch === 'object') {
      const p = patch as Record<string, unknown>
      if (p.theme === 'light' || p.theme === 'dark') config.theme = p.theme
      if (p.lang === 'ru' || p.lang === 'en') config.lang = p.lang
      if (p.motion === 'full' || p.motion === 'reduced') config.motion = p.motion
      saveConfig()
    }
    return { ...config }
  })

  // Если Known PID — начинаем отслеживание позиции окна харнеса
  if (harnessPid) {
    startTracking(harnessPid)
  }

  app.on('window-all-closed', () => {
    stopTracking()
    ws?.close()
    app.quit()
  })

  app.on('before-quit', () => {
    stopTracking()
    ws?.close()
  })
}

function startTracking(pid: number): void {
  trackTimer = setInterval(() => {
    const bounds = findWindowByPid(pid)
    if (!bounds) {
      // Окно не найдено — скрыть панель? Или оставить на месте.
      // Для веб-харнеса окно может быть браузерным — оставляем на месте.
      return
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    const panelBounds = computePanelBounds(bounds, width, height)
    const key = `${panelBounds.x},${panelBounds.y},${panelBounds.width},${panelBounds.height}`
    if (key === lastBoundsKey) return
    lastBoundsKey = key
    panel?.setBounds({ x: panelBounds.x, y: panelBounds.y, width: panelBounds.width, height: panelBounds.height }, false)
  }, 500)
  trackTimer.unref?.()
}

function stopTracking(): void {
  if (trackTimer) {
    clearInterval(trackTimer)
    trackTimer = null
  }
}

function connectWS(port: number, token: string): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }

  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`)
    ws.on('open', () => {
      console.log('[ds-map] WS подключён')
    })
    ws.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString())
        panel?.webContents.send('event', data)
      } catch {
        // игнорируем битые сообщения
      }
    })
    ws.on('close', () => {
      ws = null
      scheduleReconnect(port, token)
    })
    ws.on('error', () => {
      // молча, переподключение сработает на close
    })
  } catch {
    scheduleReconnect(port, token)
  }
}

function scheduleReconnect(port: number, token: string): void {
  wsReconnectTimer = setTimeout(() => connectWS(port, token), 1000)
  wsReconnectTimer.unref?.()
}
