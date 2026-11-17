/**
 * Локальный HTTP + WS сервер на 127.0.0.1 со случайным портом и токеном.
 * Окно ds-map подключается через WS и получает события в реальном времени.
 */

import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventBus } from './bus.js'
import type { DsMapEvent } from '../core/events.js'

const TOKEN_PATH = path.join(os.homedir(), '.dsh', 'dsmap-token.txt')
const PORT_FILE = path.join(os.homedir(), '.dsh', 'dsmap-port.txt')

export class DaemonServer {
  private bus: EventBus
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private port: number | null = null
  private token: string | null = null
  private clients = new Set<WebSocket>()

  constructor(bus: EventBus) {
    this.bus = bus
    this.token = randomUUID()
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Пишем токен с правами 600
      try {
        fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
        fs.writeFileSync(TOKEN_PATH, this.token!, { mode: 0o600 })
      } catch {
        // игнорируем ошибки записи токена
      }

      this.server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ds-map daemon\n')
      })

      this.wss = new WebSocketServer({ server: this.server })

      this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
        const url = new URL(req.url ?? '', `http://${req.headers.host}`)
        const token = url.searchParams.get('token')
        if (token !== this.token) {
          ws.close(1008, 'invalid token')
          return
        }
        this.clients.add(ws)
        ws.on('close', () => this.clients.delete(ws))
        ws.on('error', () => this.clients.delete(ws))
      })

      this.bus.subscribe((e) => this.broadcast(e))

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        try {
          fs.writeFileSync(PORT_FILE, String(this.port))
        } catch {
          // игнорируем
        }
        resolve(this.port!)
      })

      this.server.on('error', reject)
    })
  }

  private broadcast(e: DsMapEvent): void {
    const msg = JSON.stringify(e)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg)
        } catch {
          this.clients.delete(ws)
        }
      }
    }
  }

  getPort(): number | null {
    return this.port
  }

  getToken(): string | null {
    return this.token
  }

  stop(): void {
    this.clients.forEach((ws) => ws.close())
    this.clients.clear()
    this.wss?.close()
    this.server?.close()
  }
}
