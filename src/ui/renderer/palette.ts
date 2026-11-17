/**
 * 13 цветовых токенов из lot-map (MIT).
 * dark / light / auto по prefers-color-scheme.
 */

export type Theme = 'dark' | 'light'

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

export function getPalette(theme: Theme): Palette {
  return theme === 'light' ? LIGHT : DARK
}

export function detectTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}
