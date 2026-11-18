/**
 * Модель карты на стороне расширения и единственная воронка приватности.
 *
 * В webview уходят только снимки — объекты, собранные из перечисленных полей.
 * Ни сырая строка журнала, ни неизвестное поле события попасть туда не могут
 * физически: это проекция по whitelist, а не фильтр по подстроке (§12 «только
 * имена, никогда содержимое»). Поэтому даже если сайдкар или будущая версия
 * харнеса пришлют лишнее, наружу уйдёт `unknown`.
 */

export const STATIONS = [
  'you',
  'model',
  'memory',
  'files',
  'shell',
  'web',
  'browser',
  'agents',
  'skills',
  'hooks',
] as const

export type Station = (typeof STATIONS)[number]

export const EVENT_TYPES = [
  'session.start',
  'turn.start',
  'prompt',
  'model.step',
  'model.think',
  'model.retry',
  'tool.start',
  'tool.end',
  'answer',
  'context.update',
  'model.switch',
  'job.start',
  'job.end',
  'compaction',
  'guard.set',
  'agent.msg',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const GUARD_KINDS = ['permission', 'sandbox', 'approval'] as const
export type GuardKind = (typeof GUARD_KINDS)[number]

/** Ряд ленты: `text` — ключ словаря webview, `label` — уже обезопасенное имя. */
export type Symbol_ = 'active' | 'done' | 'error' | 'switch'

export interface FeedRow {
  id: string | null
  ts: number
  station: Station
  symbol: Symbol_
  label: string | null
  key: string | null
  vars: Record<string, number> | null
  ms: number | null
  background: boolean
}

export interface StationStat {
  id: Station
  hits: number
  errors: number
  active: boolean
  lastTs: number
}

export interface MapSnapshot {
  kind: 'snapshot'
  connected: boolean
  session: string | null
  /** Выбранная пользователем сессия: панель следит за живой, но показывать надо выбор. */
  picked: string | null
  model: string | null
  turn: number
  context: { used: number; max: number; estimated: boolean } | null
  stations: StationStat[]
  feed: FeedRow[]
  errors: number
  /** Узлы подсвечиваются `ACTIVE_MS` после события: snapshot должен быть независим от часов webview. */
  now: number
  activeMs: number
}

/** Ключи словаря, которые вообще умеем отправлять: всё остальное — `null`. */
type RowKey =
  | 'sessionLabel'
  | 'turnLabel'
  | 'promptChars'
  | 'thinkLabel'
  | 'retryLabel'
  | 'answerOk'
  | 'answerErr'
  | 'answerAborted'
  | 'contextLabel'
  | 'modelSwitchLabel'
  | 'jobLabel'
  | 'compactionLabel'
  | 'guardLabel'
  | 'agentMsgLabel'

export const MAX_ROWS = 16
export const ACTIVE_MS = 1_500
const MAX_LABEL = 48

const NAME_TOKEN = /^[A-Za-z0-9_.:@+/-]{1,48}$/
// Управляющие символы вырезаем: в них прилетает перенос промпта или хвост аргумента.
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g
const ID = /^[A-Za-z0-9_.:-]{1,64}$/

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function number(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Имя-метка. Токен с флагом, кавычкой, `$`, перенаправлением или абсолютным
 * путём — это уже содержимое команды, а не имя (§7 правило 5), поэтому берём
 * не больше двух первых «голых» слов: `git status` — имя, `rm -rf /home/x` → `rm`.
 */
export function sanitizeLabel(v: unknown): string {
  if (typeof v !== 'string') return 'unknown'
  const kept: string[] = []
  for (const token of v.replace(CTRL, ' ').trim().split(/\s+/)) {
    if (!NAME_TOKEN.test(token) || token.startsWith('-') || token.startsWith('/') || token.startsWith('~')) break
    kept.push(token)
    if (kept.length === 2) break
  }
  return kept.join(' ').slice(0, MAX_LABEL) || 'unknown'
}

/** Имя, если оно пришло непустым: `sanitizeLabel` на пустоте выдаёт `unknown`. */
function name(v: unknown): string {
  return typeof v === 'string' && v.trim() !== '' ? sanitizeLabel(v) : ''
}

/** Идентификаторы (сессия, вызов) — строгая проверка, а не «обрезать по пробелам». */
export function sanitizeId(v: unknown): string | null {
  return typeof v === 'string' && ID.test(v) ? v : null
}

function stationOf(v: unknown): Station {
  return STATIONS.includes(v as Station) ? (v as Station) : 'shell'
}

function statusOf(v: unknown): 'ok' | 'err' | 'unknown' {
  return v === 'err' || v === 'ok' || v === 'unknown' ? v : 'unknown'
}

interface OpenRow {
  row: FeedRow
  station: Station
}

/** Аргумент `push`: всё, кроме станции/символа/времени, необязательно. */
interface RowInit {
  station: Station
  symbol: Symbol_
  ts: number
  label?: string | null
  key?: string | null
  vars?: Record<string, number> | null
  ms?: number | null
  background?: boolean
  id?: string | null
}

/**
 * Накопитель событий → снимок. Никакого ввода-вывода и никакого `vscode`:
 * весь мост в webview проверяется вызовом `ingest` + `snapshot`.
 */
export class MapModel {
  private stats = new Map<Station, StationStat>()
  private rows: FeedRow[] = []
  private open = new Map<string, OpenRow>()
  private session: string | null = null
  private model: string | null = null
  private turn = 0
  private context: MapSnapshot['context'] = null
  private errors = 0
  private connected = false
  private picked: string | null = null
  private readonly clock: () => number

  /** `clock` инжектится только тестам: снимок обязан жить на часах расширения. */
  constructor(clock: () => number = Date.now) {
    this.clock = clock
    this.reset()
  }

  /** Новая сессия (или reconnect с историей) — карта начинается заново. */
  reset(): void {
    this.stats = new Map(
      STATIONS.map((id) => [id, { id, hits: 0, errors: 0, active: false, lastTs: 0 }]),
    )
    this.rows = []
    this.open = new Map()
    this.turn = 0
    this.errors = 0
  }

  /**
   * @returns true, если событие принято и снимок изменился.
   * Неизвестная форма отбрасывается молча: fail-open (§7 правило 10), ронять
   * ни хвост, ни редактор из-за чужой записи нельзя.
   */
  ingest(raw: unknown): boolean {
    try {
      return this.apply(raw)
    } catch {
      return false
    }
  }

  private apply(raw: unknown): boolean {
    const e = record(raw)
    // Признак «наше» записи: v:1 и известный `t`. Сырая запись харнеса
    // (`type: 'session/title'`) не проходит уже здесь.
    if (!e || e.v !== 1 || typeof e.t !== 'string') return false
    const type = e.t as EventType
    if (!EVENT_TYPES.includes(type)) return false

    const ts = number(e.ts, this.clock())
    switch (type) {
      case 'session.start': {
        const session = sanitizeId(e.session)
        const fresh = session !== null && session !== this.session
        this.session = session
        this.model = sanitizeLabel(e.model)
        if (fresh) this.reset()
        this.push({ station: 'model', key: 'sessionLabel', symbol: 'done', ts })
        this.touch('model', ts)
        return true
      }
      case 'turn.start': {
        this.turn = Math.max(0, Math.trunc(number(e.turn)))
        this.push({ station: 'you', key: 'turnLabel', symbol: 'active', ts, vars: { n: this.turn } })
        this.touch('you', ts)
        return true
      }
      case 'prompt': {
        // Только длина запроса: самого текста в схеме событий не существует.
        this.push({ station: 'you', key: 'promptChars', symbol: 'done', ts, vars: { n: Math.max(0, Math.trunc(number(e.chars))) } })
        this.touch('you', ts)
        return true
      }
      case 'model.step':
      case 'context.update': {
        const ctx = type === 'model.step' ? record(e.context) : e
        if (ctx) {
          const used = Math.max(0, number(ctx.used))
          const max = Math.max(0, number(ctx.max))
          this.context = { used, max, estimated: ctx.estimated === true }
        }
        this.touch('model', ts)
        if (type === 'model.step') this.push({ station: 'model', symbol: 'active', ts })
        return true
      }
      case 'model.think': {
        const ms = Math.max(0, number(e.ms))
        this.push({ station: 'model', key: 'thinkLabel', symbol: 'done', ts, ms })
        this.touch('model', ts)
        return true
      }
      case 'model.retry': {
        // Текст ошибки харнес кладёт рядом — наружу идут только номера попыток.
        this.push({
          station: 'model',
          key: 'retryLabel',
          symbol: 'error',
          ts,
          vars: { n: Math.max(0, Math.trunc(number(e.attempt))), of: Math.max(0, Math.trunc(number(e.of))) },
        })
        this.errors++
        this.touch('model', ts)
        return true
      }
      case 'tool.start':
      case 'job.start': {
        const id = sanitizeId(e.id)
        const station = stationOf(e.station)
        const background = type === 'job.start'
        const row: FeedRow = {
          id,
          ts,
          station,
          symbol: 'active',
          label: sanitizeLabel(e.label),
          key: background ? 'jobLabel' : null,
          vars: background ? { n: 0 } : null,
          ms: null,
          background,
        }
        if (id) this.open.set(id, { row, station })
        this.rows.unshift(row)
        this.trim()
        this.touch(station, ts)
        return true
      }
      case 'tool.end':
      case 'job.end': {
        const id = sanitizeId(e.id)
        const status = statusOf(e.status)
        const held = id ? this.open.get(id) : undefined
        if (held && id) {
          this.open.delete(id)
          held.row.symbol = status === 'err' ? 'error' : 'done'
          held.row.ms = Math.max(0, number(e.ms))
          if (held.row.key === null) held.row.label = sanitizeLabel(e.label)
          if (status === 'err') this.errors++
        } else {
          this.push({
            station: stationOf(e.station),
            symbol: status === 'err' ? 'error' : 'done',
            ts,
            label: sanitizeLabel(e.label),
            ms: Math.max(0, number(e.ms)),
          })
          if (status === 'err') this.errors++
        }
        this.touch(stationOf(e.station), ts)
        return true
      }
      case 'answer': {
        const status = e.status === 'err' || e.status === 'aborted' ? e.status : 'ok'
        const key: RowKey = status === 'err' ? 'answerErr' : status === 'aborted' ? 'answerAborted' : 'answerOk'
        // Ход закончился: всё, что не дожило до результата, гасим точкой.
        // Фоновая работа остаётся открытой — она ждёт отчёт, а не конец хода.
        for (const [callId, held] of [...this.open]) {
          if (held.row.background) continue
          held.row.symbol = 'done'
          this.open.delete(callId)
        }
        if (status === 'err') this.errors++
        this.push({ station: 'model', key, symbol: status === 'err' ? 'error' : 'done', ts, ms: Math.max(0, number(e.ms)) })
        this.touch('model', ts)
        return true
      }
      case 'model.switch': {
        // Пустое `from` — харнес назвал модель впервые, переключения не было:
        // ряд обязан подписать модель, а не рисовать «unknown → glm-4.7».
        const from = name(e.from)
        const to = name(e.to)
        if (to) this.model = to
        this.push({
          station: 'model',
          key: 'modelSwitchLabel',
          symbol: 'switch',
          ts,
          label: from && to ? `${from} → ${to}` : to || from,
        })
        this.touch('model', ts)
        return true
      }
      case 'compaction': {
        const phase = e.phase === 'end' ? 'end' : 'start'
        this.push({
          station: 'model',
          key: 'compactionLabel',
          symbol: phase === 'start' ? 'active' : 'done',
          ts,
          ms: Math.max(0, number(e.ms)),
          vars: { n: phase === 'start' ? 1 : 2 },
        })
        this.touch('model', ts)
        return true
      }
      case 'guard.set': {
        const kind = GUARD_KINDS.includes(e.kind as GuardKind) ? (e.kind as GuardKind) : 'permission'
        // Имя правила из конфига харнеса; без него ряд показывает сам род правила.
        const label = name(e.label) || kind
        this.push({ station: 'hooks', key: 'guardLabel', symbol: 'done', ts, label })
        this.touch('hooks', ts)
        return true
      }
      case 'agent.msg': {
        // Тела писем в логе харнеса полные: наружу выходит только число.
        this.push({ station: 'agents', key: 'agentMsgLabel', symbol: 'done', ts, vars: { n: Math.max(0, Math.trunc(number(e.inserted))) } })
        this.touch('agents', ts)
        return true
      }
      default:
        return false
    }
  }

  private push(init: RowInit): void {
    this.rows.unshift({
      id: init.id ?? null,
      ts: init.ts,
      station: init.station,
      symbol: init.symbol,
      label: init.label ?? null,
      key: init.key ?? null,
      vars: init.vars ?? null,
      ms: init.ms ?? null,
      background: init.background ?? false,
    })
    this.trim()
  }

  private trim(): void {
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS
  }

  private touch(station: Station, ts: number): void {
    const stat = this.stats.get(station)
    if (!stat) return
    stat.hits++
    stat.lastTs = ts
  }

  /** Ряды «ещё идут», если их не закрыли и с события прошла доля ACTIVE_MS. */
  snapshot(): MapSnapshot {
    const now = this.clock()
    const stations = STATIONS.map((id) => {
      const stat = this.stats.get(id) ?? { id, hits: 0, errors: 0, active: false, lastTs: 0 }
      const openHere = [...this.open.values()].some((h) => h.station === id)
      return {
        id,
        hits: stat.hits,
        errors: stat.errors,
        active: openHere || (stat.lastTs > 0 && now - stat.lastTs <= ACTIVE_MS),
        lastTs: stat.lastTs,
      }
    })
    return {
      kind: 'snapshot',
      connected: this.connected,
      session: this.session,
      picked: this.picked,
      model: this.model,
      turn: this.turn,
      context: this.context,
      stations,
      feed: this.rows.map((r) => ({ ...r })),
      errors: this.errors,
      now,
      activeMs: ACTIVE_MS,
    }
  }

  setConnected(value: boolean): void {
    this.connected = value
  }

  setPicked(session: string | null): void {
    this.picked = sanitizeId(session)
  }
}
