import { describe, it, expect } from 'vitest'
import { t, type Language, DICTIONARY } from '../src/ui/i18n.js'

describe('i18n', () => {
  it('t возвращает перевод по ключу для ru', () => {
    expect(t('ru', 'themeDark')).toBe('Тёмная')
    expect(t('ru', 'themeLight')).toBe('Светлая')
    expect(t('ru', 'languageRu')).toBe('Русский')
    expect(t('ru', 'motionFull')).toBe('Полная анимация')
    expect(t('ru', 'motionReduced')).toBe('Минимум движения')
  })

  it('t возвращает перевод по ключу для en', () => {
    expect(t('en', 'themeDark')).toBe('Dark')
    expect(t('en', 'themeLight')).toBe('Light')
    expect(t('en', 'languageRu')).toBe('Russian')
    expect(t('en', 'languageEn')).toBe('English')
    expect(t('en', 'motionFull')).toBe('Full motion')
    expect(t('en', 'motionReduced')).toBe('Reduced motion')
  })

  it('t возвращает сам ключ, если перевод отсутствует', () => {
    expect(t('ru', 'unknown.key')).toBe('unknown.key')
    expect(t('en', 'missing')).toBe('missing')
  })

  it('DICTIONARY содержит все ключи для обоих языков', () => {
    const ruKeys = Object.keys(DICTIONARY.ru)
    const enKeys = Object.keys(DICTIONARY.en)
    expect(ruKeys.sort()).toEqual(enKeys.sort())
  })
})
