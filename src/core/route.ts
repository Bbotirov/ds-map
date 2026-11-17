/**
 * Маршрутизация событий: превращает сырые события харнеса в события ds-map.
 * Не знает про Electron, сеть и файловую систему.
 */

import { safe, fileLabel, commandLabel, urlLabel } from './redact.js'
import { classifyShell, classifyTool, type Station } from './classify.js'
import type { DsMapEvent, SessionStartEvent, PromptEvent, ModelStepEvent, ToolStartEvent, ToolEndEvent, AnswerEvent, ContextUpdateEvent, ToolStatus } from './events.js'

export interface RawToolCall {
  callId: string
  name: string
  arguments: string | Record<string, unknown>
  turn: number
  step: number
}

export interface RawToolResult {
  toolCallId: string
  isError: boolean
  meta?: { path?: string; totalLines?: number }
  turn: number
  step: number
}

export interface RawSession {
  id: string
  model: string
  cwd: string
}

export interface RawContext {
  used: number
  max: number
}

let nextId = 0
function nextCallId(): string {
  return `call_${++nextId}`
}

// Состояние сессии для подсчёта ms и追�и вызовов
const openCalls = new Map<string, { name: string; startedAt: number }>()

export function sessionStart(raw: RawSession): SessionStartEvent {
  return {
    v: 1,
    t: 'session.start',
    ts: Date.now(),
    session: raw.id,
    model: raw.model,
    cwd: raw.cwd,
  }
}

export function prompt(chars: number): PromptEvent {
  return {
    v: 1,
    t: 'prompt',
    ts: Date.now(),
    chars,
  }
}

export function modelStep(context: RawContext): ModelStepEvent {
  return {
    v: 1,
    t: 'model.step',
    ts: Date.now(),
    context,
  }
}

export function contextUpdate(used: number, max: number): ContextUpdateEvent {
  return {
    v: 1,
    t: 'context.update',
    ts: Date.now(),
    used,
    max,
  }
}

export function answer(ms: number): AnswerEvent {
  return {
    v: 1,
    t: 'answer',
    ts: Date.now(),
    ms,
  }
}

/**
 * Превратить вызов инструмента в tool.start + безопасную метку.
 * Fail-open: сбой мапpera → station=shell, label=unknown.
 */
export function toolStart(raw: RawToolCall): ToolStartEvent {
  return safe(() => {
    const id = raw.callId || nextCallId()
    const station = classifyTool(raw.name)
    const label = mapLabel(raw.name, raw.arguments)
    openCalls.set(id, { name: raw.name, startedAt: Date.now() })
    return {
      v: 1,
      t: 'tool.start',
      ts: Date.now(),
      id,
      name: raw.name,
      station,
      label,
    }
  }, {
    v: 1,
    t: 'tool.start',
    ts: Date.now(),
    id: raw.callId || nextCallId(),
    name: raw.name,
    station: 'shell',
    label: 'unknown',
  })
}

/**
 * Превратить результат инструмента в tool.end.
 * Fail-open: сбой маппера → status=unknown.
 */
export function toolEnd(raw: RawToolResult): ToolEndEvent {
  return safe(() => {
    const open = openCalls.get(raw.toolCallId)
    const startedAt = open?.startedAt ?? Date.now()
    const ms = Date.now() - startedAt
    openCalls.delete(raw.toolCallId)
    return {
      v: 1,
      t: 'tool.end',
      ts: Date.now(),
      id: raw.toolCallId,
      status: raw.isError ? 'err' : 'ok',
      ms,
    }
  }, {
    v: 1,
    t: 'tool.end',
    ts: Date.now(),
    id: raw.toolCallId,
    status: 'unknown' as ToolStatus,
    ms: 0,
  })
}

/**
 * Безопасная метка: только имя, никогда содержимое.
 */
function mapLabel(name: string, args: string | Record<string, unknown>): string {
  // Попытка распарсить аргументы как JSON (DSH передаёт structured args в строку)
  let parsed: Record<string, unknown> | undefined
  if (typeof args === 'string') {
    try {
      const p = JSON.parse(args)
      if (p && typeof p === 'object' && !Array.isArray(p)) parsed = p as Record<string, unknown>
    } catch {
      // не JSON — оставим как строку
    }
  } else if (typeof args === 'object' && args !== null) {
    parsed = args
  }

  const n = name.toLowerCase()
  if (n === 'read' || n === 'read_file' || n === 'write_file' || n === 'edit') {
    if (parsed && 'path' in parsed) return fileLabel(String(parsed.path))
    if (parsed && 'file_path' in parsed) return fileLabel(String(parsed.file_path))
    if (typeof args === 'string' && !parsed) return fileLabel(args)
    return 'unknown'
  }
  if (n === 'bash' || n === 'shell' || n === 'command' || n === 'pwsh' || n === 'powershell') {
    if (typeof args === 'string' && !parsed) return commandLabel(args)
    if (parsed && 'command' in parsed) return commandLabel(String(parsed.command))
    return 'unknown'
  }
  if (n === 'grep' || n === 'search' || n === 'glob') {
    return name
  }
  if (n === 'web' || n === 'fetch' || n === 'web_search') {
    if (parsed && 'url' in parsed) return urlLabel(String(parsed.url))
    if (typeof args === 'string' && !parsed) return urlLabel(args)
    return name
  }
  return name
}
