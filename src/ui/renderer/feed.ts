/**
 * Лента событий: под картой, последние 16 строк.
 * ● идёт, · готово, ✕ провал, ◆ смена модели.
 */

import type { Station } from '../../core/events.js'

export interface FeedItem {
  id: string
  time: string
  station: Station
  label: string
  status: 'active' | 'done' | 'error'
  ms?: number
  collapsed: boolean
}

const SYMBOLS: Record<string, string> = {
  active: '●',
  done: '·',
  error: '✕',
}

export class Feed {
  private items: FeedItem[] = []
  private maxItems = 16
  private collapsedId: string | null = null

  add(item: Omit<FeedItem, 'id' | 'collapsed'>): void {
    const id = `${item.time}-${item.station}-${item.label}`
    // Сворачиваем подряд идущие завершённые вызовы одной станции
    const last = this.items[this.items.length - 1]
    if (last && last.station === item.station && last.status === 'done' && item.status === 'done') {
      last.label = last.label.replace(/\s\+\d+$/, '') + ` +${(parseInt(last.label.match(/\+(\d+)$/)?.[1] ?? '1') + 1)}`
      return
    }

    this.items.unshift({ ...item, id, collapsed: false })
    if (this.items.length > this.maxItems) this.items.pop()
  }

  markError(station: string, label: string): void {
    for (const item of this.items) {
      if (item.station === station && item.label === label && item.status === 'active') {
        item.status = 'error'
        break
      }
    }
  }

  setCollapsed(id: string): void {
    this.collapsedId = id
    for (const item of this.items) {
      item.collapsed = item.id !== id
    }
  }

  getItems(): FeedItem[] {
    return this.items
  }

  render(lang: 'ru' | 'en'): string {
    const lines = this.items.map((item) => {
      const symbol = SYMBOLS[item.status]
      const time = item.ms !== undefined ? ` ${item.ms}ms` : ''
      const label = item.collapsed ? item.label + ' ▸' : item.label
      return `<div class="feed-item status-${item.status}">
        <span class="symbol">${symbol}</span>
        <span class="station">${this.t(lang, item.station)}</span>
        <span class="label">${this.escape(label)}</span>
        <span class="time">${time}</span>
      </div>`
    })
    return lines.join('')
  }

  private t(lang: 'ru' | 'en', station: Station): string {
    const map: Record<Station, Record<'ru' | 'en', string>> = {
      you: { ru: 'Вы', en: 'You' },
      model: { ru: 'Модель', en: 'Model' },
      memory: { ru: 'Память', en: 'Memory' },
      files: { ru: 'Файлы', en: 'Files' },
      shell: { ru: 'Шелл', en: 'Shell' },
      web: { ru: 'Сеть', en: 'Web' },
      browser: { ru: 'Браузер', en: 'Browser' },
      agents: { ru: 'Агенты', en: 'Agents' },
      skills: { ru: 'Скиллы', en: 'Skills' },
      hooks: { ru: 'Хуки', en: 'Hooks' },
    }
    return map[station][lang]
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}
