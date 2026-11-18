/**
 * Electron main process — оболочка окна ds-map.
 * Единственный экземпляр, безопасные webPreferences, подключение к сайдкару через WS.
 * Пристёгивание к окну харнеса справа: геометрию даёт WindowWatcher (один PowerShell-процесс).
 */

import electron from 'electron'
import type { BrowserWindow as BrowserWindowCtor, IpcMainInvokeEvent } from 'electron'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { computePanelBounds, WindowWatcher, type WatcherState, type WindowBounds } from './window.js'
import { probeSidecar, startLauncherWatch } from './launcher-watch.js'
import { normalizeConfig, readConfig, readEndpoint, writeConfig, type DsMapConfig, type Endpoint } from '../shared/config.js'

const { app, BrowserWindow, screen, ipcMain, Menu } = electron

const HERE = path.dirname(fileURLToPath(import.meta.url))

let panel: BrowserWindowCtor | null = null
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let watcher: WindowWatcher | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null
let restarts = 0
let lastBoundsKey = ''
let stopLauncherWatch: (() => void) | null = null
/** Panel скрыт, потому что свёрнуто окно харнеса — не трогать show/hide вручную. */
let hiddenWithHarness = false
let docked = false

// Аргументы — только для ручного запуска панели (`electron dist/ui/main.js --port=…`).
// В нормальном режиме порт и токен через командную строку не передаются: в argv
// токен увидел бы любой, кто перечисляет процессы, а §12 требует файл с 600.
const ARG_PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '0', 10)
const ARG_TOKEN = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1] ?? ''
const HARNESS_PIDS = process.argv
  .filter((a) => a.startsWith('--harness-pid='))
  .flatMap((a) => a.slice('--harness-pid='.length).split(','))
  .map((v) => parseInt(v, 10))
  .filter((v) => Number.isFinite(v) && v > 0)
const HARNESS_TITLE = process.argv.find((a) => a.startsWith('--harness-title='))?.split('=')[1]
/** Окно терминала, к которому пристёгиваться: его хэндл знает только лаунчер. */
const ANCHOR_HWND = parseInt(process.argv.find((a) => a.startsWith('--anchor-hwnd='))?.split('=')[1] ?? '0', 10)

const config: DsMapConfig = readConfig()

/** Перечитывается на каждом подключении: сайдкар мог перезапуститься на новом порту. */
function resolveEndpoint(): Endpoint | null {
  if (ARG_PORT > 0 && ARG_TOKEN) return { port: ARG_PORT, token: ARG_TOKEN }
  return readEndpoint()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => panel?.showInactive())
  app.whenReady().then(start)
}

async function start() {
  // Читатель stdout/stderr панели — процесс лаунчера. Когда лаунчер убит, pipe
  // рвётся, Node бросает EPIPE из console.log, и без обработчика панель падает
  // в тот же миг — раньше, чем успевает сама решить, что лаунчер умер.
  process.stdout?.on('error', () => undefined)
  process.stderr?.on('error', () => undefined)
  // Родное меню Electron (File/Edit/View…) съедает 25 px и не несёт ничего
  // полезного: в панели всё управление уже есть в тулбаре.
  Menu.setApplicationMenu(null)
  const display = screen.getPrimaryDisplay()
  const initial = computePanelBounds(null, display.workArea)

  // Handlers до создания окна: рендерер спрашивает конфиг на старте, и если
  // обработчик ещё не зарегистрирован, invoke отбивается и панель остаётся
  // с пустыми подписями тулбара.
  ipcMain.handle('config:get', () => ({ ...config }))
  ipcMain.handle('config:set', (_e: IpcMainInvokeEvent, patch: unknown) => {
    const incoming = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
    // normalizeConfig — единственный валидатор: поля вне списка и мусорные значения
    // в конфиг не попадают ниоткуда, включая ручную правку файла.
    Object.assign(config, normalizeConfig({ ...config, ...incoming }))
    writeConfig(config)
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

  connectWS()

  // Кандидаты на окно-якорь приходят из cli.ts: терминал и сам харнес.
  // Свой ppid сюда не добавляем: у dsmap-процесса окна нет, а его дерево
  // может затянуть в список любое соседнее приложение, запустившее Electron.
  const anchorHwnd = Number.isFinite(ANCHOR_HWND) ? ANCHOR_HWND : 0
  if (HARNESS_PIDS.length > 0 || anchorHwnd > 0) {
    startWatching([...new Set(HARNESS_PIDS)], anchorHwnd)
  } else {
    console.log('[ds-map] якоря нет (ни PID харнеса, ни окна консоли) — панель у правого края экрана')
  }
  watchLauncher()

  panel.on('closed', () => {
    panel = null
    watcher?.stop()
    watcher = null
  })

  app.on('window-all-closed', () => {
    watcher?.stop()
    stopLauncherWatch?.()
    ws?.close()
    app.quit()
  })

  app.on('before-quit', () => {
    if (restartTimer) clearTimeout(restartTimer)
    watcher?.stop()
    stopLauncherWatch?.()
    ws?.close()
  })
}

/**
 * Сигнал «лаунчера больше нет» — молчание порта его сайдкара. Сам лаунчер
 * передаёт свой PID только как признак режима: опрос PID и EOF на stdin на
 * Windows оба врут (подробности в `launcher-watch.ts`).
 */
function watchLauncher(): void {
  if (!process.env.DSMAP_OWNER_PID) return
  stopLauncherWatch = startLauncherWatch({
    endpoint: resolveEndpoint,
    probe: probeSidecar,
    onGone: (reason) => {
      console.log(
        reason === 'endpoint-gone'
          ? '[ds-map] лаунчер завершился — панель закрывается'
          : '[ds-map] сайдкар не отвечает — панель закрывается',
      )
      app.quit()
    },
  })
}

function startWatching(pids: number[], hwnd: number): void {
  watcher = new WindowWatcher({
    pids,
    scriptPath: path.join(HERE, 'window-watcher.ps1'),
    ...(hwnd > 0 ? { hwnd } : {}),
    ...(HARNESS_TITLE ? { title: HARNESS_TITLE } : {}),
    intervalMs: 400,
  })
  watcher.on('state', (state: WatcherState) => applyState(state))
  watcher.on('exit', () => {
    // Fail-open: наблюдатель упал — панель остаётся там, где стоит.
    if (restarts >= 2) return
    restarts++
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => startWatching(pids, hwnd), 2_000)
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

function connectWS(): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }

  const endpoint = resolveEndpoint()
  if (!endpoint) {
    // Сайдкар ещё не записал порт и токен — пробуем снова, как при обрыве.
    scheduleReconnect()
    return
  }

  try {
    ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}/events?token=${endpoint.token}`)
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
      scheduleReconnect()
    })
    ws.on('error', () => {
      // молча: переподключение случится на close
    })
  } catch {
    panel?.webContents.send('status', { connected: false })
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  wsReconnectTimer = setTimeout(connectWS, 1_000)
}
