/**
 * Electron main process — оболочка окна ds-map.
 * Единственный экземпляр, безопасные webPreferences, подключение к сайдкару через WS.
 */

import { app, BrowserWindow, screen, ipcMain } from 'electron'
import * as path from 'node:path'
import WebSocket from 'ws'

let panel: BrowserWindow | null = null
let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

const PORT = parseInt(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '0', 10)
const TOKEN = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1] ?? ''

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => panel?.showInactive())
  app.whenReady().then(start)
}

async function start() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  panel = new BrowserWindow({
    width: 420,
    height: 800,
    x: Math.max(0, width - 420 - 8),
    y: 80,
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

  await panel.loadFile(path.join(__dirname, 'index.html'))
  panel.showInactive()

  connectWS(PORT, TOKEN)

  // IPC handlers для конфига
  ipcMain.handle('config:get', () => ({ theme: 'dark', lang: 'ru', motion: 'full' }))
  ipcMain.handle('config:set', (_e, patch: unknown) => patch)

  app.on('window-all-closed', () => {
    ws?.close()
    app.quit()
  })

  app.on('before-quit', () => {
    ws?.close()
  })
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
