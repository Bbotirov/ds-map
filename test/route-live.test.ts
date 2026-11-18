import { describe, it, expect } from 'vitest'
import { EventMapper, type HarnessRecord } from '../src/core/route.js'
import { isContextUpdate, type DsMapEvent } from '../src/core/events.js'

/**
 * Фикстуры повторяют записи реальных session.v4.jsonl dsh 0.13.x — по профилю
 * типов из 126 живых сессий. Содержимое вымышленное, но формы полей настоящие:
 * `permission/preset` пишет имя пресета, `llm/retry` пишет текст ошибки целиком,
 * `session/title` пишет название, сложенное из переписки.
 */
function rec(type: string, data: Record<string, unknown> = {}, extra: Partial<HarnessRecord> = {}): HarnessRecord {
  return { type, seq: 1, time: 1_000, data, ...extra }
}

function first(mapper: EventMapper, record: HarnessRecord): DsMapEvent {
  return mapper.map(record)[0]
}

describe('реальные типы записей dsh', () => {
  it('turn/start даёт начало хода, а не молчание', () => {
    expect(first(new EventMapper(), rec('turn/start', { turn: 3 }))).toMatchObject({ t: 'turn.start', turn: 3 })
  })

  it('step/start + step/end = длительность размышления по времени записей', () => {
    const mapper = new EventMapper()
    mapper.map(rec('step/start', { turn: 1, step: 2 }, { time: 1_000 }))
    expect(first(mapper, rec('step/end', { turn: 1, step: 2 }, { time: 4_200 }))).toMatchObject({ t: 'model.think', ms: 3_200 })
  })

  it('step/end без пары не врёт о длительности', () => {
    expect(first(new EventMapper(), rec('step/end', { turn: 1, step: 7 }))).toMatchObject({ t: 'model.think', ms: 0 })
  })

  it('шаги разных ходов не путаются между собой', () => {
    const mapper = new EventMapper()
    mapper.map(rec('step/start', { turn: 1, step: 1 }, { time: 1_000 }))
    mapper.map(rec('step/start', { turn: 2, step: 1 }, { time: 2_000 }))
    expect(first(mapper, rec('step/end', { turn: 2, step: 1 }, { time: 2_500 }))).toMatchObject({ ms: 500 })
  })

  it('llm/retry → попытка модели без текста ошибки', () => {
    const evt = first(new EventMapper(), rec('llm/retry', {
      retryId: 'r1', turn: 1, step: 2, provider: 'nvidia', mode: 'retry',
      policyKey: 'k'.repeat(89), retry: 2, maxRetries: 5, delayMs: 483.5,
      failure: { message: 'HTTP 429 Too Many Requests: quota exceeded for sk-secret', code: 'rate_limit' },
    }))
    expect(evt).toMatchObject({ t: 'model.retry', attempt: 2, of: 5, delayMs: 484 })
    const wire = JSON.stringify(evt)
    expect(wire).not.toContain('429')
    expect(wire).not.toContain('sk-secret')
    expect(wire).not.toContain('rate_limit')
  })

  it('правила доступа светят станцию Хуки', () => {
    const mapper = new EventMapper()
    expect(first(mapper, rec('permission/preset', { preset: 'standard-with-sudo' }))).toMatchObject({ t: 'guard.set', kind: 'permission', label: 'standard-with-sudo' })
    expect(first(mapper, rec('sandbox/mode', { mode: 'workspace-write' }))).toMatchObject({ t: 'guard.set', kind: 'sandbox', label: 'workspace-write' })
    expect(first(mapper, rec('approval/policy', { policy: 'auto' }))).toMatchObject({ t: 'guard.set', kind: 'approval', label: 'auto' })
  })

  it('пересылка субагенту даёт только число сообщений', () => {
    const evt = first(new EventMapper(), rec('agent/inbox/spliced', {
      inserted: 2, removedCount: 1, start: 5, target: 'agent-7782',
    }))
    expect(evt).toMatchObject({ t: 'agent.msg', inserted: 2 })
    expect(JSON.stringify(evt)).not.toContain('agent-7782')
  })

  it('request/context и usage двигают кольцо контекста отдельным событием', () => {
    const mapper = new EventMapper()
    // Окно известно, а заполнять ещё нечего: кольцо обязано молчать, а не врать нулём.
    expect(mapper.map(rec('request/context', { provider: 'nvidia', model: 'glm-4.7', contextWindow: 128_000 }))).toEqual([])
    const answer = mapper.map(rec('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(40) }] },
      usage: { inputTokens: 3, outputTokens: 19, totalTokens: 15_651, cacheReadTokens: 15_629 },
    }))
    const update = answer.find(isContextUpdate)
    expect(update?.used).toBe(15_632)
  })

  it('тот же usage дважды не плодит событий контекста', () => {
    const mapper = new EventMapper()
    mapper.map(rec('request/context', { contextWindow: 128_000 }))
    const usage = { inputTokens: 3, outputTokens: 19, totalTokens: 15_651, cacheReadTokens: 15_629 }
    mapper.map(rec('assistant/message', { turn: 1, step: 1, message: { content: 'x' }, usage }))
    const again = mapper.map(rec('assistant/message', { turn: 1, step: 2, message: { content: 'y' }, usage }))
    expect(again.filter(isContextUpdate)).toHaveLength(0)
  })

  it('session/title не порождает событий: название сессии — это содержимое', () => {
    const events = new EventMapper().map(rec('session/title', {
      title: 'Заголовок сложен из переписки', source: { kind: 'llm' }, messageSeqs: [1, 2],
    }))
    expect(events).toEqual([])
  })

  it('session/title-llm-request с целыми сообщениями не порождает событий', () => {
    const events = new EventMapper().map(rec('session/title-llm-request', {
      maxTokens: 64, messages: [{ role: 'user', content: 'весь промпт целиком' }],
      route: 'title', system: 'system prompt', titleProvider: 'nvidia',
    }))
    expect(events).toEqual([])
  })

  it('session.start несёт только имя папки, не путь целиком', () => {
    const evt = first(new EventMapper(), rec('session', {}, {
      id: 's1', cwd: 'C:\\Users\\user\\Desktop\\work', createdAt: 1,
    }))
    expect(evt).toMatchObject({ t: 'session.start', cwd: 'work', session: 's1' })
  })

  it('ни одна сырая строка лога не уходит в UI', () => {
    const mapper = new EventMapper()
    const leaks = [
      'УДАЛИ-ВСЁ-ПОДРЯД',
      'HTTP 429 Too Many Requests',
      'Заголовок сложен из переписки',
      'C:\\Users\\user\\Desktop',
      'секретный текст промпта',
      'sk-proj-abc123',
    ]
    const records: HarnessRecord[] = [
      rec('session', {}, { id: 'C:\\Users\\user\\Desktop\\work', cwd: 'C:\\Users\\user\\Desktop\\work' }),
      rec('request/context', { provider: 'nvidia', model: 'glm-4.7', contextWindow: 128_000 }),
      rec('permission/preset', { preset: 'p'.repeat(300) }),
      rec('turn/start', { turn: 1 }),
      rec('user/message', { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'секретный текст промпта' }] }),
      rec('step/start', { turn: 1, step: 1 }),
      rec('tool/call', { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'УДАЛИ-ВСЁ-ПОДРЯД && не показывать' }), turn: 1, step: 1 }),
      rec('job/registered', { jobId: 'j1', kind: 'pwsh', label: 'УДАЛИ-ВСЁ-ПОДРЯД && не показывать', startedAt: 1, owner: 'C:\\Users\\user\\Desktop' }),
      rec('llm/retry', { retry: 1, maxRetries: 5, delayMs: 100, failure: { message: 'HTTP 429 Too Many Requests: quota exceeded', code: 'sk-proj-abc123' } }),
      rec('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'секретный текст промпта' }] }, usage: { totalTokens: 1_000, outputTokens: 100 } }),
      rec('session/title', { title: 'Заголовок сложен из переписки', source: { kind: 'llm' } }),
      rec('tool/result', { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'секретный текст промпта' }] } }),
      rec('job/settled', { jobId: 'j1', kind: 'pwsh', label: 'УДАЛИ-ВСЁ-ПОДРЯД', status: 'completed', startedAt: 1, finishedAt: 200, detail: 'секретный текст промпта' }),
      rec('step/end', { turn: 1, step: 1 }),
      rec('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'HTTP 429 Too Many Requests: quota exceeded', code: 'sk-proj-abc123' } } }),
    ]
    const all = records.flatMap((r) => mapper.map(r))
    expect(all.length).toBeGreaterThan(8)
    const wire = JSON.stringify(all)
    for (const secret of leaks) expect(wire).not.toContain(secret)
  })
})
