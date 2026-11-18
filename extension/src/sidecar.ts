/**
 * Клиент сайдкара: WS на 127.0.0.1 с портом и токеном из файлов `~/.dsh`.
 *
 * Соединение держит HOST расширения, а не webview: чистая webview не должна
 * ни знать токена, ни уметь ходить в сеть (CSP `default-src 'none'`), а
 * токен в DOM утёк бы через любое расширение-заметки (§12.3).
 *
 * Fail-open: нет файлов, сайдкар лег, сокет упал — reconnect и тихая строка
 * статуса. Ни один из этих случаев не должен показать исключение в редакторе.
 */

export interface SocketHandle {
  close(): void
}

export interface SocketHandlers {
  onOpen(): void
  onMessage(text: string): void
  onClose(): void
}

export type Connector = (url: string, handlers: SocketHandlers) => Promise<SocketHandle>

export interface EndpointSource {
  /** Порт и токен или `null`, если сайдкара сейчас нет. */
  read(): { port: number; token: string } | null
}

export interface SidecarDeps {
  endpoint: EndpointSource
  onEvent: (raw: unknown) => void
  onStatus: (connected: boolean) => void
  connect?: Connector
  retryMs?: number
  maxRetryMs?: number
  log?: (message: string) => void
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

interface WsLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(): void
}

const defaultConnector: Connector = async (url, handlers) => {
  const Ctor = await loadWebSocket()
  if (!Ctor) throw new Error('no websocket implementation')
  const socket = new Ctor(url)
  socket.onopen = () => handlers.onOpen()
  socket.onmessage = (event) => handlers.onMessage(toText(event.data))
  socket.onclose = () => handlers.onClose()
  socket.onerror = () => handlers.onClose()
  return {
    close: () => {
      try {
        socket.onopen = null
        socket.onmessage = null
        socket.onclose = null
        socket.onerror = null
        socket.close()
      } catch {
        // уже закрыт
      }
    },
  }
}

/** Буфер от `ws`, строка от браузерного API или ArrayBuffer — всё к одному виду. */
function toText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  if (Array.isArray(data)) return data.map(toText).join('')
  return ''
}

async function loadWebSocket(): Promise<(new (url: string) => WsLike) | null> {
  const ambient = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof ambient === 'function') return ambient as new (url: string) => WsLike
  try {
    // Динамический импорт: в собранном расширении его нет, и это нормально —
    // тогда панель живёт без соединения, но редактор работает.
    const mod = (await import('ws')) as unknown as { WebSocket?: new (url: string) => WsLike }
    return mod.WebSocket ?? null
  } catch {
    return null
  }
}

export class SidecarClient {
  private readonly connect: Connector
  private readonly retryMs: number
  private readonly maxRetryMs: number
  private readonly log: (message: string) => void
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void
  private socket: SocketHandle | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private delay: number
  private started = false
  private connectedFlag = false

  constructor(private readonly deps: SidecarDeps) {
    this.connect = deps.connect ?? defaultConnector
    this.retryMs = deps.retryMs ?? 2_000
    this.maxRetryMs = deps.maxRetryMs ?? 10_000
    this.delay = this.retryMs
    this.log = deps.log ?? (() => undefined)
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  }

  get connected(): boolean {
    return this.connectedFlag
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule(0)
  }

  stop(): void {
    this.started = false
    if (this.timer) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    this.setStatus(false)
    try {
      socket?.close()
    } catch {
      // сокет мог умереть вместе с сайдкаром
    }
  }

  /**
   * Переподключение с нуля: при новом коннекте сайдкар сам досылает недавнюю
   * историю, поэтому «проиграть последнюю запись» — это перезапуск канала,
   * а не чтение журнала расширением.
   */
  restart(): void {
    this.stop()
    this.delay = this.retryMs
    this.start()
  }

  private schedule(ms: number): void {
    if (!this.started || this.timer) return
    this.timer = this.setTimeoutFn(() => {
      this.timer = null
      void this.open()
    }, ms)
    // Таймер не должен удерживать хост расширения.
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  private setStatus(value: boolean): void {
    if (this.connectedFlag === value) return
    this.connectedFlag = value
    try {
      this.deps.onStatus(value)
    } catch {
      // наблюдатель не должен ронять канал
    }
  }

  private async open(): Promise<void> {
    if (!this.started) return
    let endpoint: { port: number; token: string } | null = null
    try {
      endpoint = this.deps.endpoint.read()
    } catch {
      endpoint = null
    }
    if (!endpoint) {
      this.setStatus(false)
      this.schedule(this.retryMs)
      return
    }

    // URL с токеном не логируется и не уходит в webview — только порт.
    const url = `ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`
    try {
      const socket = await this.connect(url, {
        onOpen: () => {
          this.setStatus(true)
          this.delay = this.retryMs
        },
        onMessage: (text) => this.handleLine(text),
        onClose: () => {
          this.socket = null
          this.setStatus(false)
          this.backoff()
        },
      })
      this.socket = socket
    } catch (err) {
      this.log(`соединение с сайдкаром не поднялось (${nameOf(err)}), порт ${endpoint.port}`)
      this.setStatus(false)
      this.backoff()
    }
  }

  private handleLine(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Сторонняя строка в наш порт — не событие, игнорируем молча.
      return
    }
    try {
      this.deps.onEvent(parsed)
    } catch {
      // Обработчик карты не должен ронять сокет (§7 правило 10).
    }
  }

  private backoff(): void {
    const wait = this.delay
    this.delay = Math.min(this.maxRetryMs, this.delay * 2)
    this.schedule(wait)
  }
}

/** В лог — только имя ошибки: в `message` Node кладёт куски входа (§12.6). */
function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
