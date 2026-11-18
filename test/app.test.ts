import { describe, it, expect } from 'vitest'
import { applyEvent, createModel, prune } from '../src/ui/renderer/app.js'
import { baseKey, structureKey, STATIONS, TRAIL_STOPS, type Setup, type State } from '../src/ui/renderer/map.js'

const T0 = 100_000

function toolStart(id: string, station: string, label: string) {
  return { v: 1, t: 'tool.start', ts: T0, id, name: 'read', station, label }
}

function toolEnd(id: string, status: string, ms = 400) {
  // Как в старой схеме маршрутизатора: id + статус + длительность, без станции.
  return { v: 1, t: 'tool.end', ts: T0 + ms, id, status, ms }
}

describe('applyEvent', () => {
  it('tool.start оживляет станцию, пульс, маршрут и строку ленты', () => {
    const m = createModel()
    applyEvent(m, toolStart('call_1', 'files', 'src/app.ts'), T0)

    expect(m.state.active.get('files')).toMatchObject({ startedAt: T0, count: 1, background: false })
    expect(m.state.pulses).toEqual([{ station: 'files', dir: 'out', startedAt: T0, status: 'ok' }])
    expect(m.state.stationCounts.get('files')).toBe(1)
    expect(m.state.trail).toEqual([{ station: 'files', ts: T0 }])
    expect(m.feed.getItems()[0]).toMatchObject({ id: 'call_1', station: 'files', status: 'active' })
  })

  it('tool.end гасит ● в · по id и оставляет метку из tool.start', () => {
    const m = createModel()
    applyEvent(m, toolStart('call_1', 'files', 'src/app.ts'), T0)
    applyEvent(m, toolEnd('call_1', 'ok', 400), T0 + 400)

    const item = m.feed.getItems()[0]
    expect(item.status).toBe('done')
    expect(item.label).toBe('src/app.ts')
    expect(item.ms).toBe(400)
    expect(m.feed.render('ru')).toContain('0.4s')
    expect(m.state.active.has('files')).toBe(false)
    expect(m.state.pulses.map((p) => p.dir)).toEqual(['out', 'back'])
  })

  it('параллельные вызовы разных станций закрываются каждый своим концом', () => {
    const m = createModel()
    applyEvent(m, toolStart('call_1', 'files', 'src/app.ts'), T0)
    applyEvent(m, toolStart('call_2', 'shell', 'npm test'), T0 + 1)
    applyEvent(m, toolEnd('call_2', 'ok', 900), T0 + 901)

    const rows = m.feed.getItems()
    expect(rows.find((r) => r.id === 'call_2')?.status).toBe('done')
    expect(rows.find((r) => r.id === 'call_1')?.status).toBe('active')
    expect(m.state.active.get('files')?.count).toBe(1)
    expect(m.state.active.has('shell')).toBe(false)
  })

  it('ошибка даёт красную строку и красную точку станции, до следующего запроса', () => {
    const m = createModel()
    applyEvent(m, toolStart('call_1', 'shell', 'npm test'), T0)
    applyEvent(m, toolEnd('call_1', 'err', 12_300), T0 + 12_300)

    expect(m.feed.getItems()[0].status).toBe('error')
    expect(m.feed.render('ru')).toContain('✕')
    expect(m.state.alarms.get('shell')).toBe(T0 + 12_300)

    applyEvent(m, { v: 1, t: 'prompt', ts: T0 + 20_000, chars: 214 }, T0 + 20_000)
    expect(m.state.alarms.size).toBe(0)
  })

  it('конец без начала всё равно попадает в ленту', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'tool.end', ts: T0, id: 'call_ghost', station: 'web', label: 'example.com', status: 'ok', ms: 250 }, T0)
    const item = m.feed.getItems()[0]
    expect(item.status).toBe('done')
    expect(item.ms).toBe(250)
    expect(item.station).toBe('web')
  })

  it('answer гасит незакрытые вызовы, но оставляет фоновую работу', () => {
    const m = createModel()
    applyEvent(m, toolStart('call_1', 'files', 'src/app.ts'), T0)
    applyEvent(m, { v: 1, t: 'job.start', ts: T0, id: 'job_1', station: 'shell', label: 'make -j8' }, T0)
    applyEvent(m, { v: 1, t: 'answer', ts: T0 + 5_000, ms: 5_000, status: 'ok' }, T0 + 5_000)

    expect(m.feed.getItems().find((r) => r.id === 'call_1')?.status).toBe('done')
    expect(m.feed.getItems().find((r) => r.id === 'job_1')?.status).toBe('active')
    expect(m.state.active.get('shell')?.background).toBe(true)
    expect(m.state.active.has('files')).toBe(false)
    expect(m.state.answerAt).toBe(T0 + 5_000)
    expect(m.state.answerStatus).toBe('ok')
    expect(m.open.size).toBe(1)
  })

  it('ответ с ошибкой и прерванный ответ различимы в ленте', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'answer', ts: T0, ms: 900, status: 'err' }, T0)
    expect(m.feed.render('ru')).toContain('Ответ с ошибкой')
    expect(m.feed.render('ru')).toContain('✕')
    expect(m.state.answerStatus).toBe('err')

    const aborted = createModel()
    applyEvent(aborted, { v: 1, t: 'answer', ts: T0, ms: 900, status: 'aborted' }, T0)
    expect(aborted.feed.render('ru')).toContain('Ответ прерван')
  })

  it('model.switch: ◆ в ленте и подсветка станции model на SWITCH_MS', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'model.switch', ts: T0, from: 'opus 5.5', to: 'fable 5.2' }, T0)

    expect(m.state.switchAt).toBe(T0)
    const item = m.feed.getItems()[0]
    expect(item.status).toBe('switch')
    expect(item.label).toBe('opus 5.5 → fable 5.2')
    expect(m.feed.render('ru')).toContain('◆')
  })

  it('job.end закрывает фоновую работу, провал — красная точка', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'job.start', ts: T0, id: 'job_1', station: 'agents', label: 'subagent: search' }, T0)
    expect(m.state.active.get('agents')?.background).toBe(true)
    expect(m.feed.isRunning()).toBe(true)

    applyEvent(m, { v: 1, t: 'job.end', ts: T0 + 9_000, id: 'job_1', station: 'agents', status: 'err', ms: 9_000 }, T0 + 9_000)
    expect(m.state.active.has('agents')).toBe(false)
    expect(m.state.alarms.get('agents')).toBe(T0 + 9_000)
    expect(m.feed.getItems()[0]).toMatchObject({ status: 'error', ms: 9_000 })
    expect(m.feed.isRunning()).toBe(false)
  })

  it('compaction — это работа модели: станция горит, ряд закрывается с длительностью', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'compaction', ts: T0, phase: 'start', ms: 0 }, T0)
    expect(m.state.active.get('model')?.count).toBe(1)
    expect(m.feed.getItems()[0]).toMatchObject({ status: 'active', key: 'compactionLabel' })

    applyEvent(m, { v: 1, t: 'compaction', ts: T0 + 2_000, phase: 'end', ms: 2_000 }, T0 + 2_000)
    expect(m.state.active.has('model')).toBe(false)
    expect(m.feed.getItems()[0]).toMatchObject({ status: 'done', ms: 2_000 })
    expect(m.feed.render('ru')).toContain('Уплотнение контекста')
    expect(m.openCompaction).toBe(null)
  })

  it('контекст читается с estimated, иначе кольцо считается точным', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'model.step', ts: T0, context: { used: 18_400, max: 128_000, estimated: true } }, T0)
    expect(m.state.context).toEqual({ used: 18_400, max: 128_000, estimated: true })

    applyEvent(m, { v: 1, t: 'context.update', ts: T0, used: 64_000, max: 128_000 }, T0)
    expect(m.state.context).toEqual({ used: 64_000, max: 128_000, estimated: false })

    applyEvent(m, { v: 1, t: 'model.step', ts: T0, context: null }, T0)
    expect(m.state.context).toEqual({ used: 64_000, max: 128_000, estimated: false })
  })

  it('session.start чистит прошлый ход, но ленту хранит', () => {
    const m = createModel()
    applyEvent(m, toolStart('call_1', 'files', 'src/app.ts'), T0)
    applyEvent(m, { v: 1, t: 'prompt', ts: T0, chars: 10 }, T0)
    m.state.alarms.set('files', T0)
    applyEvent(m, { v: 1, t: 'session.start', ts: T0 + 1, session: 's_2', model: 'fable 5.2', cwd: 'C:/x' }, T0 + 1)

    expect(m.state.alarms.size).toBe(0)
    expect(m.state.active.size).toBe(0)
    expect(m.state.trail).toEqual([{ station: 'you', ts: T0 + 1 }])
    expect(m.state.context).toBe(null)
    expect(m.open.size).toBe(0)
    expect(m.feed.getItems().length).toBe(3)
  })

  it('просьба пользователя рисует вас и волну от центра', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'prompt', ts: T0, chars: 214 }, T0)
    expect(m.state.rippleAt).toBe(T0)
    expect(m.state.trail).toEqual([{ station: 'you', ts: T0 }])
    expect(m.feed.render('ru')).toContain('Запрос · 214 симв.')
  })

  it('маршрут: model не участвует, повтор подряд — одна нога, память — 7 станций', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'model.step', ts: T0, context: { used: 1, max: 2, estimated: false } }, T0)
    expect(m.state.trail).toHaveLength(0)

    applyEvent(m, toolStart('a', 'files', 'a.ts'), T0)
    applyEvent(m, toolStart('b', 'files', 'b.ts'), T0 + 1)
    expect(m.state.trail).toHaveLength(1)

    const others = STATIONS.filter((s) => s !== 'model' && s !== 'files')
    others.forEach((station, i) => {
      applyEvent(m, toolStart(`x${i}`, station, `${station} label`), T0 + 10 + i)
    })
    expect(m.state.trail).toHaveLength(TRAIL_STOPS)
    expect(m.state.trail[m.state.trail.length - 1].station).toBe(others[others.length - 1])
  })

  it('неизвестное событие и станция вне списка молча игнорируются', () => {
    const m = createModel()
    applyEvent(m, { v: 1, t: 'future.event', ts: T0 }, T0)
    applyEvent(m, { v: 1, t: 'tool.start', ts: T0, id: 'q', station: 'quantum', label: 'x' }, T0)
    expect(m.feed.getItems()).toHaveLength(0)
    expect(m.state.active.size).toBe(0)
    expect(m.state.pulses).toHaveLength(0)
  })

  it('мусор в канале не роняет панель', () => {
    const m = createModel()
    for (const bad of [null, undefined, 42, 'tool.start', [], {}, { t: 5 }, { t: 'answer' }]) {
      expect(() => applyEvent(m, bad, T0)).not.toThrow()
    }
    // {t:'answer'} без полей — это валидный ход без статусов: ровно один ряд.
    expect(m.feed.getItems()).toHaveLength(1)
  })

  it('счётчики станций пересобирают статику карты, а каркас — нет', () => {
    const m = createModel()
    const setup = m.setup as Setup
    const state = m.state as State
    const before = baseKey(state, setup)
    const frame = structureKey(setup)

    applyEvent(m, toolStart('a', 'files', 'a.ts'), T0)
    expect(baseKey(state, setup)).not.toBe(before)
    expect(structureKey(setup)).toBe(frame)
  })

  it('prune срезает догоревшие пульсы и ноги маршрута', () => {
    const m = createModel()
    applyEvent(m, toolStart('a', 'files', 'a.ts'), T0)
    prune(m.state, T0 + 900)
    expect(m.state.pulses).toHaveLength(0)

    prune(m.state, T0 + 70_000)
    expect(m.state.trail).toHaveLength(0)
  })

  it('язык модели влияет только на печать ленты, не на состояние', () => {
    const ru = createModel('ru')
    const en = createModel('en')
    for (const m of [ru, en]) applyEvent(m, toolStart('a', 'browser', 'example.com'), T0)
    expect(ru.feed.render('ru')).toContain('Браузер')
    expect(en.feed.render('en')).toContain('Browser')
    expect(en.feed.render('en')).toContain('●')
  })
})
