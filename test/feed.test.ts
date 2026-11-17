import { describe, it, expect } from 'vitest'
import { Feed } from '../src/ui/renderer/feed.js'
import type { Station } from '../src/core/events.js'

describe('Feed', () => {
  it('add добавляет элемент в начало ленты', () => {
    const feed = new Feed()
    feed.add({ time: '10:00', station: 'files', label: 'read src/app.ts', status: 'active' })
    const items = feed.getItems()
    expect(items.length).toBe(1)
    expect(items[0].station).toBe('files')
    expect(items[0].status).toBe('active')
  })

  it('maxItems ограничивает ленту 16 элементами', () => {
    const feed = new Feed()
    const stations: Station[] = ['shell', 'files', 'web', 'agents', 'skills']
    for (let i = 0; i < 20; i++) {
      feed.add({ time: `10:${i}`, station: stations[i % stations.length], label: `cmd ${i}`, status: 'done' })
    }
    expect(feed.getItems().length).toBe(16)
  })

  it('сворачивает подряд идущие done одной станции', () => {
    const feed = new Feed()
    feed.add({ time: '10:00', station: 'shell', label: 'ls', status: 'done' })
    feed.add({ time: '10:01', station: 'shell', label: 'ls', status: 'done' })
    feed.add({ time: '10:02', station: 'shell', label: 'ls', status: 'done' })
    const items = feed.getItems()
    expect(items.length).toBe(1)
    expect(items[0].label).toContain('+3')
  })

  it('markError помечает активный элемент как ошибку', () => {
    const feed = new Feed()
    feed.add({ time: '10:00', station: 'shell', label: 'rm -rf', status: 'active' })
    feed.markError('shell', 'rm -rf')
    const items = feed.getItems()
    expect(items[0].status).toBe('error')
  })

  it('markError не меняет элементы других станций', () => {
    const feed = new Feed()
    feed.add({ time: '10:00', station: 'shell', label: 'rm -rf', status: 'active' })
    feed.add({ time: '10:01', station: 'files', label: 'read x.ts', status: 'active' })
    feed.markError('shell', 'rm -rf')
    const items = feed.getItems()
    // unshift: первый добавленный элемент в конце
    const shellItem = items.find((i) => i.station === 'shell')
    const filesItem = items.find((i) => i.station === 'files')
    expect(shellItem?.status).toBe('error')
    expect(filesItem?.status).toBe('active')
  })

  it('setCollapsed свёртывает все элементы кроме указанного', () => {
    const feed = new Feed()
    feed.add({ time: '10:00', station: 'shell', label: 'a', status: 'done' })
    feed.add({ time: '10:01', station: 'files', label: 'b', status: 'done' })
    const id = feed.getItems()[1].id
    feed.setCollapsed(id)
    const items = feed.getItems()
    expect(items.find((i) => i.id === id)?.collapsed).toBe(false)
    expect(items.find((i) => i.id !== id)?.collapsed).toBe(true)
  })

  it('render экранирует HTML в метке', () => {
    const feed = new Feed()
    feed.add({ time: '10:00', station: 'shell', label: '<script>alert(1)</script>', status: 'done' })
    const html = feed.render('ru')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('render включает символ статуса', () => {
    const feed = new Feed()
    feed.add({ time: '10:00', station: 'shell', label: 'cmd', status: 'error' })
    const html = feed.render('ru')
    expect(html).toContain('✕')
  })
})
