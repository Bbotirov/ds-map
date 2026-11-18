import { describe, it, expect } from 'vitest'
import { DICTIONARY, format, guardPhraseKey, phraseKey, t } from '../src/ui/i18n.js'

/** Ключей фраз много, а лента обязана говорить по-человечески в обоих языках. */
const PHRASE_KEYS = Object.keys(DICTIONARY.ru).filter((k) => k.startsWith('phrase'))

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

describe('слой фраз', () => {
  it('ни одна фраза не сырой идентификатор и не пустая строка', () => {
    expect(PHRASE_KEYS.length).toBeGreaterThan(20)
    for (const key of PHRASE_KEYS) {
      for (const lang of ['ru', 'en'] as const) {
        const phrase = DICTIONARY[lang][key]
        expect(phrase.trim().length).toBeGreaterThan(0)
        // Имена инструментов вида `get_child_item` и `mcp__server__tool` —
        // не фразы; в ленте они живут только как деталь после разделителя.
        expect(phrase).not.toContain('_')
        expect(phrase).not.toBe(key)
      }
    }
  })

  it('substitutions are present in both languages', () => {
    expect(format('ru', 'phrasePrompt', { n: 214 })).toBe('ты написал · 214 симв.')
    expect(format('en', 'phrasePrompt', { n: 214 })).toBe('you wrote · 214 chars')
    expect(format('ru', 'phraseAgentMsg', { n: 2 })).toBe('входящее от агента · 2')
    expect(format('en', 'phraseAgentMsg', { n: 2 })).toBe('message from agent · 2')
    expect(format('ru', 'retryBadge', { a: 2, o: 5 })).toBe('повтор 2/5')
    expect(format('en', 'retryBadge', { a: 2, o: 5 })).toBe('retry 2/5')
  })

  it('placeholders match between languages', () => {
    const braces = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    for (const key of Object.keys(DICTIONARY.ru)) {
      expect(braces(DICTIONARY.en[key])).toBe(braces(DICTIONARY.ru[key]))
    }
  })

  it('phraseKey covers raw harness names with a human phrase', () => {
    expect(phraseKey('get-childitem', 'shell')).toBe('phraseAtShell')
    expect(phraseKey('pwsh', 'shell')).toBe('phraseRunCommand')
    expect(phraseKey('read', 'files')).toBe('phraseReadFile')
    expect(phraseKey('grep', 'files')).toBe('phraseSearchText')
    expect(phraseKey('using-superpowers', 'skills')).toBe('phraseAtSkills')
    expect(phraseKey('skill', 'skills')).toBe('phraseSkill')
    expect(phraseKey('browser_navigate', 'browser')).toBe('phraseBrowser')
    expect(phraseKey('mcp__playwright__browser_click', 'browser')).toBe('phraseBrowser')
    expect(phraseKey('mcp__agent_bus__ask', 'agents')).toBe('phraseAtAgents')
  })

  it('unknown tool falls back to the station phrase, never to its name', () => {
    expect(phraseKey('zzz_unknown_tool', 'web')).toBe('phraseAtWeb')
    expect(phraseKey('zzz_unknown_tool', 'memory')).toBe('phraseAtMemory')
    // Станции вне списка тоже дают фразу, а не ключ: `t()` вернул бы ключ дословно.
    for (const station of ['nope', '']) {
      const key = phraseKey('zzz', station)
      expect(t('ru', key)).not.toBe(key)
      expect(t('en', key)).not.toBe(key)
    }
  })

  it('guard kinds have their own phrases', () => {
    expect(guardPhraseKey('permission')).toBe('phraseGuardPermission')
    expect(guardPhraseKey('sandbox')).toBe('phraseGuardSandbox')
    expect(guardPhraseKey('approval')).toBe('phraseGuardApproval')
    expect(guardPhraseKey('weird')).toBe('phraseGuard')
    for (const kind of ['permission', 'sandbox', 'approval', 'weird']) {
      for (const lang of ['ru', 'en'] as const) expect(t(lang, guardPhraseKey(kind))).not.toBe(guardPhraseKey(kind))
    }
  })

  it('format leaves the string alone when a var is missing', () => {
    expect(format('ru', 'phrasePrompt', {})).toBe('ты написал · {n} симв.')
    // Фразы без подстановок не теряются: vars можно не передавать вовсе.
    expect(format('en', 'phraseStep', {})).toBe('model step')
  })
})
