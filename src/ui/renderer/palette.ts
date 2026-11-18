/**
 * 13 цветовых токенов из lot-map (MIT).
 * dark / light / auto по prefers-color-scheme.
 */

export type Theme = 'dark' | 'light'
/** Выбор пользователя: `auto` разрешает тему по системе. */
export type ThemeSetting = Theme | 'auto'

export interface Palette {
  background: string
  node: string
  line: string
  spoke: string
  text: string
  label: string
  faint: string
  accent: string
  active: string
  error: string
  memory: string
  memoryActive: string
  route: string
}

export const DARK: Palette = {
  background: '#0a0c11',
  node: '#12151c',
  line: '#272c36',
  spoke: '#1a1e27',
  text: '#ebe6dc',
  label: '#9ba1ab',
  faint: '#6b7280',
  accent: '#e1ac6e',
  active: '#f0c595',
  error: '#e8654f',
  memory: '#62c7ba',
  memoryActive: '#a5e6dc',
  route: '#ebe6dd',
}

export const LIGHT: Palette = {
  background: '#f5f2ea',
  node: '#ffffff',
  line: '#cfc9bc',
  spoke: '#e3ded2',
  text: '#1f2228',
  label: '#5f6570',
  faint: '#8b909a',
  accent: '#b8762a',
  active: '#8f560f',
  error: '#c5402b',
  memory: '#1c8c81',
  memoryActive: '#136a62',
  route: '#9c978b',
}

/** Порядок обхода важен: по нему генерируются CSS-переменные оболочки. */
export const TOKENS = [
  'background', 'node', 'line', 'spoke', 'text', 'label', 'faint',
  'accent', 'active', 'error', 'memory', 'memoryActive', 'route',
] as const satisfies readonly (keyof Palette)[]

export function getPalette(theme: Theme): Palette {
  return theme === 'light' ? LIGHT : DARK
}

/** Настройка `auto` читается из системы; вне браузера (тесты) — dark. */
export function resolveTheme(setting: ThemeSetting): Theme {
  return setting === 'auto' ? detectTheme() : setting
}

export function detectTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

/** Подписка на смену системной темы; возвращает функцию отписки. */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const handler = (e: MediaQueryListEvent) => onChange(e.matches ? 'light' : 'dark')
  if (mq.addEventListener) {
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }
  // Safari <= 13 знает только addListener; окно Electron его не использует,
  // но фолбэк дешевле, чем молча потерять реакцию на смену темы.
  mq.addListener(handler)
  return () => mq.removeListener(handler)
}

/**
 * Токены как CSS-переменные `--dsmap-*` — единственный источник цвета
 * для DOM-обёртки (панель, лента), чтобы палитра не дублировалась в styles.
 */
export function cssVars(palette: Palette): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const token of TOKENS) {
    vars[`--dsmap-${kebab(token)}`] = palette[token]
  }
  return vars
}

function kebab(token: string): string {
  return token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '')
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG-контраст двух цветов: 1..21. */
export function contrast(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
