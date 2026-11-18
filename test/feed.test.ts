import { describe, it, expect } from 'vitest'
import { Feed, DETAIL_CHARS, MAX_ITEMS, TRUNCATE_CHARS, formatMs, statusOf } from '../src/ui/renderer/feed.js'
import type { FeedEntry } from '../src/ui/renderer/feed.js'

const LONG_LABEL = 'src/ui/renderer/some-deeply-nested-module-name.ts'
const NOW = 10_000

function openCall(id: string, station: FeedEntry['station'], label = 'a.ts', ts = NOW): Feed {
  const feed = new Feed()
  feed.add({ id, station, label, status: 'active', mergeable: true, ts })
  return feed
}

describe('Feed', () => {
  it('кладёт самый свежий ряд сверху', () => {
    const f = new Feed()
    f.add({ id: 'c1', station: 'files', label: 'a.ts', status: 'active', ts: 1 })
    f.add({ id: 'c2', station: 'shell', label: 'ls', status: 'active', ts: 2 })
    const items = f.getItems()
    expect(items.map((i) => i.id)).toEqual(['c2', 'c1'])
  })

  it('гасит ● в · по id вызова и ставит длительность', () => {
    const f = openCall('call_1', 'files')
    expect(f.complete('call_1', 'ok', 400)).toBe(true)
    const item = f.getItems()[0]
    expect(item.status).toBe('done')
    expect(item.ms).toBe(400)
    const html = f.render('ru')
    expect(html).toContain('·')
    expect(html).not.toContain('●')
    expect(html).toContain('0.4s')
  })

  it('провал вызова даёт ✕, а не ·', () => {
    const f = openCall('call_1', 'shell', 'npm test')
    f.complete('call_1', 'err', 12_300)
    expect(f.getItems()[0].status).toBe('error')
    expect(f.render('ru')).toContain('✕')
    expect(f.render('ru')).toContain('12.3s')
  })

  it('неизвестный статус — · без длительности, прочерк в колонке времени', () => {
    const f = openCall('call_1', 'files')
    f.complete('call_1', 'unknown')
    expect(f.getItems()[0].status).toBe('done')
    expect(f.render('ru')).toContain('—')
  })

  it('complete по неизвестному id ничего не выдумывает', () => {
    const f = openCall('call_1', 'files')
    expect(f.complete('call_9', 'ok', 10)).toBe(false)
    expect(f.getItems()[0].status).toBe('active')
  })

  it('повтор id закрытого ряда не оживляет прошлую строку', () => {
    const f = openCall('compaction', 'model', '', NOW)
    f.complete('compaction', 'ok', 100)
    f.add({ id: 'compaction', station: 'model', key: 'phraseCompaction', status: 'active', ts: NOW + 1 })
    expect(f.getItems()).toHaveLength(2)
    expect(f.getItems()[0].status).toBe('active')
    expect(f.getItems()[1].status).toBe('done')
  })

  it('активный ряд перезапускается на месте', () => {
    const f = openCall('call_1', 'files', 'a.ts')
    f.add({ id: 'call_1', station: 'files', label: 'b.ts', status: 'active', mergeable: true, ts: NOW + 5 })
    expect(f.getItems()).toHaveLength(1)
    expect(f.getItems()[0].label).toBe('b.ts')
  })

  it('подряд идущие завершённые вызовы одной станции сворачиваются в +2', () => {
    const f = new Feed()
    f.add({ id: 'a', station: 'files', label: 'a.ts', status: 'active', mergeable: true, ts: 1 })
    f.complete('a', 'ok', 100)
    f.add({ id: 'b', station: 'files', label: 'b.ts', status: 'active', mergeable: true, ts: 2 })
    f.complete('b', 'ok', 200)
    const items = f.getItems()
    expect(items).toHaveLength(1)
    expect(items[0].count).toBe(2)
    expect(f.render('ru')).toContain('+2')
  })

  it('слияние работает и когда ряды приходят уже готовыми', () => {
    const f = new Feed()
    f.add({ id: 'a', station: 'shell', label: 'ls', status: 'done', mergeable: true, ts: 1 })
    f.add({ id: 'b', station: 'shell', label: 'pwd', status: 'done', mergeable: true, ts: 2 })
    expect(f.getItems()).toHaveLength(1)
    expect(f.getItems()[0].count).toBe(2)
  })

  it('чужая станция между рядами мешает сворачиванию', () => {
    const f = new Feed()
    f.add({ id: 'a', station: 'files', label: 'a.ts', status: 'done', mergeable: true, ts: 1 })
    f.add({ id: 'b', station: 'shell', label: 'ls', status: 'done', mergeable: true, ts: 2 })
    f.add({ id: 'c', station: 'files', label: 'c.ts', status: 'done', mergeable: true, ts: 3 })
    expect(f.getItems()).toHaveLength(3)
  })

  it('служебные ряды не сворачиваются, даже у одной станции', () => {
    const f = new Feed()
    f.add({ station: 'you', key: 'sessionLabel', status: 'done', ts: 1 })
    f.add({ station: 'you', key: 'phrasePrompt', vars: { n: 12 }, status: 'done', ts: 2 })
    expect(f.getItems()).toHaveLength(2)
  })

  it('settle гаснит незакрытые вызовы, фоновая работа ждёт отчёт', () => {
    const f = new Feed()
    f.add({ id: 'a', station: 'files', label: 'a.ts', status: 'active', mergeable: true, ts: 1 })
    f.add({ id: 'j', station: 'shell', label: 'make', status: 'active', background: true, ts: 1 })
    expect(f.settle()).toBe(1)
    expect(f.getItems().find((i) => i.id === 'a')?.status).toBe('done')
    expect(f.getItems().find((i) => i.id === 'j')?.status).toBe('active')
    expect(f.isRunning()).toBe(true)
  })

  it('держит 16 рядов', () => {
    const f = new Feed()
    for (let i = 0; i < MAX_ITEMS + 6; i++) {
      f.add({ id: `c${i}`, station: 'files', label: `f${i}.ts`, status: 'active', ts: i })
    }
    expect(f.getItems()).toHaveLength(MAX_ITEMS)
  })

  describe('колонка времени', () => {
    it('форматирует длительность как в §11', () => {
      expect(formatMs(400)).toBe('0.4s')
      expect(formatMs(12_300)).toBe('12.3s')
      expect(formatMs(0)).toBe('0.0s')
    })

    it('прочерк для мгновенных событий', () => {
      expect(formatMs(undefined)).toBe('—')
      expect(formatMs(Number.NaN)).toBe('—')
      expect(formatMs(-5)).toBe('—')
    })

    it('не превращает длительность в метку', () => {
      const f = openCall('a', 'files', 'a.ts')
      f.complete('a', 'ok', 400)
      const html = f.render('ru')
      expect(html).toContain('<span class="time">0.4s</span>')
      expect(html).toContain('a.ts')
    })
  })

  it('◆ — строка смены модели, метку не переводим', () => {
    const f = new Feed()
    f.add({ id: 'sw', station: 'model', label: 'opus 5.5 → fable 5.2', status: 'switch', ts: 1 })
    const html = f.render('ru')
    expect(html).toContain('◆')
    expect(html).toContain('opus 5.5 → fable 5.2')
    expect(html).toContain('Модель')
  })

  it('statusOf отражает ToolStatus', () => {
    expect(statusOf('ok')).toBe('done')
    expect(statusOf('err')).toBe('error')
    expect(statusOf('unknown')).toBe('done')
  })

  describe('▸', () => {
    it('обрезает длинную метку и даёт кнопку раскрытия', () => {
      expect(LONG_LABEL.length).toBeGreaterThan(TRUNCATE_CHARS)
      const f = openCall('a', 'files', LONG_LABEL)
      const html = f.render('ru')
      expect(html).toContain('data-toggle="a"')
      expect(html).toContain('aria-expanded="false"')
      expect(html).toContain('Развернуть строку')
      // Подробность не длиннее потолка имён: сырой строки в DOM не будет.
      const capped = LONG_LABEL.slice(0, DETAIL_CHARS - 1) + '…'
      expect(capped.length).toBe(DETAIL_CHARS)
      expect(html).toContain('title="' + capped + '"')
      expect(html).not.toContain(LONG_LABEL)
    })

    it('короткую метку раскрывать не нужно', () => {
      const f = openCall('a', 'files', 'ls')
      expect(f.render('ru')).not.toContain('data-toggle')
      expect(f.toggle('a', 'ru')).toBe(false)
    })

    it('раскрыта всегда одна строка за раз', () => {
      const f = new Feed()
      f.add({ id: 'a', station: 'files', label: LONG_LABEL, status: 'active', ts: 1 })
      f.add({ id: 'b', station: 'files', label: LONG_LABEL + 'bbbb', status: 'active', ts: 2 })
      expect(f.toggle('a', 'ru')).toBe(true)
      expect(f.render('ru')).toContain('aria-expanded="true"')
      expect(f.render('ru')).toContain('Свернуть строку')
      f.toggle('b', 'ru')
      expect(f.getItems().find((i) => i.id === 'a')?.collapsed).toBe(true)
      expect(f.getItems().find((i) => i.id === 'b')?.collapsed).toBe(false)
      f.toggle('b', 'ru')
      expect(f.getItems().find((i) => i.id === 'b')?.collapsed).toBe(true)
    })

    it('раскрытый ряд не теряет состояние при сворачивании соседа', () => {
      const f = new Feed()
      f.add({ id: 'a', station: 'files', label: LONG_LABEL + 'aaa', status: 'active', mergeable: true, ts: 1 })
      f.toggle('a', 'ru')
      f.complete('a', 'ok', 10)
      f.add({ id: 'b', station: 'files', label: LONG_LABEL + 'bbb', status: 'active', mergeable: true, ts: 2 })
      f.complete('b', 'ok', 20)
      expect(f.getItems()).toHaveLength(1)
      expect(f.getItems()[0].collapsed).toBe(false)
    })
  })

  describe('строка «что идёт сейчас»', () => {
    it('в простое честно говорит, что ничего не идёт', () => {
      const f = new Feed()
      f.add({ id: 'a', station: 'files', label: 'a.ts', status: 'active', mergeable: true, ts: 1 })
      f.complete('a', 'ok', 10)
      const html = f.renderNow('ru', 5_000)
      expect(html).toContain('Сейчас')
      expect(html).toContain('Нет активной работы')
      expect(html).not.toContain('is-running')
    })

    it('показывает самое давнее незакрытое и сколько ещё ждёт', () => {
      const f = new Feed()
      f.add({ id: 'a', station: 'files', label: 'read src/app.ts', status: 'active', ts: 1_000 })
      f.add({ id: 'b', station: 'shell', label: 'npm test', status: 'active', ts: 2_000 })
      const html = f.renderNow('ru', 4_500)
      expect(html).toContain('is-running')
      expect(html).toContain('read src/app.ts')
      expect(html).toContain('+1')
      expect(html).toContain('3.5s')
    })

    it('в en строка «сейчас» тоже на английском', () => {
      const f = new Feed()
      expect(f.renderNow('en', 1)).toContain('Nothing running')
      expect(f.renderNow('en', 1)).toContain('Now')
    })
  })

  it('переводит служебные ряды при смене языка', () => {
    const f = new Feed()
    f.add({ station: 'you', key: 'phrasePrompt', vars: { n: 214 }, status: 'done', ts: 1 })
    expect(f.render('ru')).toContain('ты написал · 214 симв.')
    expect(f.render('en')).toContain('you wrote · 214 chars')
    expect(f.render('en')).toContain('You')
  })

  describe('слой фраз', () => {
    it('фраза стоит на месте метки, метка — подробностью справа', () => {
      const f = new Feed()
      f.add({ id: 'a', station: 'files', key: 'phraseReadFile', label: 'src/app.ts', status: 'done', mergeable: true, ts: 1 })
      expect(f.render('ru')).toContain('чтение файла · src/app.ts')
      expect(f.render('en')).toContain('reading a file · src/app.ts')
      // Пять колонок — контракт с сеткой index.html: фраза не добавляет span.
      expect(f.render('ru').match(/<span|<button/g)?.length).toBe(5)
    })

    it('ряд без подробности — одна фраза', () => {
      const f = new Feed()
      f.add({ station: 'model', key: 'phraseThink', status: 'done', ms: 3_200, ts: 1 })
      const html = f.render('ru')
      expect(html).toContain('<span class="label" title="размышление">размышление</span>')
      expect(html).toContain('3.2s')
      expect(f.render('en')).toContain('thinking')
    })

    it('новые типы событий читаются фразами в обоих языках', () => {
      const f = new Feed()
      f.add({ station: 'you', key: 'phraseTurnStart', status: 'active', ts: 1 })
      f.add({ station: 'model', key: 'phraseStep', status: 'done', mergeable: true, ts: 2 })
      f.add({ station: 'model', key: 'phraseThink', status: 'done', ms: 1_500, ts: 3 })
      f.add({ station: 'model', key: 'phraseRetry', label: '2/5', status: 'error', ts: 4 })
      f.add({ station: 'hooks', key: 'phraseGuardPermission', label: 'standard', status: 'done', ts: 5 })
      f.add({ station: 'agents', key: 'phraseAgentMsg', vars: { n: 2 }, status: 'done', ts: 6 })
      f.add({ station: 'model', key: 'phraseContext', status: 'done', mergeable: true, ts: 7 })
      const ru = f.render('ru')
      const en = f.render('en')
      for (const phrase of ['ход начат', 'шаг модели', 'размышление', 'повтор запроса · 2/5', 'пресет разрешений · standard', 'входящее от агента · 2', 'контекст']) {
        expect(ru).toContain(phrase)
      }
      for (const phrase of ['turn started', 'model step', 'thinking', 'retrying request · 2/5', 'permission preset · standard', 'message from agent · 2', 'context']) {
        expect(en).toContain(phrase)
      }
      // Ключи i18n не протекают в разметку: `t` отдаёт их дословно при промахе.
      for (const key of ['phraseTurnStart', 'phraseStep', 'phraseRetry', 'phraseGuardPermission', 'phraseAgentMsg']) {
        expect(ru).not.toContain(key)
        expect(en).not.toContain(key)
      }
    })

    it('фразы с подстановками не оставляют `{n}` в разметке', () => {
      const f = new Feed()
      f.add({ station: 'agents', key: 'phraseAgentMsg', vars: { n: 3 }, status: 'done', ts: 1 })
      expect(f.render('ru')).toContain('входящее от агента · 3')
      expect(f.render('ru')).not.toContain('{n}')
    })

    it('разные рода работ одной станции не сливаются', () => {
      const f = new Feed()
      f.add({ id: 'a', station: 'files', key: 'phraseReadFile', label: 'a.ts', status: 'done', mergeable: true, ts: 1 })
      f.add({ id: 'b', station: 'files', key: 'phraseSearchText', label: 'grep', status: 'done', mergeable: true, ts: 2 })
      expect(f.getItems()).toHaveLength(2)
    })

    it('одинаковые ряды модели сливаются в +N', () => {
      const f = new Feed()
      f.add({ id: 'a', station: 'model', key: 'phraseStep', status: 'done', mergeable: true, ts: 1 })
      f.add({ id: 'b', station: 'model', key: 'phraseStep', status: 'done', mergeable: true, ts: 2 })
      f.add({ id: 'c', station: 'model', key: 'phraseStep', status: 'done', mergeable: true, ts: 3 })
      expect(f.getItems()).toHaveLength(1)
      expect(f.getItems()[0].count).toBe(3)
      expect(f.render('ru')).toContain('шаг модели +3')
    })
  })

  it('экранирует метку: события идут из внешнего источника', () => {
    const f = openCall('a', 'shell', '<img src=x onerror=alert(1)>')
    const html = f.render('ru')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('пустая лента — одна заглушка', () => {
    const f = new Feed()
    expect(f.render('ru')).toContain('Нет событий')
    expect(f.render('en')).toContain('No events')
  })

  it('revision двигается только когда меняются данные ленты', () => {
    const f = openCall('a', 'files', 'a.ts')
    const afterAdd = f.revision
    f.render('ru')
    f.render('en')
    f.renderNow('ru', 5_000)
    expect(f.revision).toBe(afterAdd)
    expect(f.complete('a', 'ok', 10)).toBe(true)
    expect(f.revision).toBe(afterAdd + 1)
    expect(f.complete('нет-такого', 'ok', 1)).toBe(false)
    expect(f.revision).toBe(afterAdd + 1)
    f.add({ id: 'b', station: 'shell', label: 'ls', status: 'active', ts: 2 })
    expect(f.settle()).toBe(1)
    const afterSettle = f.revision
    expect(f.settle()).toBe(0)
    expect(f.revision).toBe(afterSettle)
  })

  // Порядок колонок — контракт с сеткой в index.html: ломать его нельзя.
  it('ряд держит пять колонок: символ, станция, метка, ▸, время', () => {
    const f = openCall('a', 'files', LONG_LABEL)
    f.complete('a', 'ok', 400)
    const html = f.render('ru')
    expect(html.startsWith('<div class="feed-item status-done"')).toBe(true)
    const cells = ['class="symbol"', 'class="station"', 'class="label"', 'class="toggle"', 'class="time"']
    expect(html.match(/<span|<button/g)?.length).toBe(5)
    expectInOrder(html, cells)
  })

  it('строка «сейчас» — те же пять колонок', () => {
    const f = openCall('a', 'files', 'a.ts')
    expectInOrder(f.renderNow('ru', 5_000), [
      'class="symbol"',
      'class="now-name"',
      'class="label"',
      'class="feed-extra"',
      'class="time"',
    ])
  })
})

function expectInOrder(html: string, markers: string[]): void {
  const positions = markers.map((m) => html.indexOf(m))
  expect(positions.every((p) => p >= 0)).toBe(true)
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
}
