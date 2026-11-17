import { describe, it, expect } from 'vitest'
import { fileLabel, urlLabel, commandLabel, clean, safe } from '../src/core/redact.ts'

describe('fileLabel', () => {
  it('последние два сегмента пути', () => {
    expect(fileLabel('/home/user/src/app.ts')).toBe('src/app.ts')
    expect(fileLabel('C:\\Users\\user\\.env')).toBe('user/.env')
  })
  it('обрезает до 48 символов', () => {
    const long = 'a'.repeat(100)
    expect(fileLabel(long).length).toBeLessThanOrEqual(48)
  })
  it('вырезает управляющие символы', () => {
    expect(fileLabel('\u0000secret\u001f.txt')).toBe('secret.txt')
  })
})

describe('urlLabel', () => {
  it('только хост', () => {
    expect(urlLabel('https://api.github.com/v1?token=abc')).toBe('api.github.com')
  })
  it('неправильный URL → scheme', () => {
    expect(urlLabel('not-a-url')).toBe('not-a-url')
  })
})

describe('commandLabel', () => {
  it('только имя команды', () => {
    expect(commandLabel('npm install')).toBe('npm')
    expect(commandLabel('/usr/bin/CURL.EXE x.com')).toBe('curl')
    expect(commandLabel('echo "password=hunter2"')).toBe('echo')
  })
})

describe('safe', () => {
  it('возвращает результат成功 функции', () => {
    expect(safe(() => 42, -1)).toBe(42)
  })
  it('возвращает fallback при ошибке', () => {
    expect(safe(() => { throw new Error('boom') }, -1)).toBe(-1)
  })
  it('не выбрасывает исключение наверх', () => {
    expect(() => safe(() => { throw new Error('boom') }, -1)).not.toThrow()
  })
})
