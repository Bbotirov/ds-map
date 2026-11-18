/**
 * Лента событий: под картой — строка «что идёт сейчас» и последние 16 строк.
 * ● идёт, · готово, ✕ провал или блок, ◆ смена модели.
 *
 * Строка живёт по идентификатору вызова: `tool.start` открывает её, `tool.end`
 * гасит по тому же `id`. Угадывать строку по времени нельзя — вызовы одного
 * хода идут параллельно и пересекаются.
 *
 * Ряд читается как «станция — фраза — подробность»: фраза всегда локализована
 * (ключ i18n), подробность — метка из события (имя файла, хост, имя команды).
 * Сырой идентификатор сам по себе в ленте не появляется: он только подробность.
 * Переключение `ru`/`en` переписывает и уже напечатанные строки, метки не
 * переводятся — они приходят из `src/core/route.ts` как есть.
 */

import { format, stationLabel, t, type Language } from '../i18n.js'
import type { Station, ToolStatus } from '../../core/events.js'

export type FeedStatus = 'active' | 'done' | 'error' | 'switch'

/** Строки ленты: 16 рядов, как в §11. */
export const MAX_ITEMS = 16
/** Длиннее — метка обрезается по краю панели, ряд становится раскрываемым. */
export const TRUNCATE_CHARS = 44
/**
 * Потолок подробности — ровно столько, сколько `core/redact.ts` оставляет
 * имени (`clean`). Панель не обязана доверять источнику: длинная сырая строка
 * не должна попасть в DOM даже если пришёл кто-то другой.
 */
export const DETAIL_CHARS = 48
/** Прочерк: длительности нет (мгновенное событие или вызов без конца). */
export const DASH = '—'

export interface FeedEntry {
  /** Идентификатор вызова. Без него строка считается мгновенной и не закрывается. */
  id?: string
  station: Station
  /** Подробность из события: файл, команда, домен. Переводу не подлежит. */
  label?: string
  /** Ключ i18n с фразой: `phraseThink`, `answerOk`, `phraseReadFile`. */
  key?: string
  /** Подстановки вида `{n}`, `{a}`, `{o}` для ключа i18n. */
  vars?: Record<string, string | number>
  status: FeedStatus
  /** Длительность в мс — уезжает в колонку времени. Нет её — прочерк. */
  ms?: number
  /** Время события из источника: по нему считается «сколько уже идёт». */
  ts?: number
  /** Сворачиваться в `+N` умеют ряды одного рода: вызовы и службы модели. */
  mergeable?: boolean
  /** Фоновая работа: ряд не гаснет на конце хода, ждёт отчёт. */
  background?: boolean
}

export interface FeedItem {
  id: string
  station: Station
  label: string
  key: string | null
  vars: Record<string, string | number> | null
  status: FeedStatus
  ms: number | undefined
  ts: number
  /** Сколько вызовов станции свёрнуто в этот ряд: `+2`. */
  count: number
  mergeable: boolean
  background: boolean
  /** `true` — метка обрезана; раскрыть ряд можно, только один за раз. */
  collapsed: boolean
}

const SYMBOLS: Record<FeedStatus, string> = {
  active: '●',
  done: '·',
  error: '✕',
  switch: '◆',
}

/** Колонка времени: `0.4s`, `12.3s`; прочерк — для мгновенных событий. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH
  return `${(ms / 1000).toFixed(1)}s`
}

/** Статус вызова → статус строки. `unknown` — конца не было: `·` без длительности. */
export function statusOf(outcome: ToolStatus): FeedStatus {
  return outcome === 'err' ? 'error' : 'done'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Обрезать подробность до потолка имён: сырая строка в ленту не пролезает. */
function cutDetail(s: string): string {
  return s.length > DETAIL_CHARS ? `${s.slice(0, DETAIL_CHARS - 1)}…` : s
}

export class Feed {
  private items: FeedItem[] = []
  private autoId = 0
  private rev = 0

  /**
   * Номер пересборки данных ленты: 0 при пустой ленте, +1 на каждое изменение
   * рядов. DOM-обвязка печатает список только когда число сдвинулось.
   */
  get revision(): number {
    return this.rev
  }

  /**
   * Открыть строку. Повторный `add` с тем же `id`, пока ряд ещё активен,
   * перезапускает его на месте. Уже закрытый `id` — новый ряд: счётчики
   * вызовов повторяются между сессиями, оживлять прошлую строку нельзя.
   */
  add(entry: FeedEntry): FeedItem {
    this.rev += 1
    const id = entry.id ?? `auto_${++this.autoId}`
    const label = cutDetail(entry.label ?? '')
    const found = this.items.findIndex((it) => it.id === id && it.status === 'active')
    if (found >= 0) {
      const it = this.items[found]
      it.station = entry.station
      it.label = label
      it.key = entry.key ?? null
      it.vars = entry.vars ?? null
      it.status = entry.status
      it.mergeable = entry.mergeable === true
      it.background = entry.background === true
      it.ms = entry.ms
      if (entry.ts !== undefined) it.ts = entry.ts
      return it
    }

    const item: FeedItem = {
      id,
      station: entry.station,
      label,
      key: entry.key ?? null,
      vars: entry.vars ?? null,
      status: entry.status,
      ms: entry.ms,
      ts: entry.ts ?? Date.now(),
      count: 1,
      mergeable: entry.mergeable === true,
      background: entry.background === true,
      collapsed: true,
    }
    this.items.unshift(item)
    // Свежий ряд лег сверху: с ним и сливаем, если рядом такой же завершённый.
    if (item.status === 'done') this.mergeAt(0)
    this.trim()
    return item
  }

  /**
   * Закрыть строку по `id`. Возвращает `false`, если такой строки нет —
   * вызов приехал без начала, и ряд надо добавить заново.
   */
  complete(id: string, outcome: ToolStatus, ms?: number): boolean {
    const at = this.items.findIndex((it) => it.id === id)
    if (at < 0) return false
    this.rev += 1
    const item = this.items[at]
    item.status = statusOf(outcome)
    if (ms !== undefined) item.ms = ms
    if (item.status === 'done') this.mergeAt(at)
    this.trim()
    return true
  }

  /**
   * Конец хода: вызовы, которым не пришло конца, гаснем в `·`.
   * Фоновая работа не гаснет — она ждёт отчёт (§11 «Фоновая работа»).
   */
  settle(): number {
    let changed = 0
    for (const item of this.items) {
      if (item.status === 'active' && !item.background) {
        item.status = 'done'
        changed += 1
      }
    }
    if (changed > 0) this.rev += 1
    return changed
  }

  /**
   * `▸`: раскрыть ряд, свернув предыдущий. Открыта всегда одна строка.
   * Короткие метки не раскрываются — их и так видно целиком.
   */
  toggle(id: string, lang: Language): boolean {
    const item = this.items.find((it) => it.id === id)
    if (!item || !isExpandable(text(item, lang))) return false
    const open = !item.collapsed
    for (const it of this.items) it.collapsed = true
    item.collapsed = open
    this.rev += 1
    return true
  }

  getItems(): readonly FeedItem[] {
    return this.items
  }

  /** Есть ли что показывать в строке «сейчас». */
  isRunning(): boolean {
    return this.items.some((it) => it.status === 'active')
  }

  running(): FeedItem[] {
    return this.items.filter((it) => it.status === 'active')
  }

  render(lang: Language): string {
    if (this.items.length === 0) {
      return `<div class="feed-empty">${escapeHtml(t(lang, 'noEvents'))}</div>`
    }
    return this.items.map((item) => this.renderRow(item, lang)).join('')
  }

  /** Строка «что идёт сейчас» над лентой: самое давнее незакрытое + сколько ждёт. */
  renderNow(lang: Language, now: number): string {
    const running = this.running()
    const head = `<span class="now-name">${escapeHtml(t(lang, 'feedNow'))}</span>`
    const slots = [
      `<span class="symbol">${SYMBOLS.active}</span>`,
      head,
      `<span class="label">${escapeHtml(t(lang, 'nothingRunning'))}</span>`,
      '<span class="feed-extra"></span>',
      `<span class="time">${DASH}</span>`,
    ]
    if (running.length > 0) {
      const oldest = running.reduce((a, b) => (b.ts < a.ts ? b : a))
      const label = text(oldest, lang) + (oldest.count > 1 ? ` +${oldest.count}` : '')
      slots[2] =
        `<span class="label"><span class="station-name">${escapeHtml(stationLabel(lang, oldest.station))}</span> ` +
        `${escapeHtml(label)}</span>`
      slots[3] = running.length > 1
        ? `<span class="feed-extra">+${running.length - 1}</span>`
        : '<span class="feed-extra"></span>'
      slots[4] = `<span class="time">${formatMs(Math.max(0, now - oldest.ts))}</span>`
    }
    return `<div class="feed-now${running.length > 0 ? ' is-running' : ''}">${slots.join('')}</div>`
  }

  private renderRow(item: FeedItem, lang: Language): string {
    const label = text(item, lang) + (item.count > 1 ? ` +${item.count}` : '')
    const expandable = isExpandable(label)
    const open = expandable && !item.collapsed
    const classes = ['feed-item', `status-${item.status}`]
    if (item.background) classes.push('is-background')
    if (open) classes.push('expanded')

    const toggle = expandable
      ? `<button class="toggle" type="button" data-toggle="${escapeHtml(item.id)}" ` +
        `aria-expanded="${open}" aria-label="${escapeHtml(t(lang, open ? 'collapseRow' : 'expandRow'))}">▸</button>`
      : '<span class="toggle" aria-hidden="true"></span>'

    return (
      `<div class="${classes.join(' ')}" data-id="${escapeHtml(item.id)}">` +
      `<span class="symbol">${SYMBOLS[item.status]}</span>` +
      `<span class="station">${escapeHtml(stationLabel(lang, item.station))}</span>` +
      `<span class="label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>` +
      toggle +
      `<span class="time">${formatMs(item.ms)}</span>` +
      `</div>`
    )
  }

  /**
   * Слить ряд `i` с соседом ниже: тот же станция, та же фраза, оба завершены.
   * Получается одна строка с `+2` вместо двух одинаковых. Разные рода работы
   * не сливаем: «чтение файла» и «поиск» — не один и тот же поступок.
   */
  private mergeAt(at: number): void {
    const cur = this.items[at]
    const next = this.items[at + 1]
    if (!cur || !next) return
    if (!cur.mergeable || !next.mergeable) return
    if (cur.station !== next.station || cur.key !== next.key) return
    if (cur.status !== 'done' || next.status !== 'done') return
    cur.count += next.count
    if (cur.ms === undefined) cur.ms = next.ms
    if (!next.collapsed) cur.collapsed = false
    this.items.splice(at + 1, 1)
  }

  private trim(): void {
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS
  }
}

/**
 * Текст строки: сначала фраза (ключ i18n), рядом — подробность из события.
 * Ряд без ключа остаётся меткой: так было до слоя фраз, и тесты на это опираются.
 */
function text(item: Pick<FeedItem, 'label' | 'key' | 'vars'>, lang: Language): string {
  if (!item.key) return item.label
  const phrase = item.vars ? format(lang, item.key, item.vars) : t(lang, item.key)
  if (!item.label) return phrase
  return `${phrase} · ${item.label}`
}

function isExpandable(label: string): boolean {
  return label.length > TRUNCATE_CHARS
}
