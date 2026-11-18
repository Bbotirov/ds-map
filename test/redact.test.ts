import { describe, it, expect } from 'vitest'
import { clean, fileLabel, urlLabel, commandLabel, safe } from '../src/core/redact.js'

describe('clean', () => {
  it('strips control characters', () => {
    expect(clean('hello\u0000world\u001f')).toBe('helloworld')
  })
  it('truncates to MAX', () => {
    expect(clean('a'.repeat(100))).toHaveLength(48)
  })
})

describe('fileLabel', () => {
  it('takes last two path segments', () => {
    expect(fileLabel('/Users/user/Desktop/fun proj/ds-map/src/cli.ts')).toBe('src/cli.ts')
  })
  it('works with backslashes', () => {
    expect(fileLabel('C:\\Users\\user\\file.txt')).toBe('user/file.txt')
  })
})

describe('urlLabel', () => {
  it('returns host only', () => {
    expect(urlLabel('https://example.com/path?q=1')).toBe('example.com')
  })
  it('falls back to scheme-like string for invalid URLs', () => {
    expect(urlLabel('not-a-url')).toBe('not-a-url')
  })
})

describe('commandLabel', () => {
  it('returns command name only', () => {
    expect(commandLabel('cat /etc/passwd')).toBe('cat')
    expect(commandLabel('C:\\Windows\\system32\\ping.exe')).toBe('ping')
  })

  it('оставляет подкоманду, когда это голое слово', () => {
    expect(commandLabel('git status')).toBe('git status')
    expect(commandLabel('pnpm install 2>&1')).toBe('pnpm install')
    expect(commandLabel('npm run build')).toBe('npm run')
    expect(commandLabel('docker pull nginx')).toBe('docker pull')
  })

  it('не пропускает в метку флаги, пути и перенаправления', () => {
    expect(commandLabel('grep -r "TODO" src')).toBe('grep')
    expect(commandLabel('npx tsc --noEmit 2>&1')).toBe('npx tsc')
    expect(commandLabel('find . -name *.ts')).toBe('find')
    expect(commandLabel('ls | tail -20')).toBe('ls')
    expect(commandLabel('echo $SECRET')).toBe('echo')
  })

  it('пустая и мусорная команда дают unknown, без исключения', () => {
    expect(commandLabel('')).toBe('unknown')
    expect(commandLabel('   ')).toBe('unknown')
    expect(commandLabel('"')).toBe('unknown')
  })

  it('метка никогда не длиннее сорока восьми символов', () => {
    expect(commandLabel(`${'a'.repeat(80)} status`)).toHaveLength(48)
  })
})

describe('safe', () => {
  it('returns result on success', () => {
    expect(safe(() => 42, 0)).toBe(42)
  })
  it('returns fallback on error', () => {
    expect(safe(() => { throw new Error('boom') }, 0)).toBe(0)
  })
})
