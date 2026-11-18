import { describe, expect, it } from 'vitest'
import { computePanelBounds, parseWatcherLine, type WatcherState, type WindowBounds } from '../src/ui/window.js'

const AREA = { x: 0, y: 0, width: 1536, height: 816 }

function harness(x: number, y: number, width: number, height: number): WindowBounds {
  return { x, y, width, height }
}

/** Разбор ради геометрии: всё остальное в тесте — diagnostics-поля того же кадра. */
function boundsOf(line: string): Extract<WatcherState, { kind: 'bounds' }> {
  const state = parseWatcherLine(line)
  if (!state || state.kind !== 'bounds') throw new Error(`не bounds: ${line}`)
  return state
}

describe('parseWatcherLine', () => {
  it('разбирает геометрию окна', () => {
    expect(parseWatcherLine('{"state":"bounds","x":120,"y":80,"width":700,"height":500}')).toEqual({
      kind: 'bounds',
      bounds: { x: 120, y: 80, width: 700, height: 500 },
    })
  })

  it('разбирает служебные состояния', () => {
    expect(parseWatcherLine('{"state":"minimized"}')?.kind).toBe('minimized')
    expect(parseWatcherLine('{"state":"pending"}')?.kind).toBe('pending')
    expect(parseWatcherLine('{"state":"gone"}')?.kind).toBe('gone')
  })

  it('молча игнорирует мусор PowerShell', () => {
    expect(parseWatcherLine('Add-Type : warning')).toBeNull()
    expect(parseWatcherLine('')).toBeNull()
    expect(parseWatcherLine('{битый json')).toBeNull()
    expect(parseWatcherLine('{"state":"bounds","x":1,"y":2,"width":3}')).toBeNull()
    expect(parseWatcherLine('{"state":"???","x":1,"y":2,"width":3,"height":4}')).toBeNull()
  })

  it('не принимает NaN и строки вместо чисел', () => {
    expect(parseWatcherLine('{"state":"bounds","x":"12","y":2,"width":3,"height":4}')).toBeNull()
    expect(parseWatcherLine('{"state":"bounds","x":null,"y":2,"width":3,"height":4}')).toBeNull()
  })

  it('носит источник якоря вместе с геометрией', () => {
    expect(parseWatcherLine('{"state":"bounds","x":1,"y":2,"width":300,"height":400,"anchor":"parent","proc":"Code.exe"}')).toEqual({
      kind: 'bounds',
      bounds: { x: 1, y: 2, width: 300, height: 400 },
      anchor: 'parent',
      proc: 'Code.exe',
    })
    for (const source of ['hwnd', 'tree', 'parent', 'title'] as const) {
      expect(boundsOf(`{"state":"bounds","x":0,"y":0,"width":10,"height":10,"anchor":"${source}"}`).anchor).toBe(source)
    }
  })

  it('строка без anchor разбирается ровно как раньше', () => {
    expect(parseWatcherLine('{"state":"bounds","x":120,"y":80,"width":700,"height":500}')).toStrictEqual({
      kind: 'bounds',
      bounds: { x: 120, y: 80, width: 700, height: 500 },
    })
    expect(boundsOf('{"state":"bounds","x":1,"y":1,"width":2,"height":3}').anchor).toBeUndefined()
  })

  it('неизвестный anchor не отменяет геометрию', () => {
    expect(parseWatcherLine('{"state":"bounds","x":5,"y":6,"width":700,"height":500,"anchor":"sidebar"}')).toStrictEqual({
      kind: 'bounds',
      bounds: { x: 5, y: 6, width: 700, height: 500 },
    })
    expect(boundsOf('{"state":"bounds","x":5,"y":6,"width":700,"height":500,"anchor":42}').anchor).toBeUndefined()
  })

  it('в proc не проходит ничего, кроме имени образа', () => {
    const line = (proc: string) => `{"state":"bounds","x":1,"y":1,"width":9,"height":9,"anchor":"parent","proc":"${proc}"}`
    expect(boundsOf(line('C:\\\\x\\\\Code.exe')).proc).toBeUndefined()
    expect(boundsOf(line('ok\\\\u2028ok')).proc).toBeUndefined()
    // Выбросив proc, геометрию терять нельзя: она единственная двигает панель.
    expect(boundsOf(line('')).bounds).toEqual({ x: 1, y: 1, width: 9, height: 9 })
  })
})

describe('computePanelBounds', () => {
  it('без окна харнеса ставит панель к правому краю рабочей области', () => {
    expect(computePanelBounds(null, AREA)).toEqual({ x: 1108, y: 8, width: 420, height: 800 })
  })

  it('стыкует справа от окна с зазором 8 и повторяет его высоту', () => {
    expect(computePanelBounds(harness(0, 0, 900, 600), AREA)).toEqual({ x: 908, y: 0, width: 420, height: 600 })
  })

  it('не лезет на таскбар: при maximized окне высота обрезается рабочей областью', () => {
    const b = computePanelBounds(harness(-8, -8, 1552, 832), AREA)
    expect(b.y).toBe(0)
    expect(b.height).toBe(AREA.height)
    expect(b.y + b.height).toBeLessThanOrEqual(AREA.height)
  })

  it('когда места справа нет, сжимается до минимума и прижимается к правому краю', () => {
    const b = computePanelBounds(harness(-8, -8, 1552, 832), AREA)
    expect(b.width).toBe(320)
    expect(b.x + b.width).toBe(AREA.width - 8)
  })

  it('учитывает смещение второго монитора', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1040 }
    expect(computePanelBounds(harness(1920, 0, 1200, 900), second)).toEqual({ x: 3128, y: 0, width: 420, height: 900 })
    expect(computePanelBounds(null, second).x).toBe(1920 + 1920 - 420 - 8)
  })

  it('окно ниже экрана — панель сдвигает вверх, высота сохраняется', () => {
    const b = computePanelBounds(harness(0, 700, 600, 600), AREA)
    expect(b.y).toBe(216)
    expect(b.y + b.height).toBe(AREA.height)
  })

  it('окно правее экрана — панель не уходит за левый край', () => {
    const b = computePanelBounds(harness(2000, 0, 600, 600), AREA)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.width).toBeGreaterThanOrEqual(320)
  })

  it('панель всегда целиком внутри рабочей области', () => {
    const cases: WindowBounds[] = [
      harness(0, 0, 100, 100),
      harness(1500, 800, 400, 400),
      harness(-32000, -32000, 200, 150),
      harness(0, 0, 1536, 816),
    ]
    for (const h of cases) {
      const b = computePanelBounds(h, AREA)
      expect(b.x).toBeGreaterThanOrEqual(AREA.x)
      expect(b.y).toBeGreaterThanOrEqual(AREA.y)
      expect(b.x + b.width).toBeLessThanOrEqual(AREA.x + AREA.width)
      expect(b.y + b.height).toBeLessThanOrEqual(AREA.y + AREA.height)
    }
  })
})
