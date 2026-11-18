/**
 * Единые пути и форма настроек ds-map.
 *
 * Сайдкар, окно и doctor раньше собирали пути к токену, порту и конфигу
 * каждый своей строкой: расхождение в одном сегменте ломает подключение, и
 * выглядит это как «панель не видит события». Здесь один источник истины.
 *
 * `DSH_HOME` задаёт домашнюю папку харнеса — тот же оверрайд, что и в
 * `daemon/session.ts`, иначе doctor ищет сессии не там, где хвост.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export function dshHome(): string {
  return (
    process.env.DSH_HOME ||
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? os.homedir(), '.dsh')
  )
}

export function tokenPath(): string {
  return path.join(dshHome(), 'dsmap-token.txt')
}

export function portPath(): string {
  return path.join(dshHome(), 'dsmap-port.txt')
}

export function configPath(): string {
  return path.join(dshHome(), 'dsmap-config.json')
}

export function sessionsRoot(): string {
  return path.join(dshHome(), 'sessions')
}

/** Настройки панели. Всё остальное в файле конфига игнорируется. */
export interface DsMapConfig {
  theme: 'dark' | 'light'
  lang: 'ru' | 'en'
  motion: 'full' | 'reduced'
}

export const DEFAULT_CONFIG: DsMapConfig = { theme: 'dark', lang: 'ru', motion: 'full' }

/** Значения из файла недоверенные: чужое поле или мусорный тип не должны попадать в UI. */
export function normalizeConfig(raw: unknown): DsMapConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG }
  const p = raw as Record<string, unknown>
  return {
    theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : DEFAULT_CONFIG.theme,
    lang: p.lang === 'ru' || p.lang === 'en' ? p.lang : DEFAULT_CONFIG.lang,
    motion: p.motion === 'reduced' || p.motion === 'full' ? p.motion : DEFAULT_CONFIG.motion,
  }
}

export function readConfig(): DsMapConfig {
  try {
    // BOM в начале ломает JSON.parse, а PowerShell 5.1 пишет его всегда.
    const text = fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '')
    return normalizeConfig(JSON.parse(text))
  } catch {
    // Нет файла или битый JSON — дефолты, панель всё равно открывается.
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(config: DsMapConfig): void {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(config), { mode: 0o600 })
  } catch {
    // Настройки не критичны: без файла конфига панель работает.
  }
}

export interface Endpoint {
  port: number
  token: string
}

/**
 * Разбор содержимого файлов сайдкара. Чистая функция: порт обязан быть числом
 * в диапазоне, токен — непустой строкой без переносов, иначе соединение
 * ушло бы в 127.0.0.1:NaN.
 */
export function parseEndpointFiles(portRaw: string, tokenRaw: string): Endpoint | null {
  const text = portRaw.trim()
  const port = Number(text)
  if (!/^\d+$/.test(text) || port <= 0 || port > 65535) return null
  const token = tokenRaw.trim()
  if (!token || /[\r\n]/.test(token)) return null
  return { port, token }
}

export function readEndpoint(): Endpoint | null {
  try {
    return parseEndpointFiles(fs.readFileSync(portPath(), 'utf8'), fs.readFileSync(tokenPath(), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Убирает файлы сайдкара: между запусками ничего не остаётся (§12.4).
 * Удаляем только когда в файле записаны наши значения — иначе есть шанс
 * стереть порт и токен параллельного запуска.
 */
export function clearEndpointFiles(expected: Endpoint): void {
  for (const [file, value] of [
    [portPath(), String(expected.port)],
    [tokenPath(), expected.token],
  ] as const) {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === value.trim()) fs.rmSync(file, { force: true })
    } catch {
      // файла нет — нечего и удалять
    }
  }
}
