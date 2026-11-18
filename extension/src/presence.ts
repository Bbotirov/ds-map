/**
 * Присутствие: чей экран занят панелью.
 *
 * Окно Electron и webview в VS Code рисуют одну и ту же карту. Если оба
 * claim-ят экран, пользователь получает дублирующуюся полосу поперёк монитора.
 * Каждый носитель пишет `~/.dsh/dsmap-dock.<pid>.json` с {"pid":…,"t":…} каждые
 * 2 с; запись свежая, пока `t` моложе 5 с. Аварийное завершение оставляет мусор,
 * который сам выметается через 60 с — вечной блокировки не бывает по построению.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const BEAT_MS = 2_000
/** Запись считается живой, пока `t` моложе этого порога (2 тика с запасом). */
export const FRESH_MS = 5_000
/** Мусор от упавшего процесса выметается через минуту. */
export const STALE_MS = 60_000

export const FILE_PREFIX = 'dsmap-dock.'
export const FILE_SUFFIX = '.json'

export interface Presence {
  pid: number
  t: number
}

export interface PresenceFs {
  mkdir(dir: string): void
  write(file: string, text: string): void
  read(file: string): string | null
  remove(file: string): void
  list(dir: string): string[]
}

export const nodePresenceFs: PresenceFs = {
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  // Временный файл + rename: читатель никогда не увидит половину JSON.
  write: (file, text) => {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, file)
  },
  read: (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  remove: (file) => {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // уже убран или права заняты — не беда, файл протухнет сам
    }
  },
  list: (dir) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  },
}

export function dockFile(dir: string, pid: number): string {
  return path.join(dir, `${FILE_PREFIX}${pid}${FILE_SUFFIX}`)
}

export function encodePresence(pid: number, t: number): string {
  return JSON.stringify({ pid, t })
}

/** Файл мог быть испорчен половинной записью — возвращаем null, а не падаем. */
export function decodePresence(raw: string): Presence | null {
  try {
    const p = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
    if (!p || typeof p !== 'object') return null
    const pid = p.pid
    const t = p.t
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    if (typeof t !== 'number' || !Number.isFinite(t)) return null
    return { pid, t }
  } catch {
    return null
  }
}

export function pidFromName(name: string): number | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null
  const raw = name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length)
  return /^\d+$/.test(raw) ? Number(raw) : null
}

export function isFresh(presence: Presence | null, now: number, freshMs = FRESH_MS): boolean {
  if (!presence) return false
  const age = now - presence.t
  // Отрицательный возраст — разъехавшиеся часы: считаем живым, иначе панель
  // на машине с вперёд идущими часами навсегда осталась бы без карты.
  return age <= freshMs
}

export function isStale(presence: Presence, now: number, staleMs = STALE_MS): boolean {
  return now - presence.t > staleMs
}

export interface SweepInput {
  name: string
  presence: Presence | null
}

/**
 * Что удалять из каталога. Прочитать и решить разделены: решение — чистая
 * функция, и её проверяют тесты, а не только живой запуск.
 */
export function sweepPlan(entries: SweepInput[], now: number, staleMs = STALE_MS): string[] {
  const doomed: string[] = []
  for (const entry of entries) {
    if (pidFromName(entry.name) === null) continue
    // Битая запись не пройдёт по времени никогда — её тоже выметаем.
    if (!entry.presence || isStale(entry.presence, now, staleMs)) doomed.push(entry.name)
  }
  return doomed
}

export interface HeartbeatDeps {
  dir: string
  fsLike?: PresenceFs
  pid?: number
  now?: () => number
  /** diag — имя события/число, содержимое логов харнеса сюда не попадает. */
  log?: (message: string) => void
}

/** Инжектируется в webview-провайдера: бьётся, пока панель видима. */
export class DockHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly fsLike: PresenceFs
  private readonly pid: number
  private readonly now: () => number
  private readonly log: (message: string) => void
  private running = false

  constructor(private readonly deps: HeartbeatDeps) {
    this.fsLike = deps.fsLike ?? nodePresenceFs
    this.pid = deps.pid ?? process.pid
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => undefined)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.beat()
    this.timer = setInterval(() => this.beat(), BEAT_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      this.fsLike.remove(dockFile(this.deps.dir, this.pid))
    } catch (err) {
      this.note(`не снял heartbeat: ${name(err)}`)
    }
  }

  /** Один тик + выметание чужого мусора. Любой сбой ловится: панель не виновата. */
  beat(): void {
    const now = this.now()
    try {
      this.fsLike.mkdir(this.deps.dir)
      this.fsLike.write(dockFile(this.deps.dir, this.pid), encodePresence(this.pid, now))
      this.sweep(now)
    } catch (err) {
      // Диск занят, каталога нет, права отказали — heartbeat не должен ронять редактор.
      this.note(`heartbeat пропущен: ${name(err)}`)
    }
  }

  private sweep(now: number): void {
    const entries: SweepInput[] = this.fsLike.list(this.deps.dir).map((name) => ({
      name,
      presence: name.startsWith(FILE_PREFIX) ? this.readPresence(name) : null,
    }))
    for (const name of sweepPlan(entries, now)) {
      const pid = pidFromName(name)
      // Свой файл только что перезаписан, он не пройдёт по возрасту — но на
      // случай скачка часов удаляем чужое и никогда своего.
      if (pid === null || pid === this.pid) continue
      this.fsLike.remove(path.join(this.deps.dir, name))
    }
  }

  private readPresence(name: string): Presence | null {
    const raw = this.fsLike.read(path.join(this.deps.dir, name))
    return raw === null ? null : decodePresence(raw)
  }

  /** Есть ли другой живой носитель карты (окно Electron при пристыкованном webview молчит). */
  claimedByOther(): boolean {
    const now = this.now()
    for (const name of this.fsLike.list(this.deps.dir)) {
      const pid = pidFromName(name)
      if (pid === null || pid === this.pid) continue
      if (isFresh(this.readPresence(name), now)) return true
    }
    return false
  }

  private note(message: string): void {
    try {
      this.log(message)
    } catch {
      // логирование не должно ронять heartbeat
    }
  }
}

/** Только имя ошибки: в `message` Node печатает куски входа, они не для логов (§12.6). */
function name(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
