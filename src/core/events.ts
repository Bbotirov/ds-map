/**
 * Схема событий ds-map (JSONL, один объект на строку).
 *
 * Все события имеют версии v:1. UI игнорирует неизвестные t и не падает.
 * Любая ошибка в маппере ловится и логируется локально (fail-open).
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
  context: { used: number; max: number }
}

export interface ToolStartEvent extends BaseEvent {
  t: 'tool.start'
  id: string
  name: string
  station: Station
  label: string
}

export interface ToolEndEvent extends BaseEvent {
  t: 'tool.end'
  id: string
  status: ToolStatus
  ms: number
}

export interface AnswerEvent extends BaseEvent {
  t: 'answer'
  ms: number
}

export interface ContextUpdateEvent extends BaseEvent {
  t: 'context.update'
  used: number
  max: number
}

export type DsMapEvent =
  | SessionStartEvent
  | PromptEvent
  | ModelStepEvent
  | ToolStartEvent
  | ToolEndEvent
  | AnswerEvent
  | ContextUpdateEvent

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
