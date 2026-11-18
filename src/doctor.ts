/**
 * dsmap doctor — «почему панель пустая» за одну команду.
 *
 * Проверяет то, без чего запуск молча делает вид, что работает: собран ли dist,
 * есть ли electron и dsh, видит ли хвост сессионный JSONL для текущего cwd,
 * отвечает ли сайдкар.
 * Вывод — имена проверок, пути и тайминги; содержимое сессий здесь не печатается (§12).
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { findLatestSession } from './daemon/session.js'
import { configPath, portPath, readEndpoint, sessionsRoot, tokenPath, type Endpoint } from './shared/config.js'

const require = createRequire(import.meta.url)
// dist/doctor.js → корень пакета. От текущего каталога проверок сборки зависит
// запуск `dsh-map` из любого проекта, поэтому cwd для этого не используется.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type CheckStatus = 'ok' | 'fail' | 'info'

export interface Check {
  name: string
  status: CheckStatus
  detail?: string
}

const MARK: Record<CheckStatus, string> = { ok: '✓', fail: '✗', info: '–' }

export function formatCheck(check: Check): string {
  return `${MARK[check.status]} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`
}

/** Падает только на честной поломке: `info` — это «пока не запущено», а не ошибка. */
export function exitCodeFor(checks: Check[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0
}

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
}

function checkRuntime(): Check {
  return nodeMajor() >= 20
    ? { name: 'Node', status: 'ok', detail: process.versions.node }
    : { name: 'Node', status: 'fail', detail: `нужен 20+, стоит ${process.versions.node}` }
}

function checkBuild(): Check {
  const needed = ['cli.js', path.join('ui', 'main.js'), path.join('ui', 'index.html'), path.join('ui', 'preload.cjs'), path.join('ui', 'window-watcher.ps1')]
  const missing = needed.filter((rel) => !fs.existsSync(path.join(PKG_ROOT, 'dist', rel)))
  return missing.length === 0
    ? { name: 'Сборка', status: 'ok', detail: 'dist готов' }
    : { name: 'Сборка', status: 'fail', detail: `нет ${missing.join(', ')} — запустите pnpm build` }
}

function checkElectron(): Check {
  try {
    const exe = path.join(path.dirname(require.resolve('electron')), 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
    return fs.existsSync(exe)
      ? { name: 'Electron', status: 'ok', detail: exe }
      : { name: 'Electron', status: 'fail', detail: `бинарник не найден в ${path.dirname(exe)} — pnpm install` }
  } catch {
    return { name: 'Electron', status: 'fail', detail: 'пакет electron не разрешён — pnpm install' }
  }
}

function checkHarness(): Check {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const res = spawnSync(finder, ['dsh'], { encoding: 'utf8' })
  const found = res.status === 0 ? res.stdout.split(/\r?\n/)[0]?.trim() : ''
  return found
    ? { name: 'Харнес', status: 'ok', detail: found }
    : { name: 'Харнес', status: 'fail', detail: 'dsh не в PATH' }
}

function checkSession(cwd: string): Check {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) {
    return { name: 'Каталог сессий', status: 'fail', detail: `${root} не существует — харнес ещё ни разу не запускался?` }
  }
  const found = findLatestSession(root, cwd)
  return found
    ? { name: 'Сессия для cwd', status: 'ok', detail: path.basename(path.dirname(found.file)) }
    : { name: 'Сессия для cwd', status: 'info', detail: 'нет ни одной записи — панель будет пуста до первого хода' }
}

async function checkSidecar(endpoint: Endpoint | null): Promise<Check> {
  if (!endpoint) {
    const any = fs.existsSync(portPath()) || fs.existsSync(tokenPath())
    return {
      name: 'Сайдкар',
      status: any ? 'fail' : 'info',
      detail: any ? `порт или токен в ${path.dirname(portPath())} битые` : 'не запущен (нужен dsmap run)',
    }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`, {
      signal: AbortSignal.timeout(1_500),
    })
    return res.ok
      ? { name: 'Сайдкар', status: 'ok', detail: `127.0.0.1:${endpoint.port} отвечает` }
      : { name: 'Сайдкар', status: 'fail', detail: `127.0.0.1:${endpoint.port} ответил ${res.status} — токен не принят` }
  } catch {
    return {
      name: 'Сайдкар',
      status: 'fail',
      detail: `порт ${endpoint.port} из файла не отвечает — сайдкар убили без уборки, удалите ${path.basename(portPath())} и ${path.basename(tokenPath())} или перезапустите dsmap run`,
    }
  }
}

function checkConfig(): Check {
  return fs.existsSync(configPath())
    ? { name: 'Настройки', status: 'ok', detail: configPath() }
    : { name: 'Настройки', status: 'info', detail: 'файла нет — тема тёмная, язык ru, полная анимация' }
}

/** Полный прогон. Возвращает код возврата, чтобы вызывающий сам решил, уходить ли в exit. */
export async function runDoctor(cwd: string): Promise<number> {
  const checks: Check[] = [
    checkRuntime(),
    checkBuild(),
    checkElectron(),
    checkHarness(),
    checkSession(cwd),
    await checkSidecar(readEndpoint()),
    checkConfig(),
  ]
  for (const check of checks) console.log(formatCheck(check))
  return exitCodeFor(checks)
}
