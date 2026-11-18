import { describe, it, expect } from 'vitest'
import { applyEvent, createModel, ingest, prune } from '../src/ui/renderer/app.js'
import {
  FLASH_MS, RETRY_MS,
  baseKey, contextSummary, drawBase, drawMap, structureKey, STATIONS, TRAIL_STOPS, type Setup, type State,
} from '../src/ui/renderer/map.js'
import { EventMapper, guardSet, type HarnessRecord } from '../src/core/route.js'

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
    expect(m.feed.render('ru')).toContain('ход с ошибкой')
    expect(m.feed.render('ru')).toContain('✕')
    expect(m.state.answerStatus).toBe('err')

    const aborted = createModel()
    applyEvent(aborted, { v: 1, t: 'answer', ts: T0, ms: 900, status: 'aborted' }, T0)
    expect(aborted.feed.render('ru')).toContain('ход прерван')
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
    expect(m.feed.getItems()[0]).toMatchObject({ status: 'active', key: 'phraseCompaction' })

    applyEvent(m, { v: 1, t: 'compaction', ts: T0 + 2_000, phase: 'end', ms: 2_000 }, T0 + 2_000)
    expect(m.state.active.has('model')).toBe(false)
    expect(m.feed.getItems()[0]).toMatchObject({ status: 'done', ms: 2_000 })
    expect(m.feed.render('ru')).toContain('сжатие контекста')
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
    expect(m.feed.render('ru')).toContain('ты написал · 214 симв.')
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

  describe('слой фраз', () => {
    /** Имена инструментов из реальных логов: в ленте они остаются подробностью. */
    it('вызов инструмента: фраза говорит род работы, метка — деталь', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'tool.start', ts: T0, id: 'c1', name: 'pwsh', station: 'shell', label: 'get-childitem' }, T0)
      expect(m.feed.render('ru')).toContain('запуск команды · get-childitem')
      applyEvent(m, { v: 1, t: 'tool.end', ts: T0 + 10, id: 'c1', status: 'ok', ms: 10 }, T0 + 10)

      applyEvent(m, { v: 1, t: 'tool.start', ts: T0 + 20, id: 'c2', name: 'skill', station: 'skills', label: 'using-superpowers' }, T0 + 20)
      expect(m.feed.render('ru')).toContain('вызов скилла · using-superpowers')
      applyEvent(m, { v: 1, t: 'tool.end', ts: T0 + 30, id: 'c2', status: 'ok', ms: 10 }, T0 + 30)

      applyEvent(m, { v: 1, t: 'tool.start', ts: T0 + 40, id: 'c3', name: 'grep', station: 'files', label: 'grep' }, T0 + 40)
      expect(m.feed.render('ru')).toContain('поиск по файлам')
      applyEvent(m, { v: 1, t: 'tool.end', ts: T0 + 50, id: 'c3', status: 'ok', ms: 10 }, T0 + 50)

      applyEvent(m, { v: 1, t: 'tool.start', ts: T0 + 60, id: 'c4', name: 'mcp__agent_bus__ask_model', station: 'agents', label: 'glm-4.7' }, T0 + 60)
      expect(m.feed.render('en')).toContain('agent call')
      expect(m.feed.render('en')).toContain('glm-4.7')
    })

    it('turn.start — «ход начат», ряд живёт до ответа', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'answer', ts: T0, ms: 100, status: 'err' }, T0)
      expect(m.state.alarms.size).toBe(0)
      applyEvent(m, { v: 1, t: 'tool.end', ts: T0 + 1, id: 'ghost', station: 'files', status: 'err' }, T0 + 1)
      expect(m.state.alarms.size).toBe(1)

      applyEvent(m, { v: 1, t: 'turn.start', ts: T0 + 2, turn: 3 }, T0 + 2)
      expect(m.state.alarms.size).toBe(0)
      expect(m.feed.getItems()[0]).toMatchObject({ station: 'you', status: 'active' })
      expect(m.feed.render('ru')).toContain('ход начат')
      expect(m.feed.render('en')).toContain('turn started')
      expect(m.feed.isRunning()).toBe(true)

      applyEvent(m, { v: 1, t: 'answer', ts: T0 + 3, ms: 900, status: 'ok' }, T0 + 3)
      expect(m.feed.render('ru')).toContain('ход завершён')
      expect(m.feed.isRunning()).toBe(false)
    })

    it('model.think — длительность шага в колонке времени', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'model.think', ts: T0, ms: 3_200 }, T0)
      expect(m.feed.getItems()[0]).toMatchObject({ station: 'model', key: 'phraseThink', ms: 3_200 })
      expect(m.feed.render('ru')).toContain('размышление')
      expect(m.feed.render('ru')).toContain('3.2s')
      expect(m.feed.render('en')).toContain('thinking')
    })

    it('model.step и context.update — ряды модели, сливающиеся в +N', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'model.step', ts: T0, context: { used: 18_400, max: 128_000, estimated: true } }, T0)
      applyEvent(m, { v: 1, t: 'model.step', ts: T0 + 1, context: { used: 18_400, max: 128_000, estimated: true } }, T0 + 1)
      expect(m.feed.getItems()[0]).toMatchObject({ station: 'model', count: 2 })
      expect(m.feed.render('ru')).toContain('шаг модели +2')

      applyEvent(m, { v: 1, t: 'context.update', ts: T0 + 2, used: 64_000, max: 128_000, estimated: false }, T0 + 2)
      expect(m.state.context).toEqual({ used: 64_000, max: 128_000, estimated: false })
      expect(m.feed.render('ru')).toContain('контекст')
      expect(m.feed.render('en')).toContain('context')
    })

    it('guard.set finally зажигает станцию hooks', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'guard.set', ts: T0, kind: 'permission', label: 'standard-with-sudo' }, T0)

      expect(m.state.flash.get('hooks')).toBe(T0)
      expect(m.feed.getItems()[0]).toMatchObject({ station: 'hooks', key: 'phraseGuardPermission', label: 'standard-with-sudo' })
      expect(m.feed.render('ru')).toContain('пресет разрешений · standard-with-sudo')
      expect(m.feed.render('en')).toContain('permission preset')
      // Вспышка видна на карте и гаснет по FLASH_MS.
      expect(drawMap(m.state, T0, m.setup)).toContain('stroke="#f0c595"')
      expect(drawMap(m.state, T0 + FLASH_MS + 1, m.setup)).not.toContain('stroke="#f0c595"')

      applyEvent(m, { v: 1, t: 'guard.set', ts: T0 + 1, kind: 'sandbox', label: 'workspace-write' }, T0 + 1)
      expect(m.feed.render('ru')).toContain('режим песочницы · workspace-write')
      applyEvent(m, { v: 1, t: 'guard.set', ts: T0 + 2, kind: 'approval', label: 'auto' }, T0 + 2)
      expect(m.feed.render('ru')).toContain('политика подтверждений · auto')
      applyEvent(m, { v: 1, t: 'guard.set', ts: T0 + 3, kind: 'unknown-kind', label: '' }, T0 + 3)
      expect(m.feed.render('ru')).toContain('правило доступа')
    })

    it('agent.msg — станция агентов и число вставленных писем', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'agent.msg', ts: T0, inserted: 2 }, T0)
      expect(m.state.flash.get('agents')).toBe(T0)
      expect(m.feed.render('ru')).toContain('входящее от агента · 2')
      expect(m.feed.render('en')).toContain('message from agent · 2')
    })

    it('model.retry — бейдж «повтор 2/5» на станции модели', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'model.retry', ts: T0, attempt: 2, of: 5, delayMs: 484 }, T0)

      expect(m.state.retry).toEqual({ attempt: 2, of: 5 })
      expect(m.feed.getItems()[0]).toMatchObject({ station: 'model', status: 'error', label: '2/5' })
      expect(m.feed.render('ru')).toContain('повтор запроса · 2/5')
      expect(m.feed.render('en')).toContain('retrying request · 2/5')
      expect(m.feed.render('ru')).toContain('✕')
      expect(drawMap(m.state, T0, m.setup)).toContain('повтор 2/5')

      m.setup.lang = 'en'
      expect(drawMap(m.state, T0, m.setup)).toContain('retry 2/5')
      m.setup.lang = 'ru'
      expect(drawMap(m.state, T0 + RETRY_MS + 1, m.setup)).not.toContain('повтор')
      prune(m.state, T0 + RETRY_MS + 1)
      expect(m.state.retry).toBe(null)
    })

    it('пауза перекрывает вход событий, панель остаётся на последнем кадре', () => {
      const m = createModel()
      expect(ingest(m, toolStart('a', 'files', 'a.ts'), T0)).toBe(true)
      const rev = m.feed.revision

      m.paused = true
      expect(ingest(m, toolEnd('a', 'ok', 100), T0 + 100)).toBe(false)
      expect(ingest(m, { v: 1, t: 'turn.start', ts: T0 + 200, turn: 2 }, T0 + 200)).toBe(false)
      expect(m.feed.revision).toBe(rev)
      expect(m.feed.getItems()[0].status).toBe('active')

      m.paused = false
      expect(ingest(m, { v: 1, t: 'prompt', ts: T0 + 300, chars: 12 }, T0 + 300)).toBe(true)
      expect(m.feed.revision).toBe(rev + 1)
    })

    it('счётчики станций: настройка меняет статику карты', () => {
      const m = createModel()
      applyEvent(m, toolStart('a', 'files', 'a.ts'), T0)
      applyEvent(m, toolStart('b', 'files', 'b.ts'), T0 + 1)

      m.setup.counters = true
      const on = drawBase(m.state, m.setup)
      expect(on).toContain('>2</text>')
      m.setup.counters = false
      const off = drawBase(m.state, m.setup)
      expect(off).not.toContain('>2</text>')
      expect(baseKey(m.state, m.setup)).not.toBe(baseKey(m.state, { ...m.setup, counters: true }))
      // Каркас от счётчиков не пересобирается: только статика.
      expect(structureKey(m.setup)).toBe(structureKey({ ...m.setup, counters: true }))
    })
  })

  describe('шапка', () => {
    it('контекст: `N% · Xk tok`, оценка с `~`, без данных — прочерк', () => {
      expect(contextSummary({ used: 12_900, max: 256_000, estimated: false }, 'ru')).toBe('5% · 12.9k ток')
      expect(contextSummary({ used: 12_900, max: 256_000, estimated: false }, 'en')).toBe('5% · 12.9k tok')
      expect(contextSummary({ used: 6_200, max: 128_000, estimated: true }, 'ru')).toBe('~5% · 6.2k ток')
      expect(contextSummary(null, 'ru')).toBe('—')
      expect(contextSummary({ used: 0, max: 0, estimated: true }, 'ru')).toBe('—')
      expect(contextSummary({ used: 900, max: 1_000, estimated: false }, 'ru')).toBe('90% · 900 ток')
    })

    it('модель и папка сессии приходят из событий', () => {
      const m = createModel()
      applyEvent(m, { v: 1, t: 'session.start', ts: T0, session: 's_1', model: 'glm-4.7', cwd: 'ds-map' }, T0)
      expect(m.modelName).toBe('glm-4.7')
      expect(m.sessionDir).toBe('ds-map')
      applyEvent(m, { v: 1, t: 'model.switch', ts: T0 + 1, from: 'glm-4.7', to: 'fable 5.2' }, T0 + 1)
      expect(m.modelName).toBe('fable 5.2')
      expect(m.feed.render('ru')).toContain('смена модели · glm-4.7 → fable 5.2')
      expect(m.feed.render('en')).toContain('model switch')
    })
  })

  describe('приватность напечатанного', () => {
    it('в разметке ленты нет длинных сырых строк из записей харнеса', () => {
      const mapper = new EventMapper()
      const preset = 'p'.repeat(300)
      const policyKey = 'k'.repeat(89)
      const records: HarnessRecord[] = [
        { type: 'session', seq: 1, time: T0, id: 's_1', cwd: 'C:\\Users\\bot\\Desktop\\fun proj\\ds-map' },
        { type: 'permission/preset', seq: 2, time: T0 + 1, data: { turn: 1, preset } },
        {
          type: 'llm/retry', seq: 3, time: T0 + 2,
          data: { retryId: 'r1', turn: 1, step: 1, provider: 'nvidia', mode: 'retry', policyKey, retry: 2, maxRetries: 5, delayMs: 483.5, transient: true, failure: { message: `${'HTTP 429 '.repeat(40)}`, code: 'sk-proj-abc123' } },
        },
        { type: 'tool/call', seq: 4, time: T0 + 3, data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: `echo ${'x'.repeat(300)}` }), turn: 1, step: 1 } },
        { type: 'agent/inbox/spliced', seq: 5, time: T0 + 4, data: { letterId: 'l1', recipient: 'a1', inserted: 2, queue: `${'секрет'.repeat(40)}` } },
      ]
      const m = createModel()
      for (const rec of records) {
        for (const evt of mapper.map(rec)) applyEvent(m, evt, T0)
      }

      const html = m.feed.render('ru')
      const leaks = [preset, 'x'.repeat(300), 'HTTP 429', 'sk-proj-abc123', policyKey, 'C:\\Users', 'секрет']
      for (const leak of leaks) expect(html).not.toContain(leak)
      // Ни один напечатанный ряд не длиннее потолка имён: `clean()` своё сделал.
      for (const item of m.feed.getItems()) expect(item.label.length).toBeLessThanOrEqual(48)
      expect(html).toContain('пресет разрешений · ')
      expect(html).toContain('повтор запроса · 2/5')
      expect(m.state.flash.get('hooks')).toBe(T0)
      expect(m.state.retry).toEqual({ attempt: 2, of: 5 })
    })

    it('метка guard.set проходит clean() ещё в маппере', () => {
      const evt = guardSet('permission', 'p'.repeat(300), T0)
      expect(evt.label).toHaveLength(48)
    })
  })
})
