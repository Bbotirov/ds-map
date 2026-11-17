import { describe, it, expect } from 'vitest'
import { getPalette, type Theme, DARK, LIGHT } from '../src/ui/renderer/palette.js'

describe('palette', () => {
  it('getPalette возвращает DARK для темы dark', () => {
    const p = getPalette('dark')
    expect(p).toBe(DARK)
    expect(p.background).toBe('#0a0c11')
    expect(p.error).toBe('#e8654f')
  })

  it('getPalette возвращает LIGHT для темы light', () => {
    const p = getPalette('light')
    expect(p).toBe(LIGHT)
    expect(p.background).toBe('#f5f2ea')
    expect(p.error).toBe('#c5402b')
  })

  it('палитры содержат все 13 токенов', () => {
    const tokens: (keyof Theme extends never ? never : keyof typeof DARK)[] = [
      'background', 'node', 'line', 'spoke', 'text', 'label', 'faint',
      'accent', 'active', 'error', 'memory', 'memoryActive', 'route',
    ]
    for (const token of tokens) {
      expect(DARK[token]).toBeDefined()
      expect(LIGHT[token]).toBeDefined()
      expect(typeof DARK[token]).toBe('string')
      expect(typeof LIGHT[token]).toBe('string')
    }
  })

  it('dark и light палитры отличаются по фонам', () => {
    expect(DARK.background).not.toBe(LIGHT.background)
  })
})
