/**
 * Маршрутизация событий: сырая запись сессионного JSONL харнеса → события ds-map.
 *
 * `core/` не знает ни про файловую систему, ни про Electron: сюда приходит
 * уже разобранная строка, отсюда выходят готовые события схемы v:1.
 *
 * Время берётся из записи (`time`), а не из часов разбора: при чтении истории
 * сессии все события пришли бы одним мгновением, и лента, маршрут и тайминги
 * вызовов стали бы ложью.
 */

import { safe, fileLabel, commandLabel, urlLabel, clean } from './redact.js'
import { classifyTool, type Station } from './classify.js'
import type {
  DsMapEvent, ContextReading, ToolStatus, SessionStartEvent, PromptEvent, ModelStepEvent,
  ToolStartEvent, ToolEndEvent, AnswerEvent, ContextUpdateEvent, ModelSwitchEvent,
  JobStartEvent, JobEndEvent, CompactionEvent,
} from './events.js'

/** Одна строка session.v4.jsonl после JSON.parse. */
export interface HarnessRecord {
  type?: string
  seq?: number
  time?: number
  id?: string
  version?: number
  cwd?: string
  createdAt?: number
  data?: Record<string, unknown>
}

export interface RawToolCall {
  callId: string
  name: string
  arguments: string | Record<string, unknown>
  turn: number
  step: number
}

export interface RawSession {
  id: string
  model: string
  cwd: string
}

let nextId = 0
function nextCallId(): string {
  return `call_${++nextId}`
}

function timeOf(rec: HarnessRecord, fallback: number): number {
  return typeof rec.time === 'number' && Number.isFinite(rec.time) ? rec.time : fallback
}

/**
 * Извлечь аргументы вызова. Харнес пишет их JSON-строкой; если разбор не
 * удался — содержимое не используется, остаётся только имя инструмента.
 */
export function parseArgs(args: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>
  if (typeof args !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(args)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// --- конструкторы событий (экспортированы для тестов и других источников) ---

export function sessionStart(raw: RawSession, ts = Date.now()): SessionStartEvent {
  return { v: 1, t: 'session.start', ts, session: raw.id, model: raw.model, cwd: raw.cwd }
}

export function prompt(chars: number, ts = Date.now()): PromptEvent {
  return { v: 1, t: 'prompt', ts, chars }
}

export function modelStep(context: ContextReading, ts = Date.now()): ModelStepEvent {
  return { v: 1, t: 'model.step', ts, context }
}

export function contextUpdate(context: ContextReading, ts = Date.now()): ContextUpdateEvent {
  return { v: 1, t: 'context.update', ts, used: context.used, max: context.max, estimated: context.estimated }
}

export function answer(ms: number, status: AnswerEvent['status'] = 'ok', ts = Date.now()): AnswerEvent {
  return { v: 1, t: 'answer', ts, ms, status }
}

export function modelSwitch(from: string, to: string, ts = Date.now()): ModelSwitchEvent {
  return { v: 1, t: 'model.switch', ts, from, to }
}

export function compaction(phase: CompactionEvent['phase'], ms: number, ts = Date.now()): CompactionEvent {
  return { v: 1, t: 'compaction', ts, phase, ms }
}

export function jobStart(id: string, station: Station, label: string, ts = Date.now()): JobStartEvent {
  return { v: 1, t: 'job.start', ts, id, station, label }
}

export function jobEnd(id: string, station: Station, status: JobEndEvent['status'], ms: number, ts = Date.now()): JobEndEvent {
  return { v: 1, t: 'job.end', ts, id, station, status, ms }
}

/**
 * Метка вызова: только имя, никогда содержимое (§7 правила 2–6).
 * Разбор аргументов нужен лишь чтобы выбрать имя файла, имя команды или хост.
 */
export function mapLabel(name: string, args: string | Record<string, unknown> | undefined): string {
  const a = parseArgs(args)
  const n = name.toLowerCase()

  if (n === 'read' || n === 'write' || n === 'edit' || n === 'notebookedit') {
    return fileLabel(str(a.file_path) || str(a.path) || str(a.notebook_path) || 'unknown')
  }
  if (n === 'glob' || n === 'grep') return n
  if (n === 'pwsh' || n === 'bash' || n === 'shell' || n === 'command') {
    return commandLabel(str(a.command) || 'unknown')
  }
  if (n === 'subagent' || n === 'subagent_fork') {
    // §12: субагент показывается описанием, с которым его запустили.
    return clean(str(a.description) || n)
  }
  if (n === 'skill') return clean(str(a.name) || n)
  if (n === 'todo_write' || n === 'create_goal' || n === 'update_goal' || n === 'get_goal') return n
  if (n.endsWith('browser_navigate') || n.endsWith('browser_tab_new')) {
    return urlLabel(str(a.url) || 'unknown')
  }
  return n
}

/**
 * Начало вызова. Fail-open: сбой маппера даёт станцию shell и метку unknown,
 * а не исключение наверх (§7 правило 10).
 */
export function toolStart(raw: RawToolCall, ts = Date.now()): ToolStartEvent {
  return safe(() => {
    const station = classifyTool(raw.name, commandOf(raw))
    return {
      v: 1,
      t: 'tool.start',
      ts,
      id: raw.callId || nextCallId(),
      name: raw.name,
      station,
      label: mapLabel(raw.name, raw.arguments),
    }
  }, { v: 1, t: 'tool.start', ts, id: raw.callId || nextCallId(), name: raw.name, station: 'shell', label: 'unknown' })
}

/** Текст команды внутри вызова — он определяет станцию для шелл-инструментов. */
function commandOf(raw: RawToolCall): string | undefined {
  const n = raw.name.toLowerCase()
  if (n !== 'pwsh' && n !== 'bash' && n !== 'shell' && n !== 'command') return undefined
  const a = parseArgs(raw.arguments)
  return str(a.command) || undefined
}

export function toolEnd(
  raw: { toolCallId: string; isError: boolean },
  open: { name: string; station: Station; label: string; startedAt: number } | undefined,
  ts = Date.now(),
): ToolEndEvent {
  return safe(
    () => ({
      v: 1,
      t: 'tool.end',
      ts,
      id: raw.toolCallId,
      name: open?.name ?? raw.toolCallId,
      station: open?.station ?? 'shell',
      label: open?.label ?? 'unknown',
      status: (open ? (raw.isError ? 'err' : 'ok') : 'unknown') as ToolStatus,
      ms: open ? Math.max(0, ts - open.startedAt) : 0,
    }),
    { v: 1, t: 'tool.end', ts, id: raw.toolCallId, name: raw.toolCallId, station: 'shell', label: 'unknown', status: 'unknown', ms: 0 },
  )
}

/**
 * Состояние контекста по записям харнеса.
 * `usage.totalTokens - outputTokens` — это ровно то, сколько токеном ушло в
 * запрос (свежие плюс кэшированные), то есть заполненность окна.
 */
export function contextFromUsage(usage: Record<string, unknown> | undefined, contextWindow: number): ContextReading | null {
  if (!usage || contextWindow <= 0) return null
  const total = num(usage.totalTokens)
  const output = num(usage.outputTokens)
  const used = total > 0 ? total - output : num(usage.inputTokens) + num(usage.cacheReadTokens)
  if (used <= 0) return null
  return { used, max: contextWindow, estimated: false }
}

/**
 * Оценка заполнения по объёму переписки, когда `usage` не пришёл.
 * Отмечается как оценка: ложная точность хуже оценки (§19).
 */
export function estimateContext(chars: number, contextWindow: number): ContextReading | null {
  if (contextWindow <= 0 || chars <= 0) return null
  return { used: Math.round(chars / 4), max: contextWindow, estimated: true }
}

/**
 * Маппер одной сессии: помнит открытые вызовы, окно контекста и начало хода,
 * потому что харнес не дублирует эти данные в каждой записи.
 */
export class EventMapper {
  private open = new Map<string, { name: string; station: Station; label: string; startedAt: number }>()
  private contextWindow = 0
  private context: ContextReading | null = null
  private turnStartedAt = new Map<number, number>()
  private compactionStartedAt = new Map<string, number>()
  private model = ''
  private chars = 0

  /**
   * Одна запись → ноль, один или два события. Неизвестный `type` — тихо
   * возвращает пустой список: UI и лента не должны падать на новом коде харнеса.
   */
  map(rec: HarnessRecord): DsMapEvent[] {
    const data = rec.data ?? {}
    const ts = timeOf(rec, Date.now())

    switch (rec.type) {
      case 'session':
        return this.onSession(rec, ts)

      case 'turn/start':
        this.turnStartedAt.set(num(data.turn), ts)
        return []

      case 'turn/end':
        return this.onTurnEnd(data, ts)

      case 'step/start':
        return this.onStep(ts)

      case 'user/message':
        this.chars += textLength(data.content)
        return this.onUserMessage(data, ts)

      case 'assistant/message': {
        const usage = data.usage as Record<string, unknown> | undefined
        this.chars += textLength(data.message)
        const next = contextFromUsage(usage, this.contextWindow)
        if (next) this.context = next
        return []
      }

      case 'request/context':
        return this.onRequestContext(data)

      case 'model/selection':
        return this.onModelSelection(data, ts)

      case 'compaction/start':
        this.compactionStartedAt.set(str(data.compactionId), ts)
        return [modelStep(this.currentContext(), ts)]

      case 'compaction/end':
        return this.onCompactionEnd(data, ts)

      case 'job/registered':
        return [jobStart(str(data.jobId) || nextCallId(), stationOfJob(data), clean(str(data.label)) || 'job', ts)]

      case 'job/settled':
        return this.onJobSettled(data, ts)

      case 'tool/call':
        return this.onToolCall(data, ts)

      case 'tool/result':
        return this.onToolResult(data, ts)

      default:
        return []
    }
  }

  private onSession(rec: HarnessRecord, ts: number): DsMapEvent[] {
    this.reset()
    return [sessionStart({ id: rec.id || 'unknown', model: this.model || 'unknown', cwd: rec.cwd ?? '' }, ts)]
  }

  private onTurnEnd(data: Record<string, unknown>, ts: number): DsMapEvent[] {
    const turn = num(data.turn)
    const started = this.turnStartedAt.get(turn)
    this.turnStartedAt.delete(turn)
    const reason = (data.reason ?? {}) as Record<string, unknown>
    const kind = str(reason.kind)
    const status: AnswerEvent['status'] = kind === 'error' ? 'err' : kind === 'aborted' ? 'aborted' : 'ok'
    return [answer(started ? Math.max(0, ts - started) : 0, status, ts)]
  }

  private onStep(ts: number): DsMapEvent[] {
    return [modelStep(this.currentContext(), ts)]
  }

  /**
   * Харнес пишет в `user/message` и служебный контекст (runtime-context,
   * time-context, компактификационные чекпойнты). Промпт — только реплика
   * пользователя: иначе лента тонет в служебных вставках, а красные точки
   * ошибок гаснут, не дожив до следующего вопроса (§11).
   */
  private onUserMessage(data: Record<string, unknown>, ts: number): DsMapEvent[] {
    const source = (data.source ?? {}) as Record<string, unknown>
    if (str(source.kind) !== 'user') return []
    return [prompt(textLength(data.content), ts)]
  }

  private onRequestContext(data: Record<string, unknown>): DsMapEvent[] {
    const window = num(data.contextWindow)
    if (window <= 0) return []
    this.contextWindow = window
    if (!this.model) this.model = str(data.model)
    // Окно известно, а заполнения ещё нет — допустима оценка по объёму.
    if (!this.context) this.context = estimateContext(this.chars, window)
    return []
  }

  private onModelSelection(data: Record<string, unknown>, ts: number): DsMapEvent[] {
    const provider = str(data.provider)
    const rawModel = data.model
    const name = typeof rawModel === 'string' ? rawModel : modelFromObject(rawModel)
    if (!name) return []
    const full = provider && !name.includes('/') ? `${provider}/${name}` : name
    const from = this.model
    this.model = full
    if (from === full) return []
    return [modelSwitch(from, full, ts)]
  }

  private onCompactionEnd(data: Record<string, unknown>, ts: number): DsMapEvent[] {
    const id = str(data.compactionId)
    const started = this.compactionStartedAt.get(id)
    this.compactionStartedAt.delete(id)
    const usage = data.usage as Record<string, unknown> | undefined
    const next = contextFromUsage(usage, this.contextWindow)
    if (next) this.context = next
    return [compaction('end', started ? Math.max(0, ts - started) : 0, ts)]
  }

  private onJobSettled(data: Record<string, unknown>, ts: number): DsMapEvent[] {
    const startedAt = num(data.startedAt)
    const finishedAt = num(data.finishedAt)
    const status = str(data.status)
    return [
      jobEnd(
        str(data.jobId) || nextCallId(),
        stationOfJob(data),
        status === 'ok' || status === 'settled' ? 'ok' : status ? 'err' : 'unknown',
        startedAt && finishedAt ? Math.max(0, finishedAt - startedAt) : 0,
        ts,
      ),
    ]
  }

  private onToolCall(data: Record<string, unknown>, ts: number): DsMapEvent[] {
    const raw: RawToolCall = {
      callId: str(data.callId),
      name: str(data.name),
      arguments: (data.arguments ?? '') as string | Record<string, unknown>,
      turn: num(data.turn),
      step: num(data.step),
    }
    if (!raw.name) return []
    const evt = toolStart(raw, ts)
    this.open.set(evt.id, { name: evt.name, station: evt.station, label: evt.label, startedAt: ts })
    return [evt]
  }

  private onToolResult(data: Record<string, unknown>, ts: number): DsMapEvent[] {
    const message = (data.message ?? {}) as Record<string, unknown>
    const toolCallId = str(message.toolCallId)
    if (!toolCallId) return []
    const open = this.open.get(toolCallId)
    this.open.delete(toolCallId)
    return [toolEnd({ toolCallId, isError: message.isError === true }, open, ts)]
  }

  /**
   * Актуальное заполнение окна. Без `usage` — оценка по символам с флагом
   * `estimated`; без размера окна — пустое кольцо, а не ноль процентов.
   */
  currentContext(): ContextReading {
    return this.context ?? estimateContext(this.chars, this.contextWindow) ?? { used: 0, max: 0, estimated: true }
  }

  /** Конец хода обязан закрыть всё висющее: иначе пульсы не доживают до ответа. */
  closeDangling(ts: number): DsMapEvent[] {
    const events: DsMapEvent[] = []
    for (const [id, open] of this.open) {
      events.push({
        v: 1, t: 'tool.end', ts, id, name: open.name, station: open.station, label: open.label,
        status: 'unknown', ms: Math.max(0, ts - open.startedAt),
      })
    }
    this.open.clear()
    return events
  }

  reset(): void {
    this.open.clear()
    this.turnStartedAt.clear()
    this.compactionStartedAt.clear()
    this.context = null
    this.contextWindow = 0
    this.chars = 0
  }
}

/** Фоновые задачи харнеса: `kind` — имя инструмента, который их породил. */
function stationOfJob(data: Record<string, unknown>): Station {
  const kind = str(data.kind)
  if (!kind) return 'agents'
  return classifyTool(kind)
}

function modelFromObject(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const o = raw as Record<string, unknown>
  return str(o.id) || str(o.name) || str(o.model)
}

/**
 * Объём текста в записи — нужен только для оценки контекста, содержимое не
 * сохраняется. Служебные поля (`type`, `mimeType`, base64 вложений) в зачёт
 * не идут: иначе оценка превратилась бы в длину картинки.
 */
function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textLength(item), 0)
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.text === 'string') return o.text.length
    if (o.content !== undefined) return textLength(o.content)
  }
  return 0
}
