/**
 * Рендерер ds-map: чистый SVG + лента под ним, без React.
 *
 * События приходят из main по IPC (preload). Отрисовка разбита по слоям:
 * каркас пересобирается только при смене темы/раскладки/языка, статика —
 * при смене счётчиков станций, эффекты — на кадр. rAF стоит на потолке
 * 30 fps и гаснет, когда анимировать нечего (§11 «Производительность»).
 * Лента печатается только когда изменились её собственные данные.
 */

import type { ContextReading, Station, ToolStatus } from '../../core/events.js'
import { t, type Language } from '../i18n.js'
import { Feed, statusOf } from './feed.js'
import {
  baseKey,
  createState,
  drawBase,
  drawEffects,
  drawSkeleton,
  isAnimating,
  PULSE_MS,
  STATIONS,
  structureKey,
  TRAIL_FADE_MS,
  TRAIL_HOLD_MS,
  TRAIL_STOPS,
  type Pulse,
  type Setup,
  type State,
} from './map.js'
import { cssVars, getPalette, resolveTheme, watchSystemTheme, type ThemeSetting } from './palette.js'

/** Потолок 30 fps: чаще — бессмысленно, реже — заметно на слабых машинах. */
const FRAME_MS = 33
/** Без событий дольше этого — worth проверить, жив ли канал до main. */
const IDLE_MS = 30_000
/** Как часто делать такую проверку. */
const PROBE_MS = 15_000

declare global {
  interface Window {
    dsmap?: {
      onEvent: (cb: (e: unknown) => void) => { unsubscribe: () => void }
      getConfig: () => Promise<Record<string, unknown>>
      setConfig: (patch: unknown) => Promise<void>
      /**
       * Канал `status` появляется, когда main начинает слать состояние WS.
       * Без него о смерти сайдкара можно судить только по round-trip к конфигу.
       */
      onStatus?: (cb: (s: unknown) => void) => { unsubscribe: () => void }
    }
  }
}

type LooseEvent = Record<string, unknown>

interface OpenActivity {
  station: Station
  ts: number
  /** Фоновая работа переживает конец хода: ждёт отчёт, а не гаснет по answer. */
  background: boolean
}

/** Всё, что нужно для обработки событий; DOM к этому не прикручен. */
export interface UiModel {
  state: State
  setup: Setup
  feed: Feed
  /** Открытые вызовы и фоновые работы: `id` события → что закрывать. */
  open: Map<string, OpenActivity>
  /** Строка уплотнения контекста: `id` открытого ряда, если уплотнение идёт. */
  openCompaction: string | null
  seq: number
}

const STATION_SET: ReadonlySet<string> = new Set<string>(STATIONS)

export function createModel(lang: Language = 'ru'): UiModel {
  return {
    state: createState(),
    setup: { theme: 'dark', layout: 'you-top', motion: 'full', lang },
    feed: new Feed(),
    open: new Map(),
    openCompaction: null,
    seq: 0,
  }
}

function stationOf(value: unknown): Station | null {
  return typeof value === 'string' && STATION_SET.has(value) ? (value as Station) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function outcomeOf(value: unknown): ToolStatus {
  if (typeof value !== 'string') return 'unknown'
  if (value === 'ok' || value === 'err' || value === 'unknown') return value
  return 'unknown'
}

function answerOutcomeOf(value: unknown): 'ok' | 'err' | 'aborted' {
  if (typeof value !== 'string') return 'ok'
  if (value === 'err' || value === 'aborted') return value
  return 'ok'
}

function contextOf(used: unknown, max: unknown, estimated: unknown): ContextReading | null {
  const u = num(used)
  const m = num(max)
  if (u === undefined || m === undefined) return null
  return { used: u, max: m, estimated: estimated === true }
}

function contextOfEvent(ev: LooseEvent): ContextReading | null {
  const ctx = ev.context
  if (!ctx || typeof ctx !== 'object') return null
  const read = ctx as Record<string, unknown>
  return contextOf(read.used, read.max, read.estimated)
}

/** Метка вызова: label из события, иначе имя инструмента, иначе станция. */
function labelOf(ev: LooseEvent, station: Station): string {
  return str(ev.label) || str(ev.name) || station
}

function pushPulse(state: State, station: Station, dir: Pulse['dir'], status: ToolStatus, now: number): void {
  state.pulses.push({ station, dir, startedAt: now, status })
  const overflow = state.pulses.length - 32
  if (overflow > 0) state.pulses.splice(0, overflow)
}

/** Станция `model` в маршрут не попадает, повтор подряд считается один раз. */
function pushTrail(model: UiModel, station: Station, now: number): void {
  if (station === 'model') return
  const trail = model.state.trail
  const last = trail[trail.length - 1]
  if (last && last.station === station) return
  trail.push({ station, ts: now })
  const overflow = trail.length - TRAIL_STOPS
  if (overflow > 0) trail.splice(0, overflow)
}

function acquire(state: State, station: Station, now: number, background: boolean): void {
  const current = state.active.get(station)
  if (!current) {
    state.active.set(station, { startedAt: now, count: 1, background })
    return
  }
  current.count += 1
  current.background = current.background || background
}

function release(state: State, station: Station): void {
  const current = state.active.get(station)
  if (!current) return
  current.count -= 1
  if (current.count <= 0) state.active.delete(station)
}

function countStation(state: State, station: Station): void {
  state.stationCounts.set(station, (state.stationCounts.get(station) ?? 0) + 1)
}

/** Убрать то, что уже догорело, — иначе массивы растут весь день. */
export function prune(state: State, now: number): void {
  if (state.pulses.length > 0) {
    state.pulses = state.pulses.filter((p) => now - p.startedAt < PULSE_MS)
  }
  const cutoff = now - (TRAIL_HOLD_MS + TRAIL_FADE_MS)
  if (state.trail.length > 0 && state.trail[0].ts < cutoff) {
    state.trail = state.trail.filter((entry) => entry.ts >= cutoff)
  }
}

/**
 * Одно событие → состояние карты и ленты. Неизвестные `t` игнорируются,
 * битые поля не роняют панель: всё читается через проверенные ассессоры.
 */
export function applyEvent(model: UiModel, raw: unknown, now: number): void {
  if (!raw || typeof raw !== 'object') return
  const ev = raw as LooseEvent
  if (typeof ev.t !== 'string') return
  const state = model.state

  switch (ev.t) {
    case 'session.start': {
      model.open.clear()
      model.openCompaction = null
      state.active.clear()
      state.alarms.clear()
      state.context = null
      state.trail = []
      state.rippleAt = now
      pushTrail(model, 'you', now)
      model.feed.add({ station: 'you', key: 'sessionLabel', status: 'done', ts: now })
      break
    }

    case 'prompt': {
      // Красная точка станции живёт ровно до следующего сообщения пользователя.
      state.alarms.clear()
      state.rippleAt = now
      pushTrail(model, 'you', now)
      model.feed.add({
        station: 'you',
        key: 'promptChars',
        vars: { n: num(ev.chars) ?? 0 },
        status: 'done',
        ts: now,
      })
      break
    }

    case 'model.step': {
      const context = contextOfEvent(ev)
      if (context) state.context = context
      break
    }

    case 'context.update': {
      const context = contextOf(ev.used, ev.max, ev.estimated)
      if (context) state.context = context
      break
    }

    case 'tool.start': {
      const station = stationOf(ev.station)
      if (!station) break
      const id = str(ev.id) || `call_${model.seq++}`
      model.open.set(id, { station, ts: now, background: false })
      countStation(state, station)
      pushPulse(state, station, 'out', 'ok', now)
      acquire(state, station, now, false)
      pushTrail(model, station, now)
      model.feed.add({
        id,
        station,
        label: labelOf(ev, station),
        status: 'active',
        mergeable: true,
        ts: now,
      })
      break
    }

    case 'tool.end': {
      const id = str(ev.id)
      const outcome = outcomeOf(ev.status)
      const open = id ? model.open.get(id) : undefined
      const station = open?.station ?? stationOf(ev.station)
      if (!station) break
      if (id) model.open.delete(id)
      pushPulse(state, station, 'back', outcome, now)
      release(state, station)
      if (outcome === 'err') state.alarms.set(station, now)
      const ms = num(ev.ms)
      const closed = id !== '' && model.feed.complete(id, outcome, ms)
      if (!closed) {
        // Конец без начала (обрывок истории): строку всё равно надо показать.
        model.feed.add({
          station,
          label: labelOf(ev, station),
          status: statusOf(outcome),
          ms,
          mergeable: true,
          ts: now,
        })
      }
      break
    }

    case 'answer': {
      const status = answerOutcomeOf(ev.status)
      state.answerAt = now
      state.answerStatus = status
      // Ход закончился: незакрытые вызовы гаснем, фон оставляем гореть.
      model.feed.settle()
      for (const [id, activity] of model.open) {
        if (activity.background) continue
        release(state, activity.station)
        model.open.delete(id)
      }
      const key = status === 'ok' ? 'answerOk' : status === 'err' ? 'answerErr' : 'answerAborted'
      model.feed.add({
        station: 'model',
        key,
        status: status === 'ok' ? 'done' : 'error',
        ms: num(ev.ms),
        ts: now,
      })
      break
    }

    case 'model.switch': {
      const from = str(ev.from)
      const to = str(ev.to)
      state.switchAt = now
      model.feed.add({
        id: `switch_${model.seq++}`,
        station: 'model',
        label: from || to ? `${from || '—'} → ${to || '—'}` : '',
        key: from || to ? undefined : 'modelSwitchLabel',
        status: 'switch',
        ts: now,
      })
      break
    }

    case 'job.start': {
      const station = stationOf(ev.station)
      if (!station) break
      const id = str(ev.id) || `job_${model.seq++}`
      model.open.set(id, { station, ts: now, background: true })
      countStation(state, station)
      acquire(state, station, now, true)
      model.feed.add({
        id,
        station,
        label: labelOf(ev, station),
        status: 'active',
        background: true,
        ts: now,
      })
      break
    }

    case 'job.end': {
      const id = str(ev.id)
      const outcome = outcomeOf(ev.status)
      const open = id ? model.open.get(id) : undefined
      const station = open?.station ?? stationOf(ev.station)
      if (!station) break
      if (id) model.open.delete(id)
      release(state, station)
      if (outcome === 'err') state.alarms.set(station, now)
      const ms = num(ev.ms)
      const closed = id !== '' && model.feed.complete(id, outcome, ms)
      if (!closed) {
        model.feed.add({ station, key: 'jobLabel', status: statusOf(outcome), ms, ts: now })
      }
      break
    }

    case 'compaction': {
      const phase = ev.phase === 'end' ? 'end' : 'start'
      if (phase === 'start') {
        const id = `compaction_${model.seq++}`
        model.openCompaction = id
        acquire(state, 'model', now, false)
        pushPulse(state, 'model', 'out', 'ok', now)
        model.feed.add({ id, station: 'model', key: 'compactionLabel', status: 'active', ts: now })
      } else {
        const id = model.openCompaction
        model.openCompaction = null
        release(state, 'model')
        pushPulse(state, 'model', 'back', 'ok', now)
        const ms = num(ev.ms)
        if (!id || !model.feed.complete(id, 'ok', ms)) {
          model.feed.add({ station: 'model', key: 'compactionLabel', status: 'done', ms, ts: now })
        }
      }
      break
    }

    default:
      // Неизвестная схема: молча пропускаем, панель не падает.
      break
  }
}

// --- DOM-обвязка: всё ниже живёт только в окне Electron ---

// Состояние окна: одно на всю жизнь процесса, пересоздаётся только вместе с панелью.
const model: UiModel = createModel()
let mapEl: HTMLElement | null = null
let feedNowEl: HTMLElement | null = null
let feedListEl: HTMLElement | null = null
let statusEl: HTMLElement | null = null
let layerBase: Element | null = null
let layerFx: Element | null = null
let mountedStructure = ''
let mountedBase = ''
let mountedFeedRev = -1
let mountedFeedLang: Language | null = null
let rafId: number | null = null
let lastFrameAt = 0
let lastNowTick = 0
let lastEventAt = 0
let connectionLost = false
let stopThemeWatch: (() => void) | null = null

export function init(): void {
  const map = document.getElementById('map')
  const feedNow = document.getElementById('feed-now')
  const feedList = document.getElementById('feed-list')
  const status = document.getElementById('status')
  const themeBtn = document.getElementById('theme-btn')
  const langBtn = document.getElementById('lang-btn')
  const motionBtn = document.getElementById('motion-btn')
  if (!map || !feedNow || !feedList || !status || !themeBtn || !langBtn || !motionBtn) {
    // Диагностика разработчику, не строка интерфейса: её нет в таблицах i18n.
    console.error('[ds-map] index.html is missing a mount point — panel not started')
    return
  }
  mapEl = map
  feedNowEl = feedNow
  feedListEl = feedList
  statusEl = status

  lastEventAt = Date.now()

  themeBtn.addEventListener('click', () => applyTheme(model.setup.theme === 'dark' ? 'light' : 'dark'))
  langBtn.addEventListener('click', () => applyLang(model.setup.lang === 'ru' ? 'en' : 'ru'))
  motionBtn.addEventListener('click', () => {
    applyMotion(model.setup.motion === 'full' ? 'reduced' : 'full')
  })

  // `▸` раскрывает строку. Открыта всегда одна — этим правит Feed.toggle.
  feedList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest('[data-toggle]')
    const id = button?.getAttribute('data-toggle')
    if (!id) return
    if (model.feed.toggle(id, model.setup.lang)) renderFeed(Date.now())
  })

  const bridge = typeof window === 'undefined' ? undefined : window.dsmap
  bridge?.onEvent?.((raw) => onIncoming(raw))
  bridge?.onStatus?.((statusPayload) => onStatus(statusPayload))

  if (bridge?.getConfig) {
    bridge
      .getConfig()
      .then((cfg) => applyConfig(cfg))
      .catch(() => setConnectionLost(true))
  } else {
    updateChrome()
    renderFeed(Date.now())
  }

  window.setInterval(() => {
    void probeChannel()
  }, PROBE_MS)

  const now = Date.now()
  renderFeed(now)
  renderMap(now)
}

/** Любое сообщение из main = цепочка до сайдкара жива. */
function onIncoming(raw: unknown): void {
  const now = Date.now()
  lastEventAt = now
  if (connectionLost) setConnectionLost(false)
  try {
    applyEvent(model, raw, now)
  } catch {
    // fail-open: битое событие не должно гасить панель. Логируем только имя.
    const name = raw && typeof raw === 'object' ? String((raw as LooseEvent).t ?? 'unknown') : typeof raw
    console.error('[ds-map] event not parsed:', name)
  }
  invalidate(now)
}

/** Заготовленный канал статуса: `main` говорит, жив ли WS. */
function onStatus(payload: unknown): void {
  const s = payload as { connected?: unknown } | null
  if (!s || typeof s.connected !== 'boolean') return
  setConnectionLost(!s.connected)
}

async function probeChannel(): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.dsmap
  if (!bridge?.getConfig) return
  // Аккуратный агент не шлёт событий часами — проверка только в простое.
  if (Date.now() - lastEventAt < IDLE_MS) return
  try {
    await bridge.getConfig()
  } catch {
    setConnectionLost(true)
  }
}

function setConnectionLost(lost: boolean): void {
  if (connectionLost === lost) return
  connectionLost = lost
  renderStatus()
}

function invalidate(now: number): void {
  renderFeed(now)
  if (isAnimating(model.state, now) || model.feed.isRunning()) {
    schedule()
    return
  }
  prune(model.state, now)
  renderMap(now)
  lastNowTick = Math.floor(now / 1000)
}

function schedule(): void {
  if (rafId === null) rafId = requestAnimationFrame(frame)
}

function frame(): void {
  const now = Date.now()
  if (now - lastFrameAt < FRAME_MS) {
    rafId = requestAnimationFrame(frame)
    return
  }
  lastFrameAt = now
  prune(model.state, now)
  renderMap(now)
  const tick = Math.floor(now / 1000)
  // Часы в строке «сейчас» идут раз в секунду; список ленты при этом не трогаем.
  if (tick !== lastNowTick && model.feed.isRunning()) renderFeedNow(now)
  rafId = isAnimating(model.state, now) || model.feed.isRunning() ? requestAnimationFrame(frame) : null
}

/** Каркас пересобирается только при смене темы/раскладки/языка. */
function renderMap(now: number): void {
  if (!mapEl) return
  const structure = structureKey(model.setup)
  if (structure !== mountedStructure) {
    mapEl.innerHTML = drawSkeleton(model.setup)
    layerBase = mapEl.querySelector('g[data-layer="base"]')
    layerFx = mapEl.querySelector('g[data-layer="fx"]')
    mountedStructure = structure
    mountedBase = ''
  }
  const base = baseKey(model.state, model.setup)
  if (base !== mountedBase && layerBase) {
    layerBase.innerHTML = drawBase(model.state, model.setup)
    mountedBase = base
  }
  if (layerFx) layerFx.innerHTML = drawEffects(model.state, now, model.setup)
}

function renderFeed(now: number): void {
  renderFeedList()
  renderFeedNow(now)
}

/**
 * Список ленты перепечатывается только когда изменились её данные или язык:
 * на кадр и на каждое событие, которое ничего не добавило, — ничего не трогаем.
 */
function renderFeedList(): void {
  if (!feedListEl) return
  if (mountedFeedRev === model.feed.revision && mountedFeedLang === model.setup.lang) return
  feedListEl.innerHTML = model.feed.render(model.setup.lang)
  mountedFeedRev = model.feed.revision
  mountedFeedLang = model.setup.lang
}

function renderFeedNow(now: number): void {
  if (!feedNowEl) return
  feedNowEl.innerHTML = model.feed.renderNow(model.setup.lang, now)
  lastNowTick = Math.floor(now / 1000)
}

function renderStatus(): void {
  if (!statusEl) return
  statusEl.textContent = connectionLost ? t(model.setup.lang, 'connectionLost') : ''
}

function applyConfig(cfg: Record<string, unknown>): void {
  const theme = cfg.theme
  const lang = cfg.lang
  const motion = cfg.motion
  if (theme === 'dark' || theme === 'light' || theme === 'auto') model.setup.theme = theme as ThemeSetting
  if (lang === 'ru' || lang === 'en') model.setup.lang = lang as Language
  if (motion === 'full' || motion === 'reduced') model.setup.motion = motion
  updateChrome()
  const now = Date.now()
  renderFeed(now)
  renderMap(now)
}

function applyTheme(theme: ThemeSetting): void {
  model.setup.theme = theme
  updateChrome()
  renderMap(Date.now())
  // main хранит только `dark|light`: в `auto` пишем то, что реально видно.
  persist({ theme: resolveTheme(theme) })
}

function applyLang(lang: Language): void {
  model.setup.lang = lang
  updateChrome()
  const now = Date.now()
  renderFeed(now)
  renderMap(now)
  persist({ lang })
}

function applyMotion(motion: 'full' | 'reduced'): void {
  model.setup.motion = motion
  updateChrome()
  const now = Date.now()
  if (motion === 'reduced') {
    prune(model.state, now)
    renderMap(now)
  } else {
    invalidate(now)
  }
  persist({ motion })
}

/** Всё, что читается из языка и темы: подписи кнопок, CSS-токены, `lang` документа. */
function updateChrome(): void {
  const lang = model.setup.lang
  const theme = resolveTheme(model.setup.theme)
  document.documentElement.lang = lang
  document.body.classList.toggle('light', theme === 'light')
  document.body.classList.toggle('dark', theme === 'dark')

  const vars = cssVars(getPalette(theme))
  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value)
  }

  const themeBtn = document.getElementById('theme-btn')
  const langBtn = document.getElementById('lang-btn')
  const motionBtn = document.getElementById('motion-btn')
  const feed = document.getElementById('feed')
  if (themeBtn) themeBtn.textContent = t(lang, theme === 'dark' ? 'themeDark' : 'themeLight')
  if (langBtn) langBtn.textContent = t(lang, lang === 'ru' ? 'languageRu' : 'languageEn')
  if (motionBtn) motionBtn.textContent = t(lang, model.setup.motion === 'full' ? 'motionFull' : 'motionReduced')
  if (feed) feed.setAttribute('aria-label', t(lang, 'feedTitle'))

  watchSystemThemeIfNeeded()
  renderStatus()
}

/** `auto` живёт, только если пришла из конфига: переключатель — dark/light. */
function watchSystemThemeIfNeeded(): void {
  if (model.setup.theme !== 'auto') {
    stopThemeWatch?.()
    stopThemeWatch = null
    return
  }
  if (stopThemeWatch) return
  stopThemeWatch = watchSystemTheme(() => {
    updateChrome()
    renderMap(Date.now())
  })
}

/** Запись настройки: отказ = канал до main лежит, это тот же `connectionLost`. */
function persist(patch: Record<string, string>): void {
  const bridge = typeof window === 'undefined' ? undefined : window.dsmap
  if (!bridge?.setConfig) return
  bridge.setConfig(patch).catch(() => setConnectionLost(true))
}
