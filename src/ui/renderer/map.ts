/**
 * Карта-радар: SVG 460×430, геометрия из lot-map (MIT).
 * Пульсы, маршрут, станции, кольцо контекста, часы.
 */

import type { Palette } from './palette.js'

const W = 460
const H = 430
const CX = 230
const CY = 212
const RX = 176
const RY = 164
const NODE = 22
const CORE = 40

const PULSE_MS = 800
const TRAIL_STOPS = 7
const TRAIL_HOLD_MS = 40_000
const TRAIL_FADE_MS = 20_000

const STATIONS = [
  'you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks',
] as const

const STATION_LABELS: Record<string, string> = {
  you: 'Вы', model: 'Модель', memory: 'Память', files: 'Файлы',
  shell: 'Шелл', web: 'Сеть', browser: 'Браузер', agents: 'Агенты',
  skills: 'Скиллы', hooks: 'Хуки',
}

function place(i: number, n: number, shift = 0): { x: number; y: number } {
  const a = -Math.PI / 2 + ((i + shift) / n) * Math.PI * 2
  return { x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a) }
}

export interface Pulse {
  index: number
  dir: 'out' | 'back'
  startedAt: number
  status: 'ok' | 'err'
}

export interface TrailEntry {
  station: string
  ts: number
}

export interface State {
  pulses: Pulse[]
  trail: TrailEntry[]
  stationCounts: Map<string, number>
  activeCalls: Map<string, { station: string; startedAt: number }>
  contextPct: number
}

export interface Setup {
  theme: 'light' | 'dark'
  layout: 'you-top' | 'you-bottom'
  motion: 'full' | 'reduced'
  lang: 'ru' | 'en'
}

export function drawMap(state: State, now: number, setup: Setup): string {
  const c = setup.theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE
  const shift = setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0
  const out: string[] = []

  out.push(`<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" role="img" aria-label="Карта работы агента" xmlns="http://www.w3.org/2000/svg">`)
  out.push(`<rect width="${W}" height="${H}" fill="${c.background}"/>`)

  // спицы
  for (let i = 0; i < STATIONS.length; i++) {
    const p = place(i, STATIONS.length, shift)
    const count = state.stationCounts.get(STATIONS[i]) ?? 0
    const width = 1 + Math.min(4, Math.log2(1 + count))
    out.push(`<line x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="${c.spoke}" stroke-width="${width}" stroke-dasharray="2 4"/>`)
  }

  // маршрут
  out.push(drawTrail(state.trail, now, c, shift))

  // станции
  for (let i = 0; i < STATIONS.length; i++) {
    out.push(drawStation(STATIONS[i], i, state, now, c, shift))
  }

  // центр и кольцо контекста
  out.push(drawCore(state, now, c))

  // пульсы
  for (const p of state.pulses) {
    out.push(drawPulse(p, now, c, shift, setup.motion))
  }

  out.push('</svg>')
  return out.join('')
}

function drawStation(
  id: string,
  index: number,
  state: State,
  now: number,
  c: Palette,
  shift: number
): string {
  const p = place(index, STATIONS.length, shift)
  const count = state.stationCounts.get(id) ?? 0
  const active = state.activeCalls.get(id)
  const glow = active && now - active.startedAt < 3200
  const r = NODE + (glow ? 6 : 0)
  const fill = glow ? c.active : c.node
  const stroke = c.line
  const label = STATION_LABELS[id] ?? id

  let el = `<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">`
  el += `<circle r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`

  if (active) {
    const elapsed = now - active.startedAt
    const pct = Math.min(1, elapsed / 3200)
    const ringR = NODE + 8 + pct * 12
    const ringOpacity = (1 - pct).toFixed(2)
    el += `<circle r="${ringR.toFixed(1)}" fill="none" stroke="${c.active}" stroke-width="2" opacity="${ringOpacity}"/>`

    // часы: две стрелки
    const inner = ((elapsed / 60_000) * 360) % 360
    const outer = ((elapsed / 600_000) * 360) % 360
    el += `<line x1="0" y1="0" x2="0" y2="${-NODE - 4}" stroke="${c.text}" stroke-width="1" transform="rotate(${inner})"/>`
    el += `<line x1="0" y1="0" x2="0" y2="${-NODE - 8}" stroke="${c.label}" stroke-width="1" transform="rotate(${outer})"/>`
  }

  el += `<text x="0" y="${NODE + 14}" text-anchor="middle" font-size="10" fill="${c.label}" font-family="system-ui, sans-serif">${label}</text>`
  el += `</g>`
  return el
}

function drawPulse(
  p: Pulse,
  now: number,
  c: Palette,
  shift: number,
  motion: 'full' | 'reduced'
): string {
  const t = Math.min(1, (now - p.startedAt) / PULSE_MS)
  if (t >= 1) return '' // пульс完成

  if (motion === 'reduced') {
    const flash = Math.sin(t * Math.PI)
    const p0 = place(p.index, STATIONS.length, shift)
    const alpha = flash.toFixed(2)
    return `<circle cx="${p0.x.toFixed(1)}" cy="${p0.y.toFixed(1)}" r="4" fill="${c.accent}" opacity="${alpha}"/>`
  }

  const e = 1 - Math.pow(1 - t, 3) // ease-out
  const from = p.dir === 'out' ? { x: CX, y: CY } : place(p.index, STATIONS.length, shift)
  const to = p.dir === 'out' ? place(p.index, STATIONS.length, shift) : { x: CX, y: CY }
  const x = from.x + (to.x - from.x) * e
  const y = from.y + (to.y - from.y) * e
  const color = p.status === 'err' ? c.error : c.active
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}" opacity="${(1 - t * 0.3).toFixed(2)}"/>`
}

function drawTrail(
  entries: TrailEntry[],
  now: number,
  c: Palette,
  shift: number
): string {
  if (entries.length < 2) return ''

  const points: { x: number; y: number }[] = []
  for (let i = 0; i < entries.length; i++) {
    const idx = STATIONS.indexOf(entries[i].station as any)
    if (idx >= 0) points.push(place(idx, STATIONS.length, shift))
  }
  if (points.length < 2) return ''

  const age = now - entries[entries.length - 1].ts
  const hold = age < TRAIL_HOLD_MS
  const fade = age < TRAIL_HOLD_MS + TRAIL_FADE_MS
  const opacity = hold ? '1' : fade ? ((TRAIL_HOLD_MS + TRAIL_FADE_MS - age) / TRAIL_FADE_MS).toFixed(2) : '0'
  if (parseFloat(opacity) <= 0) return ''

  let d = `M${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const cx = mx + (CX - mx) * 0.4
    const cy = my + (CY - my) * 0.4
    d += ` Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
  }

  return `<path d="${d}" fill="none" stroke="${c.route}" stroke-width="1.5" opacity="${opacity}"/>`
}

function drawCore(state: State, now: number, c: Palette): string {
  const p = Math.min(1, state.contextPct / 100)
  const C = 2 * Math.PI * (CORE + 4)
  const color = p >= 0.9 ? c.error : p >= 0.7 ? c.accent : c.line

  let el = `<circle cx="${CX}" cy="${CY}" r="${CORE}" fill="${c.node}" stroke="${c.line}" stroke-width="2"/>`
  el += `<circle r="${CORE + 4}" fill="none" stroke="${color}" stroke-width="3" `
  el += `stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - p)).toFixed(1)}" `
  el += `transform="rotate(-90 ${CX} ${CY})"/>`
  el += `<text x="${CX}" y="${CY - 48}" text-anchor="middle" font-size="12" font-weight="600" fill="${c.text}" font-family="system-ui, sans-serif">${Math.round(p * 100)}%</text>`
  return el
}

const DARK_PALETTE: Palette = {
  background: '#0a0c11', node: '#12151c', line: '#272c36', spoke: '#1a1e27',
  text: '#ebe6dc', label: '#9ba1ab', faint: '#6b7280', accent: '#e1ac6e',
  active: '#f0c595', error: '#e8654f', memory: '#62c7ba', memoryActive: '#a5e6dc', route: '#ebe6dd',
}
const LIGHT_PALETTE: Palette = {
  background: '#f5f2ea', node: '#ffffff', line: '#cfc9bc', spoke: '#e3ded2',
  text: '#1f2228', label: '#5f6570', faint: '#8b909a', accent: '#b8762a',
  active: '#8f560f', error: '#c5402b', memory: '#1c8c81', memoryActive: '#136a62', route: '#9c978b',
}
