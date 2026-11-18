/**
 * Локальный HTTP + WS сервер на 127.0.0.1 со случайным портом и токеном.
 * Окно ds-map подключается через WS и получает события в реальном времени.
 */

import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { clearEndpointFiles, portPath, tokenPath } from '../shared/config.js'
import { EventBus } from './bus.js'
import type { DsMapEvent } from '../core/events.js'

export class DaemonServer {
  private bus: EventBus
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private port: number | null = null
  private token: string | null = null
  private clients = new Set<WebSocket>()
  // Недавняя история событий, чтобы только что подключившееся окно увидело
  // сессию и уже произошедшие вызовы (реplay при подключении).
  private recent: DsMapEvent[] = []
  private readonly MAX_RECENT = 50

  constructor(bus: EventBus) {
    this.bus = bus
    this.token = randomUUID()
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Пишем токен с правами 600
      try {
        fs.mkdirSync(path.dirname(tokenPath()), { recursive: true })
        fs.writeFileSync(tokenPath(), this.token!, { mode: 0o600 })
      } catch {
        // Fail-open: без файла токена панель просто не увидит событий,
        // а харнес и сайдкар продолжают работать.
      }

      this.server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        // Токен проверяется на каждом запросе (§12.3), даже если ответ — служебная строка.
        const token = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('token')
        if (token !== this.token) {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('forbidden\n')
          return
        }
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
        // Отправить недавнюю историю только что подключившемуся клиенту,
        // чтобы оно увидело сессию и уже произошедшие события.
        for (const e of this.recent) {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e))
          } catch {
            // клиент не готов — событие дойдёт пошироковещательной рассылке пока живо
          }
        }
        ws.on('close', () => this.clients.delete(ws))
        ws.on('error', () => this.clients.delete(ws))
      })

      this.bus.subscribe((e) => this.broadcast(e))

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        try {
          fs.writeFileSync(portPath(), String(this.port))
        } catch {
          // Тот же fail-open, что и с токеном.
        }
        resolve(this.port!)
      })

      this.server.on('error', reject)
    })
  }

  private broadcast(e: DsMapEvent): void {
    this.recent.push(e)
    if (this.recent.length > this.MAX_RECENT) this.recent = this.recent.slice(-this.MAX_RECENT)
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
    // Между запусками не должно оставаться ни порта, ни токена (§12.4).
    if (this.port !== null && this.token) clearEndpointFiles({ port: this.port, token: this.token })
  }
}
