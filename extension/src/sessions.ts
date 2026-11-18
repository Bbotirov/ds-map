/**
 * Список сессий харнеса для команды «выбрать сессию» и для автооткрытия.
 *
 * Формат каталога — контракт с `src/daemon/session.ts`:
 * `~/.dsh/sessions/--<escaped cwd>--/<session id>/session.v4.jsonl`.
 * Расширение собирается отдельно от dist/, поэтому правила экранирования
 * продублированы здесь; расхождение даёт «сессий нет» вместо внятной ошибки.
 *
 * Файл сессии НЕ читается: внутри лежат `session/title` и `job/registered.label`
 * — текст из разговора и сырая командная строка. В список идут только id
 * каталога и время записи (§12).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const SESSION_FILE = 'session.v4.jsonl'
/** Сессия считается живой, если харнес писал в неё меньше этого числа мс назад. */
export const LIVE_MS = 90_000

/** `c:\Users\user\Desktop\fun proj` → `c-Users-user-Desktop-fun~0020proj`. */
export function escapeCwd(cwd: string): string {
  return cwd.replace(/:/g, '').replace(/\\/g, '-').replace(/ /g, '~0020')
}

export interface SessionEntry {
  id: string
  dir: string
  file: string
  mtimeMs: number
}

export interface FsLike {
  readdir(dir: string): { name: string; isDirectory(): boolean }[]
  /** `null` — файла нет или он не читается: такую сессию не показываем. */
  mtime(file: string): number | null
}

export const nodeFs: FsLike = {
  readdir: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
  mtime: (file) => {
    try {
      return fs.statSync(file).mtimeMs
    } catch {
      return null
    }
  },
}

/**
 * Все сессии каталога, свежие сначала. Каталог cwd ищется без учёта регистра:
 * харнес пишет диск строчной буквой (`c-...`), а Windows отдаёт `C:\`.
 */
export function listSessions(root: string, cwd: string, read: FsLike = nodeFs): SessionEntry[] {
  const prefix = `--${escapeCwd(cwd)}--`.toLowerCase()
  let dirs: { name: string; isDirectory(): boolean }[]
  try {
    dirs = read.readdir(root)
  } catch {
    return []
  }

  const out: SessionEntry[] = []
  for (const entry of dirs) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue
    let sessions: { name: string; isDirectory(): boolean }[]
    try {
      sessions = read.readdir(path.join(root, entry.name))
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(root, entry.name, session.name)
      const file = path.join(dir, SESSION_FILE)
      const mtimeMs = read.mtime(file)
      if (mtimeMs === null || !Number.isFinite(mtimeMs)) continue
      out.push({ id: session.name, dir, file, mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function isLive(entry: SessionEntry | undefined, now: number, liveMs = LIVE_MS): boolean {
  if (!entry) return false
  const age = now - entry.mtimeMs
  // Отрицательный возраст — часы разъехались: молча считаем живой, иначе
  // автооткрытие перестанет работать на машине с переведённым временем.
  return age <= liveMs
}

/** Человекочитаемый возраст: «только что», «4 мин назад», «2 ч назад». */
export function relativeTime(mtimeMs: number, now: number): string {
  const sec = Math.max(0, Math.round((now - mtimeMs) / 1000))
  if (sec < 45) return 'только что'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} мин назад`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours} ч назад`
  return `${Math.round(hours / 24)} дн назад`
}
