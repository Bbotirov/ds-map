import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import WebSocket from 'ws'
import { DaemonServer } from '../src/daemon/server.js'
import { EventBus } from '../src/daemon/bus.js'
import { readEndpoint } from '../src/shared/config.js'
import type { DsMapEvent } from '../src/core/events.js'

/**
 * Токен — единственное, что отделяет панель от постороннего процесса на
 * 127.0.0.1. Здесь проверяется, что он требуется на каждом входе: и в HTTP,
 * и в WebSocket, и что файлы порт/токен живут только на время работы сайдкара.
 */

let home: string | null = null
let server: DaemonServer | null = null
let socket: WebSocket | null = null

const bus = new EventBus()

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmap-server-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  socket?.close()
  socket = null
  server?.stop()
  server = null
  if (home) fs.rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
  await new Promise((r) => setTimeout(r, 0))
})

async function get(port: number, token: string | null): Promise<number> {
  const url = token === null ? `http://127.0.0.1:${port}/` : `http://127.0.0.1:${port}/?token=${token}`
  const res = await fetch(url)
  return res.status
}

/**
 * Плохое рукопожатие тоже успевает открыться: сервер закрывает сокет уже
 * после upgrade. Поэтому ждём именно закрытия с кодом, а правильный токен
 * обязан прожить всё окно ожидания.
 */
function socketOutcome(port: number, token: string): Promise<{ opened: boolean; closed: boolean; code: number }> {
  return new Promise((resolve) => {
    let opened = false
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${token}`)
    socket = ws
    const finish = (closed: boolean, code: number) => {
      clearTimeout(timer)
      resolve({ opened, closed, code })
    }
    const timer = setTimeout(() => finish(false, 0), 500)
    ws.on('open', () => {
      opened = true
    })
    ws.on('close', (code) => finish(true, code))
    ws.on('error', () => finish(true, -1))
  })
}

describe('DaemonServer', () => {
  it('сидит на 127.0.0.1 и пишет порт и токен в файлы с 600', async () => {
    server = new DaemonServer(bus)
    const port = await server.start()
    expect(port).toBeGreaterThan(0)
    const endpoint = readEndpoint()
    expect(endpoint).toEqual({ port, token: server.getToken() })
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(home!, 'dsmap-token.txt')).mode & 0o077).toBe(0)
    }
  })

  it('HTTP без токена — 403, с токеном — 200', async () => {
    server = new DaemonServer(bus)
    const port = await server.start()
    expect(await get(port, null)).toBe(403)
    expect(await get(port, 'чужой')).toBe(403)
    expect(await get(port, server.getToken()!)).toBe(200)
  })

  it('WebSocket с чужим токеном закрывается, со своим — живёт', async () => {
    server = new DaemonServer(bus)
    const port = await server.start()
    const bad = await socketOutcome(port, 'не наш')
    expect(bad.closed).toBe(true)
    expect(bad.code).toBe(1008)
    const good = await socketOutcome(port, server.getToken()!)
    expect(good.opened).toBe(true)
    expect(good.closed).toBe(false)
  })

  it('новое окно получает поздние события, а не только будущие', async () => {
    server = new DaemonServer(bus)
    const port = await server.start()
    const event = { v: 1, t: 'tool.start', ts: Date.now(), id: 'c1', name: 'read_file', station: 'files', label: 'src/app.ts' } as unknown as DsMapEvent
    bus.publish(event)

    const received: DsMapEvent[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${server.getToken()!}`)
    socket = ws
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => bus.publish({ ...event, id: 'c2' } as unknown as DsMapEvent))
      ws.on('message', (raw) => {
        received.push(JSON.parse(raw.toString()) as DsMapEvent)
        if (received.length === 2) resolve()
      })
      ws.on('error', reject)
    })
    expect(received.map((e) => (e as unknown as { id: string }).id)).toEqual(['c1', 'c2'])
  })

  it('после stop() порт и токен с диска исчезают (§12.4)', async () => {
    server = new DaemonServer(bus)
    await server.start()
    expect(readEndpoint()).not.toBeNull()
    server.stop()
    expect(readEndpoint()).toBeNull()
  })
})
