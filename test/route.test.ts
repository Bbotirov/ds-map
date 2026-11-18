import { describe, it, expect } from 'vitest'
import {
  EventMapper, mapLabel, parseArgs, contextFromUsage, estimateContext,
  type HarnessRecord,
} from '../src/core/route.js'
import type { ToolStartEvent, ToolEndEvent, AnswerEvent, ModelSwitchEvent, JobStartEvent, JobEndEvent } from '../src/core/events.js'

/**
 * Формулы записей соответствуют реальным session.v4.jsonl харнеса 0.2.2-rc.1:
 * поля `session` — верхнего уровня, аргументы вызова — JSON-строка, результат
 * лежит в `data.message`. Содержимое в фикстурах вымышленное.
 */
function rec(type: string, data: Record<string, unknown> = {}, extra: Partial<HarnessRecord> = {}): HarnessRecord {
  return { type, seq: 1, time: 1_000, data, ...extra }
}

function first(mapper: EventMapper, record: HarnessRecord): unknown {
  const events = mapper.map(record)
  return events[0]
}

function toolStartOf(name: string, args: unknown, time = 1_000): ToolStartEvent {
  const mapper = new EventMapper()
  mapper.map(rec('request/context', { provider: 'nvidia', model: 'm', contextWindow: 1000 }))
  const evt = mapper.map(rec('tool/call', { callId: 'c1', name, arguments: JSON.stringify(args), turn: 1, step: 1 }, { time }))
  return evt[0] as ToolStartEvent
}

describe('parseArgs', () => {
  it('разбирает JSON-строку аргументов', () => {
    expect(parseArgs('{"file_path":"src/a.ts"}')).toEqual({ file_path: 'src/a.ts' })
  })

  it('принимает уже объект', () => {
    expect(parseArgs({ path: 'a' })).toEqual({ path: 'a' })
  })

  it('не бросает на мусоре', () => {
    expect(parseArgs('не json')).toEqual({})
    expect(parseArgs(undefined)).toEqual({})
    expect(parseArgs('[1,2]')).toEqual({})
  })
})

describe('mapLabel', () => {
  it('файл — последние два сегмента пути', () => {
    expect(mapLabel('read', { file_path: 'C:\\Users\\bot\\project\\src\\app.ts' })).toBe('src/app.ts')
  })

  it('шелл — имя команды и подкоманда, без флагов и путей', () => {
    expect(mapLabel('pwsh', { command: 'git status --short' })).toBe('git status')
    expect(mapLabel('pwsh', { command: 'cat src/app.ts' })).toBe('cat')
    expect(mapLabel('pwsh', { command: 'pnpm install 2>&1 | tail -20' })).toBe('pnpm install')
  })

  it('поиск — имя инструмента, не паттерн', () => {
    expect(mapLabel('grep', { pattern: 'SECRET_TOKEN' })).toBe('grep')
  })

  it('субагент — описание запуска', () => {
    expect(mapLabel('subagent', { description: 'count lines', prompt: 'секрет' })).toBe('count lines')
  })

  it('браузер — только хост', () => {
    expect(mapLabel('mcp__playwright__browser_navigate', { url: 'https://api.x.com/v1?token=abc' })).toBe('api.x.com')
  })

  it('неизвестный инструмент даёт имя, а не содержимое', () => {
    expect(mapLabel('weird_tool', { payload: 'данные' })).toBe('weird_tool')
  })

  it('обрезает управляющие символы', () => {
    expect(mapLabel('read', { file_path: 'a\u0000b.ts' })).toBe('ab.ts')
  })
})

describe('контекст', () => {
  it('usage без кэша: total минус output', () => {
    expect(contextFromUsage({ inputTokens: 33560, outputTokens: 177, totalTokens: 33737 }, 262144))
      .toEqual({ used: 33560, max: 262144, estimated: false })
  })

  it('usage с кэшем считает кэшированную часть контекста', () => {
    expect(contextFromUsage({ inputTokens: 163, outputTokens: 177, cacheReadTokens: 33557, totalTokens: 33897 }, 262144)?.used)
      .toBe(33720)
  })

  it('без размера окна измерять нечем', () => {
    expect(contextFromUsage({ totalTokens: 10, outputTokens: 1 }, 0)).toBeNull()
  })

  it('оценка по символам помечается как оценка', () => {
    expect(estimateContext(4000, 1000)).toEqual({ used: 1000, max: 1000, estimated: true })
    expect(estimateContext(0, 1000)).toBeNull()
  })
})

describe('EventMapper: карта записей харнеса', () => {
  it('session → session.start с id и cwd верхнего уровня', () => {
    const e = first(new EventMapper(), { type: 'session', id: 'session-abc', cwd: 'c:\\proj', time: 5 }) as Record<string, unknown>
    expect(e.t).toBe('session.start')
    expect(e.session).toBe('session-abc')
    expect(e.cwd).toBe('c:\\proj')
    expect(e.ts).toBe(5)
  })

  it('неизвестный тип не даёт событий и не бросает', () => {
    expect(new EventMapper().map(rec('future/plugin/event', { whatever: 1 }))).toEqual([])
  })

  it('turn/start + turn/end → answer с длительностью хода', () => {
    const mapper = new EventMapper()
    mapper.map(rec('turn/start', { turn: 1 }, { time: 1_000 }))
    const e = first(mapper, rec('turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 9_000 })) as AnswerEvent
    expect(e.t).toBe('answer')
    expect(e.ms).toBe(8_000)
    expect(e.status).toBe('ok')
  })

  it('turn/end с ошибкой и с отменой различаются', () => {
    const mapper = new EventMapper()
    mapper.map(rec('turn/start', { turn: 2 }))
    expect((first(mapper, rec('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'x' } } })) as AnswerEvent).status).toBe('err')
    mapper.map(rec('turn/start', { turn: 3 }))
    expect((first(mapper, rec('turn/end', { turn: 3, reason: { kind: 'aborted' } })) as AnswerEvent).status).toBe('aborted')
  })

  it('prompt — только реплика пользователя', () => {
    const mapper = new EventMapper()
    expect(mapper.map(rec('user/message', { content: [{ type: 'text', text: 'привет' }], source: { kind: 'user' } })).length).toBe(1)
    expect(mapper.map(rec('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'runtime-context' } })).length).toBe(0)
    expect(mapper.map(rec('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'time-context' } })).length).toBe(0)
    expect(mapper.map(rec('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'compact-checkpoint' } })).length).toBe(0)
  })

  it('prompt считает символы, не сохраняя текст', () => {
    const e = first(new EventMapper(), rec('user/message', { content: [{ type: 'text', text: '12345' }], source: { kind: 'user' } })) as Record<string, unknown>
    expect(e.chars).toBe(5)
    expect(JSON.stringify(e)).not.toContain('12345')
  })

  it('tool/call → tool.start со станцией и меткой', () => {
    const e = toolStartOf('read', { file_path: 'project/src/app.ts' })
    expect(e.station).toBe('files')
    expect(e.label).toBe('src/app.ts')
  })

  it('pwsh классифицируется по команде внутри', () => {
    expect(toolStartOf('pwsh', { command: 'git status' }).station).toBe('shell')
    expect(toolStartOf('pwsh', { command: 'curl https://api.x.com' }).station).toBe('web')
    expect(toolStartOf('pwsh', { command: 'cat src/app.ts' }).station).toBe('files')
  })

  it('tool/result → tool.end, закрытый по id, с меткой исходного вызова', () => {
    const mapper = new EventMapper()
    mapper.map(rec('tool/call', { callId: 'c1', name: 'read', arguments: '{"file_path":"src/a.ts"}', turn: 1, step: 1 }, { time: 1_000 }))
    const e = first(mapper, rec('tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false } }, { time: 1_400 })) as ToolEndEvent
    expect(e.id).toBe('c1')
    expect(e.status).toBe('ok')
    expect(e.ms).toBe(400)
    expect(e.station).toBe('files')
    expect(e.label).toBe('src/a.ts')
  })

  it('ошибочный результат даёт err', () => {
    const mapper = new EventMapper()
    mapper.map(rec('tool/call', { callId: 'c1', name: 'read', arguments: '{}', turn: 1, step: 1 }))
    const e = first(mapper, rec('tool/result', { message: { toolCallId: 'c1', isError: true } })) as ToolEndEvent
    expect(e.status).toBe('err')
  })

  it('результат без предшествующего вызова — статус unknown', () => {
    const e = first(new EventMapper(), rec('tool/result', { message: { toolCallId: 'lost', isError: false } })) as ToolEndEvent
    expect(e.status).toBe('unknown')
  })

  it('битый вызов не роняет маппер', () => {
    const e = first(new EventMapper(), rec('tool/call', { callId: 'c1', name: null, arguments: null }))
    expect(e).toBeUndefined()
  })

  it('step/start → model.step с известным контекстом', () => {
    const mapper = new EventMapper()
    mapper.map(rec('request/context', { provider: 'nvidia', model: 'm', contextWindow: 1000 }))
    mapper.map(rec('assistant/message', { usage: { inputTokens: 700, outputTokens: 10, totalTokens: 710 } }))
    const e = first(mapper, rec('step/start', { turn: 1, step: 2 })) as Record<string, unknown>
    expect(e.context).toEqual({ used: 700, max: 1000, estimated: false })
  })

  it('без usage контекст помечен оценкой', () => {
    const mapper = new EventMapper()
    mapper.map(rec('request/context', { contextWindow: 1000 }))
    mapper.map(rec('user/message', { content: [{ type: 'text', text: 'a'.repeat(400) }], source: { kind: 'user' } }))
    const e = first(mapper, rec('step/start', { turn: 1, step: 1 })) as Record<string, unknown>
    expect(e.context).toMatchObject({ estimated: true })
  })

  it('model/selection → model.switch с провайдером', () => {
    const mapper = new EventMapper()
    mapper.map(rec('model/selection', { provider: 'coarena', model: 'gpt-6-luna' }))
    const e = first(mapper, rec('model/selection', { provider: 'nvidia', model: 'deepseek-v4.1-flash' })) as ModelSwitchEvent
    expect(e.t).toBe('model.switch')
    expect(e.from).toBe('coarena/gpt-6-luna')
    expect(e.to).toBe('nvidia/deepseek-v4.1-flash')
  })

  it('та же модель повторно не переключает', () => {
    const mapper = new EventMapper()
    mapper.map(rec('model/selection', { provider: 'p', model: 'm' }))
    expect(mapper.map(rec('model/selection', { provider: 'p', model: 'm' }))).toEqual([])
  })

  it('compaction → событие модели', () => {
    const mapper = new EventMapper()
    expect((first(mapper, rec('compaction/start', { compactionId: 'k1', turn: 3 })) as Record<string, unknown>).t).toBe('model.step')
    mapper.map(rec('compaction/end', { compactionId: 'k1', usage: { totalTokens: 500, outputTokens: 100 } }))
    const e = first(mapper, rec('compaction/end', { compactionId: 'k1' })) as Record<string, unknown>
    expect(e.t).toBe('compaction')
    expect(e.phase).toBe('end')
  })

  it('job/registered и job/settled → фоновая работа', () => {
    const mapper = new EventMapper()
    const start = first(mapper, rec('job/registered', { jobId: 'j1', kind: 'pwsh', label: 'sleep 30', startedAt: 1_000, toolCall: { callId: 'c1' } }, { time: 1_000 })) as JobStartEvent
    expect(start.t).toBe('job.start')
    expect(start.station).toBe('shell')
    const end = first(mapper, rec('job/settled', { jobId: 'j1', kind: 'pwsh', label: 'sleep 30', startedAt: 1_000, finishedAt: 31_000, status: 'ok' }, { time: 31_000 })) as JobEndEvent
    expect(end.t).toBe('job.end')
    expect(end.ms).toBe(30_000)
    expect(end.status).toBe('ok')
  })

  it('провал фоновой задачи — err', () => {
    const mapper = new EventMapper()
    const end = first(mapper, rec('job/settled', { jobId: 'j2', kind: 'pwsh', startedAt: 1, finishedAt: 2, status: 'failed', cause: 'exit 1' })) as JobEndEvent
    expect(end.status).toBe('err')
  })

  it('closeDangling закрывает незакрытые вызовы концом хода', () => {
    const mapper = new EventMapper()
    mapper.map(rec('tool/call', { callId: 'c9', name: 'read', arguments: '{}', turn: 1, step: 1 }, { time: 1_000 }))
    const closed = mapper.closeDangling(70_000) as ToolEndEvent[]
    expect(closed[0].id).toBe('c9')
    expect(closed[0].status).toBe('unknown')
    expect(closed[0].ms).toBe(69_000)
    expect(mapper.closeDangling(70_000)).toEqual([])
  })

  it('новая сессия обнуляет состояние маппера', () => {
    const mapper = new EventMapper()
    mapper.map(rec('request/context', { contextWindow: 1000 }))
    mapper.map(rec('tool/call', { callId: 'c1', name: 'read', arguments: '{}' }))
    mapper.map({ type: 'session', id: 'new', cwd: '' })
    expect(mapper.currentContext()).toEqual({ used: 0, max: 0, estimated: true })
    expect(mapper.closeDangling(1)).toEqual([])
  })

  it('время события берётся из записи, а не из часов разбора', () => {
    const mapper = new EventMapper()
    mapper.map(rec('turn/start', { turn: 7 }, { time: 100 }))
    const e = first(mapper, rec('turn/end', { turn: 7, reason: { kind: 'completed' } }, { time: 123 })) as Record<string, unknown>
    expect(e.ts).toBe(123)
  })
})

describe('станции реальных инструментов харнеса', () => {
  // Разбор имён тулок покрыт test/classify.test.ts; здесь важно, что маппер
  // передаёт им станцию из классификатора, а не вычисляет её на своё место.
  const cases: Array<[string, string]> = [
    ['read', 'files'],
    ['todo_write', 'you'],
    ['subagent', 'agents'],
    ['skill', 'skills'],
    ['mcp__playwright__browser_navigate', 'browser'],
  ]

  for (const [name, station] of cases) {
    it(`tool/call ${name} → ${station}`, () => {
      expect(toolStartOf(name, {}).station).toBe(station)
    })
  }
})
