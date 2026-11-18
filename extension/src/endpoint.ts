/**
 * Пути и эндпоинт сайдкара на стороне расширения.
 *
 * Зеркало `src/shared/config.ts`: расширение собирается своим tsc со своим
 * rootDir и импортировать dist/ не может — иначе .vsix зависел бы от того,
 * собран ли проект. Формат файлов тут единственный контракт с сайдкаром,
 * поэтому расхождение в одном символе = «панель не видит события».
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface Endpoint {
  port: number
  token: string
}

/** Дом харнеса: тот же `DSH_HOME`, что и у сайдкара, иначе ищем не там. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DSH_HOME ||
    path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), '.dsh')
  )
}

export function portPath(home = dshHome()): string {
  return path.join(home, 'dsmap-port.txt')
}

export function tokenPath(home = dshHome()): string {
  return path.join(home, 'dsmap-token.txt')
}

export function configFile(home = dshHome()): string {
  return path.join(home, 'dsmap-config.json')
}

export function sessionsRoot(home = dshHome()): string {
  return path.join(home, 'sessions')
}

/**
 * Разбор содержимого файлов эндпоинта. Порт обязан быть числом в диапазоне,
 * токен — непустой строкой без переносов, иначе соединение ушло бы на
 * 127.0.0.1:NaN с токеном в две строки.
 */
export function parseEndpoint(portRaw: string, tokenRaw: string): Endpoint | null {
  const text = portRaw.trim()
  if (!/^\d+$/.test(text)) return null
  const port = Number(text)
  if (port <= 0 || port > 65_535) return null
  const token = tokenRaw.trim()
  if (!token || /[\r\n]/.test(token)) return null
  return { port, token }
}

/** Файлы могут быть удалены в момент между запусками — это не ошибка, а «сайдака нет». */
export function readEndpoint(read: (p: string) => string, home = dshHome()): Endpoint | null {
  try {
    return parseEndpoint(read(portPath(home)), read(tokenPath(home)))
  } catch {
    return null
  }
}

export interface UiConfig {
  theme: 'dark' | 'light'
  lang: 'ru' | 'en'
  motion: 'full' | 'reduced'
}

export const DEFAULT_CONFIG: UiConfig = { theme: 'dark', lang: 'ru', motion: 'full' }

/** Значения из файла недоверенные: чужое поле не должно попасть в webview. */
export function normalizeConfig(raw: unknown): UiConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG }
  const p = raw as Record<string, unknown>
  return {
    theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : DEFAULT_CONFIG.theme,
    lang: p.lang === 'ru' || p.lang === 'en' ? p.lang : DEFAULT_CONFIG.lang,
    motion: p.motion === 'reduced' || p.motion === 'full' ? p.motion : DEFAULT_CONFIG.motion,
  }
}

export function readConfig(read: (p: string) => string, home = dshHome()): UiConfig {
  try {
    // BOM: PowerShell 5.1 пишет его всегда, а JSON.parse на нём падает.
    return normalizeConfig(JSON.parse(read(configFile(home)).replace(/^\uFEFF/, '')))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Правка общих настроек. Файл принадлежит не только расширению: окно панели
 * хранит там `pause`, `счётчики` и всё, что добавит позже. Поэтому читаем цель
 * объектом, правим только свои три поля и пишем обратно — иначе клик по «тема»
 * в webview молча стирал бы чужие настройки.
 */
export function patchConfig(patch: Partial<UiConfig>, home = dshHome()): UiConfig {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(home), 'utf8').replace(/^\uFEFF/, '')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
  } catch {
    // нет файла или битый JSON — начинаем с чистых дефолтов
  }
  const current = normalizeConfig(raw)
  const next: UiConfig = {
    theme: patch.theme ?? current.theme,
    lang: patch.lang ?? current.lang,
    motion: patch.motion ?? current.motion,
  }
  try {
    fs.mkdirSync(path.dirname(configFile(home)), { recursive: true })
    fs.writeFileSync(configFile(home), JSON.stringify({ ...raw, ...next }, null, 2), { mode: 0o600 })
  } catch {
    // Настройки не критичны: без файла панель работает с дефолтами.
  }
  return next
}

export function writeConfig(config: UiConfig, home = dshHome()): void {
  try {
    fs.mkdirSync(path.dirname(configFile(home)), { recursive: true })
    fs.writeFileSync(configFile(home), JSON.stringify(config), { mode: 0o600 })
  } catch {
    // Настройки не критичны: без файла панель работает с дефолтами.
  }
}
