/**
 * Рендерер ds-map: чистый SVG + минимум DOM.
 * Подключается к main через IPC (preload), получает события через WS.
 */

import { drawMap, type State, type Setup, type Pulse } from './map.js'
import { Feed } from './feed.js'
import { detectTheme, getPalette, type Theme, type Palette } from './palette.js'
import { t, type Language, DICTIONARY } from '../i18n.js'

// --- состояние ---
let state: State = {
  pulses: [],
  trail: [],
  stationCounts: new Map(),
  activeCalls: new Map(),
  stationErrors: new Map(),
  contextPct: 0,
}

let setup: Setup = {
  theme: 'dark',
  layout: 'you-top',
  motion: 'full',
  lang: 'ru',
}

let palette: Palette = getPalette('dark')
let animFrame: number | null = null
let lastRenderTime = 0

const feed = new Feed()
const mapEl = document.getElementById('map')!
const feedEl = document.getElementById('feed')!
const statusEl = document.getElementById('status')!
const themeBtn = document.getElementById('theme-btn')!
const langBtn = document.getElementById('lang-btn')!
const motionBtn = document.getElementById('motion-btn')!

// --- IPC через preload ---
declare global {
  interface Window {
    dsmap?: {
      onEvent: (cb: (e: unknown) => void) => { unsubscribe: () => void }
      getConfig: () => Promise<Record<string, unknown>>
      setConfig: (patch: unknown) => Promise<void>
    }
  }
}

const PULSE_MS = 800

export function init(): void {
  window.dsmap?.onEvent(onEvent)

  // Тема
  themeBtn.addEventListener('click', () => {
    applyTheme(setup.theme === 'dark' ? 'light' : 'dark')
  })

  // Язык
  langBtn.addEventListener('click', () => {
    applyLang(setup.lang === 'ru' ? 'en' : 'ru')
  })

  // Reduced motion
  motionBtn.addEventListener('click', () => {
    setup.motion = setup.motion === 'full' ? 'reduced' : 'full'
    updateMotionBtn()
    render()
  })

  // Загрузка конфига
  window.dsmap?.getConfig().then((cfg) => {
    if (cfg.theme) applyTheme(cfg.theme as Theme)
    if (cfg.lang) applyLang(cfg.lang as Language)
    if (cfg.motion) setup.motion = cfg.motion as 'full' | 'reduced'
    updateMotionBtn()
    render()
  })

  render()
}

function onEvent(e: unknown): void {
  const ev = e as any
  const now = Date.now()

  switch (ev.t) {
    case 'session.start':
      state.contextPct = 0
      addTrail('you', now)
      break

    case 'prompt':
      // Очищаем ошибки станций на новом сообщении пользователя (M6)
      state.stationErrors.clear()
      addTrail('you', now)
      break

    case 'model.step':
      state.contextPct = Math.round((ev.context.used / ev.context.max) * 100)
      addTrail('model', now)
      break

    case 'tool.start': {
      const station = ev.station as string
      addPulse(station, now, 'ok')
      state.stationCounts.set(station, (state.stationCounts.get(station) ?? 0) + 1)
      state.activeCalls.set(station, { station, startedAt: now })
      addTrail(station, now)
      feed.add({ time: formatTime(now), station: ev.station, label: ev.label, status: 'active' })
      break
    }

    case 'tool.end': {
      const active = [...state.activeCalls.entries()].find(([_, v]) => now - v.startedAt < 60000)
      if (active) {
        const [station] = active
        state.activeCalls.delete(station)
        if (ev.status === 'err') {
          state.stationErrors.set(station, { label: station, ts: now })
          feed.markError(station, station)
        }
      }
      state.pulses = state.pulses.filter((p) => now - p.startedAt < PULSE_MS * 2)
      break
    }

    case 'answer':
      state.activeCalls.clear()
      break

    case 'context.update':
      state.contextPct = Math.round((ev.used / ev.max) * 100)
      break
  }

  render()
}

function addPulse(station: string, now: number, status: 'ok' | 'err'): void {
  const idx = STATIONS_LIST.indexOf(station)
  if (idx < 0) return
  state.pulses.push({ index: idx, dir: 'out', startedAt: now, status })
  setTimeout(() => {
    state.pulses.push({ index: idx, dir: 'back', startedAt: Date.now(), status })
    state.pulses = state.pulses.filter((p) => Date.now() - p.startedAt < PULSE_MS * 2)
    render()
  }, PULSE_MS)
}

function addTrail(station: string, now: number): void {
  if (station === 'model') return
  state.trail.push({ station, ts: now })
  if (state.trail.length > 7) state.trail = state.trail.slice(-7)
}

const STATIONS_LIST = ['you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks']

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function applyTheme(theme: Theme): void {
  setup.theme = theme
  document.body.setAttribute('class', theme)
  updateButtons()
  render()
  window.dsmap?.setConfig({ theme })
}

function applyLang(lang: Language): void {
  setup.lang = lang
  updateButtons()
  render()
  window.dsmap?.setConfig({ lang })
}

function updateButtons(): void {
  themeBtn.textContent = t(setup.lang, setup.theme === 'dark' ? 'themeDark' : 'themeLight')
  langBtn.textContent = t(setup.lang, setup.lang === 'ru' ? 'languageRu' : 'languageEn')
  motionBtn.textContent = t(setup.lang, setup.motion === 'full' ? 'motionFull' : 'motionReduced')
}

function updateMotionBtn(): void {
  motionBtn.textContent = t(setup.lang, setup.motion === 'full' ? 'motionFull' : 'motionReduced')
}

function render(): void {
  const now = Date.now()

  mapEl.innerHTML = drawMap(state, now, setup)
  feedEl.innerHTML = feed.render(setup.lang)

  if (state.pulses.length > 0 || needsTrailFade(now)) {
    if (!animFrame) {
      animFrame = requestAnimationFrame(loop)
    }
  } else {
    if (animFrame) {
      cancelAnimationFrame(animFrame)
      animFrame = null
    }
  }
}

function loop(): void {
  const now = Date.now()
  if (now - lastRenderTime < 33) {
    animFrame = requestAnimationFrame(loop)
    return
  }
  lastRenderTime = now
  render()
}

function needsTrailFade(now: number): boolean {
  return state.trail.length > 0 && now - state.trail[state.trail.length - 1].ts < 60000
}


