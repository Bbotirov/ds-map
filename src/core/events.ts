/**
 * Схема событий ds-map (JSONL, один объект на строку).
 *
 * Все события имеют версии v:1. UI игнорирует неизвестные `t` и не падает.
 * Любая ошибка в маппере ловится и логируется локально (fail-open).
 *
 * `ts` — это время события из источника, а не момент разбора: при чтении
 * истории сессии лента и маршрут должны сохранять исходный порядок и тайминги.
 */

export type Station =
  | 'you'
  | 'model'
  | 'memory'
  | 'files'
  | 'shell'
  | 'web'
  | 'browser'
  | 'agents'
  | 'skills'
  | 'hooks'

export type ToolStatus = 'ok' | 'err' | 'unknown'

export type EventType =
  | 'session.start'
  | 'prompt'
  | 'model.step'
  | 'tool.start'
  | 'tool.end'
  | 'answer'
  | 'context.update'
  | 'model.switch'
  | 'job.start'
  | 'job.end'
  | 'compaction'

export interface BaseEvent {
  v: 1
  t: EventType
  ts: number
}

export interface SessionStartEvent extends BaseEvent {
  t: 'session.start'
  session: string
  model: string
  cwd: string
}

export interface PromptEvent extends BaseEvent {
  t: 'prompt'
  chars: number
}

export interface ModelStepEvent extends BaseEvent {
  t: 'model.step'
  context: ContextReading
}

/**
 * Считанное состояние контекста. `estimated: true` — когда точного `usage`
 * нет и число получено оценкой по символам; UI обязан показывать префикс `~`.
 */
export interface ContextReading {
  used: number
  max: number
  estimated: boolean
}

export interface ToolStartEvent extends BaseEvent {
  t: 'tool.start'
  id: string
  name: string
  station: Station
  label: string
}

/**
 * `station`/`name`/`label` дублируются из tool.start: вызов закрывается по
 * `id`, но лента должна погасить именно ту строку, не угадывая её по времени.
 */
export interface ToolEndEvent extends BaseEvent {
  t: 'tool.end'
  id: string
  name: string
  station: Station
  label: string
  status: ToolStatus
  ms: number
}

export interface AnswerEvent extends BaseEvent {
  t: 'answer'
  ms: number
  status: 'ok' | 'err' | 'aborted'
}

export interface ContextUpdateEvent extends BaseEvent {
  t: 'context.update'
  used: number
  max: number
  estimated: boolean
}

/** Смена модели — в ленте символ `◆`, на станции `model` подсветка SWITCH_MS. */
export interface ModelSwitchEvent extends BaseEvent {
  t: 'model.switch'
  from: string
  to: string
}

/** Фоновая работа: запущенная команда, монитор, фоновый субагент. */
export interface JobStartEvent extends BaseEvent {
  t: 'job.start'
  id: string
  station: Station
  label: string
}

export interface JobEndEvent extends BaseEvent {
  t: 'job.end'
  id: string
  station: Station
  status: 'ok' | 'err' | 'unknown'
  ms: number
}

/** Компактификация контекста — это работа модели, станция `model`. */
export interface CompactionEvent extends BaseEvent {
  t: 'compaction'
  phase: 'start' | 'end'
  ms: number
}

export type DsMapEvent =
  | SessionStartEvent
  | PromptEvent
  | ModelStepEvent
  | ToolStartEvent
  | ToolEndEvent
  | AnswerEvent
  | ContextUpdateEvent
  | ModelSwitchEvent
  | JobStartEvent
  | JobEndEvent
  | CompactionEvent

export function isToolStart(e: DsMapEvent): e is ToolStartEvent {
  return e.t === 'tool.start'
}

export function isToolEnd(e: DsMapEvent): e is ToolEndEvent {
  return e.t === 'tool.end'
}

export function isModelStep(e: DsMapEvent): e is ModelStepEvent {
  return e.t === 'model.step'
}

export function isContextUpdate(e: DsMapEvent): e is ContextUpdateEvent {
  return e.t === 'context.update'
}

export function isSessionStart(e: DsMapEvent): e is SessionStartEvent {
  return e.t === 'session.start'
}
