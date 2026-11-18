/**
 * Хвост сессионного JSONL харнеса DeepSeek.
 *
 * Источник событий — `~/.dsh/sessions/--<cwd>--/<session>/session.v4.jsonl`:
 * харнес дописывает его на каждый шаг, поэтому карта работает без прокси, без
 * PTY и без вторжения в GUI. Читаются только байты после прошлой позиции и
 * только имена полей; содержимое сообщений не сохраняется и не выводится (§12).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { sessionsRoot } from '../shared/config.js'
import { EventBus } from './bus.js'
import { EventMapper, type HarnessRecord } from '../core/route.js'
import type { DsMapEvent } from '../core/events.js'

const TICK_MS = 250
/** Сессию ищем не каждый тик: 78 каталогов по 4 раза в секунду ни к чему. */
const RESCAN_EVERY = 8
/** Потолок за один тик: история большой сессии не должна блокировать процесс. */
const MAX_CHUNK_BYTES = 1 << 20

/**
 * Экранирование cwd в имя каталога сессии: `c:\Users\user\Desktop\fun proj`
 * → `c-Users-user-Desktop-fun~0020proj`.
 */
export function escapeCwd(cwd: string): string {
  return cwd.replace(/:/g, '').replace(/\\/g, '-').replace(/ /g, '~0020')
}

export interface SessionLocation {
  dir: string
  file: string
}

/** Самая свежая сессия для cwd: каталоги сессий различаются только регистром диска. */
export function findLatestSession(root: string, cwd: string): SessionLocation | null {
  const prefix = `--${escapeCwd(cwd)}--`.toLowerCase()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }

  let best: SessionLocation | null = null
  let bestTime = 0

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue
    const cwdDir = path.join(root, entry.name)
    let sessions: fs.Dirent[]
    try {
      sessions = fs.readdirSync(cwdDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(cwdDir, session.name)
      const file = path.join(dir, 'session.v4.jsonl')
      let time: number
      try {
        time = fs.statSync(file).mtimeMs
      } catch {
        continue
      }
      if (time > bestTime) {
        bestTime = time
        best = { dir, file }
      }
    }
  }

  return best
}

export class SessionTailer {
  private bus: EventBus
  private mapper = new EventMapper()
  private decoder = new StringDecoder('utf8')
  private partial = ''
  private offset = 0
  private fd: number | null = null
  private location: SessionLocation | null = null
  private cwd: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private sinceRescan = RESCAN_EVERY

  constructor(bus: EventBus) {
    this.bus = bus
  }

  /** Путь файла, за которым сейчас следим, — нужен для `doctor` и для теста. */
  get currentFile(): string | null {
    return this.location?.file ?? null
  }

  start(cwd: string): void {
    this.stop()
    this.cwd = cwd
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.closeFd()
    this.cwd = null
    this.location = null
  }

  private tick(): void {
    if (!this.cwd) return
    // Пока сессии нет — ищем каждый тик; как только прицепились — раз в 2 секунды.
    if (!this.location || this.sinceRescan >= RESCAN_EVERY) {
      this.sinceRescan = 0
      const found = findLatestSession(sessionsRoot(), this.cwd)
      if (found && found.file !== this.location?.file) this.attach(found)
    } else {
      this.sinceRescan++
    }
    this.readMore()
  }

  private attach(location: SessionLocation): void {
    this.closeFd()
    this.decoder = new StringDecoder('utf8')
    this.partial = ''
    this.offset = 0
    this.mapper.reset()
    this.location = location
    try {
      this.fd = fs.openSync(location.file, 'r')
    } catch {
      this.fd = null
      this.location = null
    }
  }

  private readMore(): void {
    if (this.fd === null || !this.location) return

    let size: number
    try {
      size = fs.fstatSync(this.fd).size
    } catch {
      return
    }

    // Файл усёк или подменили — переприсоединяемся с нуля.
    if (size < this.offset) {
      this.attach(this.location)
      return
    }
    if (size === this.offset) return

    const length = Math.min(MAX_CHUNK_BYTES, size - this.offset)
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    try {
      read = fs.readSync(this.fd, buffer, 0, length, this.offset)
    } catch {
      return
    }
    if (read <= 0) return
    this.offset += read
    this.consume(buffer.subarray(0, read))
  }

  /**
   * decode через StringDecoder: многобайтные символы режутся на границе
   * чтения, а не на границе строки. Неполная хвостовая строка ждёт продолжения.
   */
  private consume(chunk: Buffer): void {
    const text = this.partial + this.decoder.write(chunk)
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) this.emitLine(line)
  }

  private emitLine(line: string): void {
    if (!line.trim()) return
    let record: HarnessRecord
    try {
      record = JSON.parse(line) as HarnessRecord
    } catch {
      return
    }

    let events: DsMapEvent[]
    try {
      events = this.mapper.map(record)
    } catch {
      // Fail-open (§7 правило 10): битая запись не роняет ни хвост, ни харнес.
      return
    }

    // Конец хода закрывает всё, что не дожило до результата вызова.
    const ended = events.find((e) => e.t === 'answer')
    if (ended) events = events.concat(this.mapper.closeDangling(ended.ts))

    for (const event of events) this.bus.publish(event)
  }

  private closeFd(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        // уже закрыт
      }
      this.fd = null
    }
  }
}
