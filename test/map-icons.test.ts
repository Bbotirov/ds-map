import { describe, expect, it } from 'vitest'

import type { Station } from '../src/core/events.js'
import { createState, drawMap, STATIONS, STATION_ICONS, type Setup, type State } from '../src/ui/renderer/map.js'

const setup: Setup = { theme: 'dark', layout: 'you-top', motion: 'full', lang: 'ru' }
// Дальний момент времени: переключение модели (SWITCH_MS) уже не подсвечено.
const NOW = 10_000_000

function svg(state: State): string {
  return drawMap(state, NOW, setup)
}

describe('иконки станций (перенос geometry из lot-map)', () => {
  it('есть у каждой станции кольца', () => {
    expect(Object.keys(STATION_ICONS).sort()).toEqual([...STATIONS].sort())
    for (const station of STATIONS) {
      expect(STATION_ICONS[station].length).toBeGreaterThan(3)
      expect(STATION_ICONS[station]).toMatch(/^[MLHVACSQZTmlhvacsqtz0-9eE. +-]+$/)
    }
  })

  it('рисуются внутри узла штриховкой, а не заливкой', () => {
    const out = svg(createState())
    for (const station of STATIONS) {
      expect(out).toContain(`<path d="${STATION_ICONS[station]}" fill="none" stroke=`)
    }
    expect(out.match(/<path d="M/g) ?? []).toHaveLength(STATIONS.length)
  })

  it('в покое иконка приглушённая, память со счётчиком — бирюзовая', () => {
    const state = createState()
    expect(svg(state).match(/fill="none" stroke="#9ba1ab"/g)).toHaveLength(STATIONS.length)
    state.stationCounts.set('memory', 4)
    expect(svg(state)).toContain(`<path d="${STATION_ICONS.memory}" fill="none" stroke="#62c7ba"`)
  })

  it('активная станция красит иконку в горячий цвет, ошибка — в красный', () => {
    const state = createState()
    state.active.set('shell', { startedAt: NOW - 100, count: 1, background: false })
    expect(svg(state)).toContain(`<path d="${STATION_ICONS.shell}" fill="none" stroke="#f0c595"`)

    const alarmed = createState()
    alarmed.alarms.set('files', NOW - 10)
    expect(svg(alarmed)).toContain(`<path d="${STATION_ICONS.files}" fill="none" stroke="#e8654f"`)
  })

  it('подпись станции не сливается со спицами: обводка цветом фона', () => {
    expect(svg(createState())).toContain('paint-order="stroke" stroke="#0a0c11"')
  })

  it('иконки на месте при обоих порядке обхода', () => {
    for (const layout of ['you-top', 'you-bottom'] as const) {
      const out = drawMap(createState(), NOW, { ...setup, layout })
      const count = STATIONS.filter((s: Station) => out.includes(STATION_ICONS[s])).length
      expect(count).toBe(STATIONS.length)
    }
  })
})
