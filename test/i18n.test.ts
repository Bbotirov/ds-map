import { describe, it, expect } from 'vitest'
import { t, DICTIONARY } from '../src/ui/i18n.js'

describe('i18n', () => {
  it('returns ru strings', () => {
    expect(t('ru', 'mapLabel')).toBe('Карта работы агента')
    expect(t('ru', 'stationFiles')).toBe('Файлы')
    expect(t('ru', 'stationWeb')).toBe('Сеть')
  })

  it('returns en strings', () => {
    expect(t('en', 'mapLabel')).toBe('Agent activity map')
    expect(t('en', 'stationFiles')).toBe('Files')
    expect(t('en', 'stationWeb')).toBe('Web')
  })

  it('falls back to key when missing', () => {
    expect(t('ru', 'nonexistent.key')).toBe('nonexistent.key')
  })

  it('both languages have same keys', () => {
    const ruKeys = Object.keys(DICTIONARY.ru)
    const enKeys = Object.keys(DICTIONARY.en)
    expect(ruKeys.sort()).toEqual(enKeys.sort())
  })
})
