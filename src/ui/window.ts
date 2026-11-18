/**
 * Пристыковка панели к окну харнеса (§10).
 *
 * Геометрию читает один долгоживущий PowerShell-процесс (`window-watcher.ps1`),
 * который печатает NDJSON при смене состояния. Прежняя схема — `execSync` со
 * свежим `Add-Type` каждые 500 мс — жгла CPU на компиляции и давала только
 * «есть окно / нет окна», без «свёрнуто».
 *
 * Координаты из `GetWindowRect` powershell.exe уже приводит к 96-TPI DIP
 * (проверено на экране 1920×1080 при 125%: физическое окно 1440×740 приходит
 * как 1152×592), поэтому делить на `scaleFactor` здесь не нужно.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Откуда наблюдатель взял окно, в порядке его доверия: точный hwnd консоли,
 * окно самого харнеса или его потомков, окно ближайшего предка (терминал —
 * родитель шелла, а не потомок, поэтому дерева PID его не видят) и, если
 * ничего не нашлось, подстрока заголовка.
 */
export type AnchorSource = 'hwnd' | 'tree' | 'parent' | 'title'

const ANCHOR_SOURCES: readonly string[] = ['hwnd', 'tree', 'parent', 'title']
/** Имя образа якоря попадает в лог — пропускаем только его легальный алфавит (§12). */
const PROC_NAME_RE = /^[A-Za-z0-9 ._\-()[\]{}]{1,40}$/

export type WatcherState =
  | { kind: 'bounds'; bounds: WindowBounds; anchor?: AnchorSource; proc?: string }
  | { kind: 'minimized' }
  | { kind: 'pending' }
  | { kind: 'gone' }

/** Строка наблюдателя → состояние. Мусор и предупреждения PS → `null`, а не исключение. */
export function parseWatcherLine(line: string): WatcherState | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  switch (o.state) {
    case 'bounds': {
      const n = [o.x, o.y, o.width, o.height]
      if (!n.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
      const parsed: Extract<WatcherState, { kind: 'bounds' }> = {
        kind: 'bounds',
        bounds: { x: o.x as number, y: o.y as number, width: o.width as number, height: o.height as number },
      }
      // anchor — только диагностика, поэтому он необязателен: строка от старого
      // наблюдателя или неизвестное значение не имеют права терять геометрию.
      if (typeof o.anchor === 'string' && ANCHOR_SOURCES.includes(o.anchor)) parsed.anchor = o.anchor as AnchorSource
      if (typeof o.proc === 'string' && PROC_NAME_RE.test(o.proc)) parsed.proc = o.proc
      return parsed
    }
    case 'minimized':
      return { kind: 'minimized' }
    case 'pending':
      return { kind: 'pending' }
    case 'gone':
      return { kind: 'gone' }
    default:
      return null
  }
}

export interface WatcherOptions {
  pids: number[]
  scriptPath: string
  /**
   * Точный хэндл окна-якоря (консоль лаунчера). Надёжнее дерева PID: окно
   * терминала принадлежит Windows Terminal/conhost, а не нашим процессам.
   */
  hwnd?: number
  /** Дополнительный признак — подстрока заголовка. Нужен, когда UI харнеса живёт в браузере. */
  title?: string
  intervalMs?: number
}

/** События: `state` (WatcherState), `exit` (код). Упавший наблюдатель не должен ронять панель. */
export class WindowWatcher extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private buffer = ''

  constructor(private readonly opts: WatcherOptions) {
    super()
  }

  get running(): boolean {
    return this.child !== null
  }

  start(): void {
    if (this.child || process.platform !== 'win32') return
    const hwnd = this.opts.hwnd ?? 0
    if (this.opts.pids.length === 0 && hwnd <= 0) return
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.opts.scriptPath],
      {
        env: {
          ...process.env,
          DSMAP_PID_LIST: this.opts.pids.join(','),
          ...(hwnd > 0 ? { DSMAP_HWND: String(hwnd) } : {}),
          // Наблюдатель обязан умереть вместе с панелью: если Electron убит
          // снаружи, его powershell иначе крутится вечно сиротой.
          DSMAP_OWNER_PID: String(process.pid),
          ...(this.opts.title ? { DSMAP_TITLE: this.opts.title } : {}),
          ...(this.opts.intervalMs ? { DSMAP_INTERVAL_MS: String(this.opts.intervalMs) } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let nl = this.buffer.indexOf('\n')
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        const state = parseWatcherLine(line)
        if (state) this.emit('state', state)
        nl = this.buffer.indexOf('\n')
      }
    })
    child.stderr.resume()
    child.on('error', () => this.emit('exit', null))
    child.on('close', (code) => {
      if (this.child === child) this.child = null
      this.emit('exit', code)
    })
  }

  stop(): void {
    const child = this.child
    this.child = null
    this.buffer = ''
    child?.kill()
  }
}

const PANEL_W = 420
const PANEL_MIN_W = 320
const GAP = 8
const PANEL_MIN_H = 200

/**
 * Прямоугольник панели справа от окна харнеса. `area` — рабочая область монитора
 * (без таскбара): иначе панель уезжает под панель задач.
 * Когда места справа нет — вжимаемся в правый край, перекрывая край харнеса.
 */
export function computePanelBounds(
  harness: WindowBounds | null,
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const right = area.x + area.width
  const bottom = area.y + area.height

  if (!harness) {
    return { x: right - PANEL_W - GAP, y: area.y + GAP, width: PANEL_W, height: area.height - GAP * 2 }
  }

  let x = harness.x + harness.width + GAP
  let w = PANEL_W
  if (x + w > right) {
    w = Math.max(PANEL_MIN_W, right - x - GAP)
    x = right - w - GAP
  }
  if (x < area.x) x = area.x + GAP

  // Высоту берём как у харнеса, но панель не должна вылезать за рабочую область:
  // если не влезает вниз — сдвигаем вверх, пока вся панель видна.
  let y = Math.max(area.y, harness.y)
  let h = Math.max(PANEL_MIN_H, harness.height)
  if (y + h > bottom) {
    y = Math.max(area.y, bottom - h)
    h = bottom - y
  }

  return { x, y, width: w, height: h }
}
