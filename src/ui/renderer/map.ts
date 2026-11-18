/**
 * Карта-радар: SVG 460×430, геометрия и тайминги — из §11.1 (lot-map, MIT).
 * Пульсы, маршрут, станции, часы, кольцо контекста, фоновая работа, вспышки
 * мгновенных событий и бейдж повтора модели.
 *
 * Рендер разбит на два слоя: `base` (спицы, узлы, подписи — меняется редко)
 * и `fx` (маршрут, свечение, часы, кольцо, пульсы — оживляет rAF).
 * Так на каждый кадр пересобирается только маленькая строка, а не весь SVG.
 */

import type { ContextReading, Station, ToolStatus } from '../../core/events.js'
import { format, stationLabel, t, type Language } from '../i18n.js'
import { getPalette, resolveTheme, type Palette, type ThemeSetting } from './palette.js'

export const W = 460
export const H = 430
export const CX = 230
export const CY = 212
export const RX = 176
export const RY = 164
export const NODE = 22
export const CORE = 40
/** Кольцо ответа и волна от центра — на 8 пикселей крупнее ядра. */
export const HUB = CORE + 8

export const PULSE_MS = 800
export const RIPPLE_MS = 450
export const GLOW_MS = 3200
export const ALARM_MS = 6000
export const SWITCH_MS = 8000
/** Вспышка станции на мгновенном событии (правило доступа, письмо субагенту). */
export const FLASH_MS = GLOW_MS
/** Бейдж повтора на станции модели: держится дольше, чтобы успели прочитать. */
export const RETRY_MS = 12_000
export const DONE_MS = 1100
export const TRAIL_HOLD_MS = 40_000
export const TRAIL_FADE_MS = 20_000
export const TRAIL_STOPS = 7

/** Порядок обхода кольца: первая станция сверху, дальше по часовой. */
export const STATIONS: readonly Station[] = [
  'you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks',
]

const CONTEXT_R = CORE + 4
const BEND = 0.4

/**
 * Иконки станций — геометрические path'ы в координатах ±9 вокруг центра узла
 * (перенос из lot-map, MIT). Штриховка, не заливка: масштаб не зависит от radii.
 */
function ring(x: number, y: number, r: number): string {
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
}

export const STATION_ICONS: Record<Station, string> = {
  you: `${ring(0, -3.6, 3.4)}M-6.5 8c0-4 3-6.2 6.5-6.2s6.5 2.2 6.5 6.2`,
  model: 'M-5 -5h10v10h-10zM-2 -8.5v3.5M2 -8.5v3.5M-2 5v3.5M2 5v3.5M-8.5 -2h3.5M-8.5 2h3.5M5 -2h3.5M5 2h3.5',
  memory: `M-5 4.5L0 -5L6 3.5M-5 4.5L6 3.5${ring(-5, 4.5, 2.1)}${ring(0, -5, 2.1)}${ring(6, 3.5, 2.1)}`,
  files: 'M-5.5 -8h7.5l3.5 3.5v12.5h-11zM2 -8v3.5h3.5',
  shell: 'M-7.5 -5l5 5l-5 5M0 6h7.5',
  web: `${ring(0, 0, 7.8)}M-7.8 0h15.6M0 -7.8c-4.2 4.2 -4.2 11.4 0 15.6M0 -7.8c4.2 4.2 4.2 11.4 0 15.6`,
  browser: 'M-8.5 -6.5h17v13h-17zM-8.5 -2.8h17M-6.3 -4.7h.1M-3.8 -4.7h.1',
  agents: `M0 -4v3.5M0 -0.5L-6 4M0 -0.5L6 4${ring(0, -6, 2.1)}${ring(-6.5, 5.5, 2.1)}${ring(6.5, 5.5, 2.1)}`,
  skills: 'M1.5 -8.5L-5.5 1h4.5l-1.5 7.5l7.5 -9.8h-4.5z',
  hooks: `M2.5 -5.5v8a4.2 4.2 0 1 1 -8.4 0v-1.5${ring(2.5, -7.3, 1.8)}`,
}

const ICON = '<path d="%d" fill="none" stroke="%s" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>'

function icon(station: Station, color: string): string {
  return ICON.replace('%d', STATION_ICONS[station]).replace('%s', color)
}

export interface Pulse {
  station: Station
  dir: 'out' | 'back'
  startedAt: number
  status: ToolStatus
}

export interface TrailEntry {
  station: Station
  ts: number
}

export interface ActiveStation {
  startedAt: number
  /** Сколько вызовов станции открыто одновременно — даёт бейдж `×3`. */
  count: number
  /** Фоновая работа держит подсветку после конца хода, пока не придёт отчёт. */
  background: boolean
}

export interface State {
  pulses: Pulse[]
  trail: TrailEntry[]
  stationCounts: Map<Station, number>
  active: Map<Station, ActiveStation>
  /** Станция → время ошибки. Точка держится до следующего сообщения пользователя. */
  alarms: Map<Station, number>
  /**
   * Станция → время мгновенного события: у такой станции нет открытого
   * вызова, поэтому гореть ей не на чём, кроме короткой вспышки.
   */
  flash: Map<Station, number>
  /** Последняя попытка модели: бейдж `повтор 2/5` на станции `model`. */
  retry: { attempt: number; of: number } | null
  retryAt: number
  /** `null` — usage ещё не приходил: кольцо пустое, процент прочерком. */
  context: ContextReading | null
  rippleAt: number
  switchAt: number
  answerAt: number
  answerStatus: 'ok' | 'err' | 'aborted'
}

export interface Setup {
  theme: ThemeSetting
  layout: 'you-top' | 'you-bottom'
  motion: 'full' | 'reduced'
  lang: Language
  /** Настройка `счётчики`: числа вызовов под подписями станций. */
  counters: boolean
}

export function createState(): State {
  return {
    pulses: [],
    trail: [],
    stationCounts: new Map(),
    active: new Map(),
    alarms: new Map(),
    flash: new Map(),
    retry: null,
    retryAt: 0,
    context: null,
    rippleAt: 0,
    switchAt: 0,
    answerAt: 0,
    answerStatus: 'ok',
  }
}

function place(i: number, n: number, shift = 0): { x: number; y: number } {
  const a = -Math.PI / 2 + ((i + shift) / n) * Math.PI * 2
  return { x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a) }
}

function indexOfStation(station: string): number {
  return STATIONS.indexOf(station as Station)
}

function shiftOf(setup: Setup): number {
  return setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Доля контекста. Возвращает `null`, когда измерять нечего: `max === 0`
 * (история без usage) иначе даёт NaN, а ложная точность хуже оценки.
 */
export function contextRatio(context: ContextReading | null): number | null {
  if (!context || context.max <= 0 || !Number.isFinite(context.used)) return null
  return Math.min(1, Math.max(0, context.used / context.max))
}

/** Подпись процента: `~42%` для оценки по символам, `—` когда данных нет. */
export function contextText(context: ContextReading | null): string {
  const p = contextRatio(context)
  if (p === null) return '—'
  return `${context?.estimated ? '~' : ''}${Math.round(p * 100)}%`
}

/** Тысяцы токенов для шапки: `12900 → 12.9k`, `999 → 999`, `1_250_000 → 1.3M`. */
export function tokenText(used: number): string {
  if (!Number.isFinite(used) || used <= 0) return '0'
  if (used >= 1_000_000) return `${(used / 1_000_000).toFixed(1)}M`
  if (used >= 1000) return `${(used / 1000).toFixed(1)}k`
  return String(Math.round(used))
}

/**
 * Строка контекста в шапке: `5% · 12.9k ток`, с `~` перед оценкой.
 * Отдельная функция, а не разметка: шапка и тесты обязаны печатать одно число.
 */
export function contextSummary(context: ContextReading | null, lang: Language): string {
  const ratio = contextRatio(context)
  if (context === null || ratio === null) return '—'
  const percent = `${context.estimated ? '~' : ''}${Math.round(ratio * 100)}%`
  return `${percent} · ${tokenText(context.used)} ${t(lang, 'contextUnits')}`
}

// --- публичное API отрисовки ---

/** Ключ слоя-каркаса: меняется только тема, раскладка и язык. */
export function structureKey(setup: Setup): string {
  return `${resolveTheme(setup.theme)}|${setup.layout}|${setup.lang}`
}

/** Ключ статического слоя: спицы и узлы зависят от палитры, раскладки, языка, счётчиков и настройки их показа. */
export function baseKey(state: State, setup: Setup): string {
  const counts = STATIONS.map((s) => state.stationCounts.get(s) ?? 0).join(',')
  return `${structureKey(setup)}|${setup.counters ? 'on' : 'off'}|${counts}`
}

export function drawSkeleton(setup: Setup): string {
  const c = paletteOf(setup)
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" role="img" ` +
    `aria-label="${esc(t(setup.lang, 'mapLabel'))}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${H}" fill="${c.background}"/>` +
    `<g data-layer="base"></g><g data-layer="fx"></g></svg>`
  )
}

/** Статический слой: спицы, узлы станций, подписи, ядро. */
export function drawBase(state: State, setup: Setup): string {
  const c = paletteOf(setup)
  const shift = shiftOf(setup)
  const out: string[] = []

  for (let i = 0; i < STATIONS.length; i++) {
    const p = place(i, STATIONS.length, shift)
    const count = state.stationCounts.get(STATIONS[i]) ?? 0
    const width = 1 + Math.min(4, Math.log2(1 + count))
    out.push(
      `<line x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" ` +
        `stroke="${c.spoke}" stroke-width="${width.toFixed(2)}" stroke-dasharray="2 4"/>`,
    )
  }

  for (let i = 0; i < STATIONS.length; i++) {
    out.push(drawNodeBase(STATIONS[i], i, c, shift, setup.lang, state, setup.counters))
  }

  out.push(
    `<circle cx="${CX}" cy="${CY}" r="${CORE}" fill="${c.node}" stroke="${c.line}" stroke-width="2"/>`,
  )

  return out.join('')
}

/** Динамический слой: маршрут, свечение станций, часы, кольца центра, пульсы. */
export function drawEffects(state: State, now: number, setup: Setup): string {
  const c = paletteOf(setup)
  const shift = shiftOf(setup)
  const reduced = setup.motion === 'reduced'
  const out: string[] = [drawTrail(state, now, c, reduced, shift)]

  for (let i = 0; i < STATIONS.length; i++) {
    out.push(drawStationFx(STATIONS[i], i, state, now, c, shift, reduced, setup.lang))
  }

  out.push(drawCoreRings(state, now, c, setup.lang))

  for (const p of state.pulses) {
    out.push(drawPulse(p, now, c, shift, reduced))
  }

  return out.join('')
}

export function drawMap(state: State, now: number, setup: Setup): string {
  const base = drawBase(state, setup)
  const fx = drawEffects(state, now, setup)
  return drawSkeleton(setup).replace(
    '<g data-layer="base"></g><g data-layer="fx"></g>',
    `<g data-layer="base">${base}</g><g data-layer="fx">${fx}</g>`,
  )
}

/** Есть ли что анимировать в этот момент — по этому признаку rAF стоит/идёт. */
export function isAnimating(state: State, now: number): boolean {
  if (state.pulses.some((p) => now - p.startedAt < PULSE_MS)) return true
  if (state.active.size > 0) return true
  for (const at of state.flash.values()) {
    if (now - at < FLASH_MS) return true
  }
  if (state.retry && now - state.retryAt < RETRY_MS) return true
  if (now - state.rippleAt < RIPPLE_MS) return true
  if (now - state.switchAt < SWITCH_MS) return true
  if (now - state.answerAt < DONE_MS) return true
  const last = state.trail[state.trail.length - 1]
  if (last && now - last.ts < TRAIL_HOLD_MS + TRAIL_FADE_MS) return true
  return false
}

// --- внутренние куски отрисовки ---

function paletteOf(setup: Setup): Palette {
  return getPalette(resolveTheme(setup.theme))
}

function stationColors(station: Station, c: Palette, glowing: boolean): { fill: string; stroke: string; hot: string } {
  // Станция памяти имеет свою бирюзовую пару токенов (§11.1 memory/memoryActive).
  if (station === 'memory') {
    return { fill: glowing ? c.memoryActive : c.node, stroke: c.memory, hot: c.memoryActive }
  }
  return { fill: glowing ? c.active : c.node, stroke: c.line, hot: c.active }
}

function drawNodeBase(
  station: Station,
  index: number,
  c: Palette,
  shift: number,
  lang: Language,
  state: State,
  counters: boolean,
): string {
  const p = place(index, STATIONS.length, shift)
  const { stroke } = stationColors(station, c, false)
  const label = stationLabel(lang, station)
  const count = state.stationCounts.get(station) ?? 0
  let el =
    `<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">` +
    `<circle r="${NODE}" fill="${c.node}" stroke="${stroke}" stroke-width="1.5"/>` +
    icon(station, glyphColor(station, c, false, false, count)) +
    `<text x="0" y="${NODE + 14}" text-anchor="middle" font-size="10" fill="${c.label}" ` +
    `paint-order="stroke" stroke="${c.background}" stroke-width="3.5" stroke-linejoin="round" ` +
    `font-family="system-ui, sans-serif">${esc(label)}</text>`
  // Счётчик — тем же шрифтом, но глуше: это подпись к подписи, а не данные.
  if (counters && count > 0) {
    el += `<text x="0" y="${NODE + 25}" text-anchor="middle" font-size="9" fill="${c.faint}" ` +
      `paint-order="stroke" stroke="${c.background}" stroke-width="3" stroke-linejoin="round" ` +
      `font-family="system-ui, sans-serif">${count}</text>`
  }
  return el + '</g>'
}

/**
 * Цвет иконки повторяет lot-map: ошибка — красная, активная — «горячая» пара
 * станции, память со счётчиком — своя бирюзовая, всё остальное — приглушённая.
 */
function glyphColor(station: Station, c: Palette, glowing: boolean, alarm: boolean, count: number): string {
  if (alarm) return c.error
  if (glowing) return stationColors(station, c, true).hot
  if (station === 'memory' && count > 0) return c.memory
  return c.label
}

function drawStationFx(
  station: Station,
  index: number,
  state: State,
  now: number,
  c: Palette,
  shift: number,
  reduced: boolean,
  lang: Language,
): string {
  const active = state.active.get(station)
  const alarmAt = state.alarms.get(station)
  const flashedAt = state.flash.get(station)
  const flashed = flashedAt !== undefined && now - flashedAt < FLASH_MS
  const switched = station === 'model' && now - state.switchAt < SWITCH_MS
  const retry = station === 'model' && state.retry && now - state.retryAt < RETRY_MS ? state.retry : null
  const glowing = !!active || switched || flashed
  if (!active && !alarmAt && !switched && !flashed && !retry) return ''

  const p = place(index, STATIONS.length, shift)
  const { fill, hot } = stationColors(station, c, glowing)
  let el = `<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`

  if (glowing) {
    const r = NODE + (reduced ? 0 : 6)
    el += `<circle r="${r}" fill="${fill}" opacity="0.5"/>`
  }

  // Иконка поверх базового слоя: тот же path, но в цвете состояния.
  el += icon(
    station,
    glyphColor(station, c, glowing, !!alarmAt, state.stationCounts.get(station) ?? 0),
  )

  // Вспышка без открытого вызова: волна от мгновенного события, часов нет.
  if (!active && flashed && flashedAt !== undefined) {
    const pct = Math.min(1, (now - flashedAt) / FLASH_MS)
    if (!reduced) {
      el += `<circle r="${(NODE + 8 + pct * 12).toFixed(1)}" fill="none" stroke="${hot}" ` +
        `stroke-width="2" opacity="${(1 - pct).toFixed(2)}"/>`
    }
  }

  if (active) {
    const elapsed = now - active.startedAt
    if (!reduced) {
      // Волна-подсветка станции: растёт и гаснет в течение GLOW_MS.
      const pct = Math.min(1, elapsed / GLOW_MS)
      el += `<circle r="${(NODE + 8 + pct * 12).toFixed(1)}" fill="none" stroke="${hot}" ` +
        `stroke-width="2" opacity="${(1 - pct).toFixed(2)}"/>`
    }
    el += clockHands(now - active.startedAt, c)
    if (active.count > 1) {
      el += `<text x="${(NODE - 2).toFixed(1)}" y="${(-NODE + 2).toFixed(1)}" text-anchor="end" font-size="10" ` +
        `fill="${c.text}" font-family="system-ui, sans-serif">×${active.count}</text>`
    }
  }

  if (alarmAt) {
    const age = now - alarmAt
    // Красная тревога держится ALARM_MS, сама точка живёт до следующего запроса.
    if (age < ALARM_MS && !reduced) {
      el += `<circle r="${NODE + 8}" fill="none" stroke="${c.error}" stroke-width="2" ` +
        `opacity="${(0.8 * (1 - age / ALARM_MS)).toFixed(2)}"/>`
    }
    el += `<circle cx="${(-NODE + 6).toFixed(1)}" cy="${(-NODE + 6).toFixed(1)}" r="6" fill="${c.error}" opacity="0.95"/>`
    el += `<text x="${(-NODE + 6).toFixed(1)}" y="${(-NODE + 9).toFixed(1)}" text-anchor="middle" font-size="8" ` +
      `fill="${c.background}" font-weight="bold" font-family="system-ui, sans-serif">✕</text>`
  }

  if (retry) {
    // Бейдж сбоя: только счёт попыток. Текста ошибки харнеса здесь нет и быть
    // не может — он не уходит из `core/route.ts`.
    el += `<text x="0" y="${(NODE + 25).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="600" ` +
      `fill="${c.error}" paint-order="stroke" stroke="${c.background}" stroke-width="3.5" ` +
      `stroke-linejoin="round" font-family="system-ui, sans-serif">` +
      `${esc(format(lang, 'retryBadge', { a: retry.attempt, o: retry.of }))}</text>`
  }

  el += '</g>'
  return el
}

/** Две стрелки часов: внутренняя — оборот за минуту, внешняя — за десять. */
function clockHands(elapsed: number, c: Palette): string {
  const inner = ((elapsed / 60_000) * 360) % 360
  const outer = ((elapsed / 600_000) * 360) % 360
  return (
    `<line x1="0" y1="0" x2="0" y2="${-NODE - 4}" stroke="${c.text}" stroke-width="1" transform="rotate(${inner.toFixed(1)})"/>` +
    `<line x1="0" y1="0" x2="0" y2="${-NODE - 8}" stroke="${c.label}" stroke-width="1" transform="rotate(${outer.toFixed(1)})"/>`
  )
}

function leg(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const cx = mx + (CX - mx) * BEND
  const cy = my + (CY - my) * BEND
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
}

function drawTrail(state: State, now: number, c: Palette, reduced: boolean, shift: number): string {
  if (state.trail.length < 2) return ''

  const points: { x: number; y: number; ts: number }[] = []
  for (const entry of state.trail) {
    const idx = indexOfStation(entry.station)
    if (idx < 0) continue
    points.push({ ...place(idx, STATIONS.length, shift), ts: Math.min(entry.ts, now) })
  }
  if (points.length < 2) return ''

  const out: string[] = []
  for (let i = 1; i < points.length; i++) {
    const age = now - points[i].ts
    if (age >= TRAIL_HOLD_MS + TRAIL_FADE_MS) continue

    const opacity = age < TRAIL_HOLD_MS ? 1 : (TRAIL_HOLD_MS + TRAIL_FADE_MS - age) / TRAIL_FADE_MS
    const d = leg(points[i - 1], points[i])
    // В reduced нога не рисуется progressively — просто появляется и гаснет.
    const drawn = reduced || age >= PULSE_MS
    const progressive = drawn ? '' : ` pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - age / PULSE_MS).toFixed(3)}"`
    out.push(`<path d="${d}" fill="none" stroke="${c.route}" stroke-width="1.5" opacity="${opacity.toFixed(3)}"${progressive}/>`)
  }
  return out.join('')
}

function drawPulse(p: Pulse, now: number, c: Palette, shift: number, reduced: boolean): string {
  const idx = indexOfStation(p.station)
  if (idx < 0) return ''
  const t0 = (now - p.startedAt) / PULSE_MS
  if (t0 >= 1) return ''
  const t = Math.max(0, t0)
  const node = place(idx, STATIONS.length, shift)
  const color = p.status === 'err' ? c.error : p.station === 'memory' ? c.memoryActive : c.active

  if (reduced) {
    // Пульс не летит: станция вспыхивает и гаснет на месте.
    return `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${NODE}" fill="none" ` +
      `stroke="${color}" stroke-width="3" opacity="${Math.sin(t * Math.PI).toFixed(2)}"/>`
  }

  const e = 1 - Math.pow(1 - t, 3) // ease-out
  const from = p.dir === 'out' ? { x: CX, y: CY } : node
  const to = p.dir === 'out' ? node : { x: CX, y: CY }
  const x = from.x + (to.x - from.x) * e
  const y = from.y + (to.y - from.y) * e
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}" opacity="${(1 - t * 0.3).toFixed(2)}"/>`
}

function drawCoreRings(state: State, now: number, c: Palette, lang: Language): string {
  let el = ''

  // Дорожка кольца видна всегда, дуга — только когда есть реальный usage.
  el += `<circle cx="${CX}" cy="${CY}" r="${CONTEXT_R}" fill="none" stroke="${c.line}" stroke-width="3" opacity="0.5"/>`
  const ratio = contextRatio(state.context)
  if (ratio !== null) {
    const circumference = 2 * Math.PI * CONTEXT_R
    const color = ratio >= 0.9 ? c.error : ratio >= 0.7 ? c.accent : c.active
    el += `<circle cx="${CX}" cy="${CY}" r="${CONTEXT_R}" fill="none" stroke="${color}" stroke-width="3" ` +
      `stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${(circumference * (1 - ratio)).toFixed(1)}" ` +
      `transform="rotate(-90 ${CX} ${CY})"/>`
  }

  const ripple = (now - state.rippleAt) / RIPPLE_MS
  if (ripple >= 0 && ripple < 1) {
    el += `<circle cx="${CX}" cy="${CY}" r="${(CORE + (HUB - CORE) * ripple).toFixed(1)}" fill="none" ` +
      `stroke="${c.accent}" stroke-width="1.5" opacity="${(1 - ripple).toFixed(2)}"/>`
  }

  const done = (now - state.answerAt) / DONE_MS
  if (done >= 0 && done < 1) {
    const color = state.answerStatus === 'ok' ? c.accent : c.error
    el += `<circle cx="${CX}" cy="${CY}" r="${HUB}" fill="none" stroke="${color}" stroke-width="2" ` +
      `opacity="${(1 - done).toFixed(2)}"/>`
  }

  // Подпись кольца — в title: visually здесь только число, иначе текст
  // лег бы на обводку ядра.
  el += `<title>${esc(t(lang, ratio === null ? 'contextNone' : 'contextRing'))}</title>`
  el += `<text x="${CX}" y="${CY - CORE - 12}" text-anchor="middle" font-size="12" font-weight="600" ` +
    `fill="${ratio === null ? c.faint : c.text}" font-family="system-ui, sans-serif">${esc(contextText(state.context))}</text>`

  return el
}
