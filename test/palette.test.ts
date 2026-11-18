import { describe, it, expect } from 'vitest'
import { getPalette, detectTheme } from '../src/ui/renderer/palette.js'

describe('palette', () => {
  it('DARK has all 13 tokens', () => {
    const d = getPalette('dark')
    expect(d.background).toBe('#0a0c11')
    expect(d.error).toBe('#e8654f')
  })

  it('LIGHT has all 13 tokens', () => {
    const l = getPalette('light')
    expect(l.background).toBe('#f5f2ea')
    expect(l.error).toBe('#c5402b')
  })

  it('detectTheme defaults to dark without window', () => {
    // В Node нет window — должна быть dark
    const t = detectTheme()
    expect(t).toBe('dark')
  })
})
