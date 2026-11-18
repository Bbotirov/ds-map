/**
 * Electron main process — оболочка окна ds-map.
 * Единственный экземпляр, безопасные webPreferences, подключение к сайдкару через WS.
 * Пристёгивание к окну харнеса справа: геометрию даёт WindowWatcher (один PowerShell-процесс).
 */

import electron from 'electron'
import type { BrowserWindow as BrowserWindowCtor, IpcMainInvokeEvent } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { computePanelBounds, WindowWatcher, type WatcherState, type WindowBounds } from './window.js'

const { app, BrowserWindow, screen, ipcMain } = electron

const HERE = path.dirname(fileURLToPath(import.meta.url))

let panel: BrowserWindowCtor | null = null
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let watcher: WindowWatcher | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let restarts = 0
let lastBoundsKey = ''
/** Panel скрыт, потому что свёрнуто окно харнеса — не трогать show/hide вручную. */
let hiddenWithHarness = false
let docked = false

const PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '0', 10)
const TOKEN = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1] ?? ''
const HARNESS_PIDS = process.argv
  .filter((a) => a.startsWith('--harness-pid='))
  .flatMap((a) => a.slice('--harness-pid='.length).split(','))
  .map((v) => parseInt(v, 10))
  .filter((v) => Number.isFinite(v) && v > 0)
const HARNESS_TITLE = process.argv.find((a) => a.startsWith('--harness-title='))?.split('=')[1]

const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'dsmap-config.json')

const config: { theme: 'dark' | 'light'; lang: 'ru' | 'en'; motion: 'full' | 'reduced' } = { theme: 'dark', lang: 'ru', motion: 'full' }

function loadConfig(): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.theme === 'light' || parsed.theme === 'dark') config.theme = parsed.theme as 'dark' | 'light'
    if (parsed.lang === 'ru' || parsed.lang === 'en') config.lang = parsed.lang as 'ru' | 'en'
    if (parsed.motion === 'full' || parsed.motion === 'reduced') config.motion = parsed.motion as 'full' | 'reduced'
  } catch {
    // нет файла — дефолты
  }
}

function saveConfig(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config), { mode: 0o600 })
  } catch {
    // конфиг не критичен, панель работает и без него
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => panel?.showInactive())
  app.whenReady().then(start)
}

async function start() {
  loadConfig()
  const display = screen.getPrimaryDisplay()
  const initial = computePanelBounds(null, display.workArea)

  // Handlers до создания окна: рендерер спрашивает конфиг на старте, и если
  // обработчик ещё не зарегистрирован, invoke отбивается и панель остаётся
  // с пустыми подписями тулбара.
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
    backgroundColor: config.theme === 'light' ? '#f5f2ea' : '#0a0c11',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(HERE, 'preload.cjs'),
    },
  })

  await panel.loadFile(path.join(HERE, 'index.html'))
  panel.showInactive()

  connectWS(PORT, TOKEN)

  // Кандидаты на окно-якорь приходят из cli.ts: терминал и сам харнес.
  // Свой ppid сюда не добавляем: у dsmap-процесса окна нет, а его дерево
  // может затянуть в список любое соседнее приложение, запустившее Electron.
  if (HARNESS_PIDS.length > 0) {
    startWatching([...new Set(HARNESS_PIDS)])
  } else {
    console.log('[ds-map] PID харнеса неизвестен — панель у правого края экрана')
  }

  panel.on('closed', () => {
    panel = null
    watcher?.stop()
    watcher = null
  })

  app.on('window-all-closed', () => {
    watcher?.stop()
    ws?.close()
    app.quit()
  })

  app.on('before-quit', () => {
    if (restartTimer) clearTimeout(restartTimer)
    watcher?.stop()
    ws?.close()
  })
}

function startWatching(pids: number[]): void {
  watcher = new WindowWatcher({
    pids,
    scriptPath: path.join(HERE, 'window-watcher.ps1'),
    ...(HARNESS_TITLE ? { title: HARNESS_TITLE } : {}),
    intervalMs: 400,
  })
  watcher.on('state', (state: WatcherState) => applyState(state))
  watcher.on('exit', () => {
    // Fail-open: наблюдатель упал — панель остаётся там, где стоит.
    if (restarts >= 2) return
    restarts++
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => startWatching(pids), 2_000)
  })
  watcher.start()
}

function applyState(state: WatcherState): void {
  if (state.kind === 'gone') {
    console.log('[ds-map] окно харнеса закрыто — панель закрывается')
    app.quit()
    return
  }
  if (state.kind === 'minimized') {
    if (panel?.isVisible()) {
      panel.hide()
      hiddenWithHarness = true
    }
    return
  }
  if (state.kind === 'pending') {
    if (!docked) console.log('[ds-map] окно харнеса не найдено — панель у правого края экрана')
    docked = true
    return
  }
  docked = true
  if (hiddenWithHarness) {
    hiddenWithHarness = false
    panel?.showInactive()
  }
  dockTo(state.bounds)
}

function dockTo(harness: WindowBounds): void {
  if (!panel) return
  const center = { x: harness.x + Math.round(harness.width / 2), y: harness.y + Math.round(harness.height / 2) }
  const display = screen.getDisplayMatching({ ...center, width: 1, height: 1 })
  const bounds = computePanelBounds(harness, display.workArea)
  const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
  if (key === lastBoundsKey) return
  lastBoundsKey = key
  // Второй параметр false — без анимации, иначе окно дрожит на каждом тике.
  panel.setBounds(bounds, false)
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
      panel?.webContents.send('status', { connected: true })
    })
    ws.on('message', (raw: Buffer) => {
      try {
        panel?.webContents.send('event', JSON.parse(raw.toString()))
      } catch {
        // битое сообщение — пропускаем, следующий кадр придёт
      }
    })
    ws.on('close', () => {
      ws = null
      panel?.webContents.send('status', { connected: false })
      scheduleReconnect(port, token)
    })
    ws.on('error', () => {
      // молча: переподключение случится на close
    })
  } catch {
    panel?.webContents.send('status', { connected: false })
    scheduleReconnect(port, token)
  }
}

function scheduleReconnect(port: number, token: string): void {
  wsReconnectTimer = setTimeout(() => connectWS(port, token), 1_000)
}
