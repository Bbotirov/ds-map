import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DEFAULT_CONFIG, clearEndpointFiles, configPath, normalizeConfig, parseEndpointFiles,
  portPath, readConfig, readEndpoint, sessionsRoot, tokenPath, writeConfig, dshHome,
} from '../src/shared/config.js'

/**
 * Пути и форма настроек — единственное, чем обмениваются сайдкар, окно и doctor.
 * Здесь проверяется, что разъехаться они не могут: один источник путей и whitelist
 * для значений конфига.
 */

let home: string | null = null

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmap-config-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('пути', () => {
  it('собираются из DSH_HOME и лежат в одной папке', () => {
    expect(dshHome()).toBe(home)
    expect(path.dirname(tokenPath())).toBe(home!)
    expect(path.dirname(portPath())).toBe(home!)
    expect(path.dirname(configPath())).toBe(home!)
    expect(sessionsRoot()).toBe(path.join(home!, 'sessions'))
  })

  it('без DSH_HOME берут домашнюю папку', () => {
    delete process.env.DSH_HOME
    expect(dshHome()).toContain('.dsh')
  })
})

describe('normalizeConfig', () => {
  it('без файла или с мусором отдаёт дефолты', () => {
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig('light')).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig(42)).toEqual(DEFAULT_CONFIG)
  })

  it('принимает только разрешённые значения', () => {
    expect(normalizeConfig({ theme: 'light', lang: 'en', motion: 'reduced' })).toEqual({
      theme: 'light', lang: 'en', motion: 'reduced',
    })
    expect(normalizeConfig({ theme: 'neon', lang: 'uz', motion: 'slow' })).toEqual(DEFAULT_CONFIG)
  })

  it('не пропускает посторонние поля и не падает на них', () => {
    const out = normalizeConfig({ theme: 'light', token: 'секрет', cwd: 'c:\\proj' })
    expect(Object.keys(out).sort()).toEqual(['lang', 'motion', 'theme'])
    expect(out.theme).toBe('light')
  })

  it('по одному полю остальное остаётся дефолтным', () => {
    expect(normalizeConfig({ lang: 'en' })).toEqual({ ...DEFAULT_CONFIG, lang: 'en' })
  })
})

describe('файл настроек', () => {
  it('круговой проход: записали — прочитали', () => {
    writeConfig({ theme: 'light', lang: 'en', motion: 'reduced' })
    expect(readConfig()).toEqual({ theme: 'light', lang: 'en', motion: 'reduced' })
  })

  it('битый JSON и несуществующий файл — дефолты, без исключения', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), '{ не json')
    expect(readConfig()).toEqual(DEFAULT_CONFIG)
    fs.rmSync(configPath())
    expect(readConfig()).toEqual(DEFAULT_CONFIG)
  })
})

describe('parseEndpointFiles', () => {
  it('разбирает рабочий порт и токен', () => {
    expect(parseEndpointFiles('54321\n', ' abc-123 ')).toEqual({ port: 54321, token: 'abc-123' })
  })

  it('отклоняет порт вне диапазона и не-число', () => {
    expect(parseEndpointFiles('', 'tok')).toBeNull()
    expect(parseEndpointFiles('abc', 'tok')).toBeNull()
    expect(parseEndpointFiles('0', 'tok')).toBeNull()
    expect(parseEndpointFiles('65536', 'tok')).toBeNull()
    expect(parseEndpointFiles('1.5', 'tok')).toBeNull()
  })

  it('отклоняет пустой или многострочный токен', () => {
    expect(parseEndpointFiles('1234', '  ')).toBeNull()
    expect(parseEndpointFiles('1234', 'раз\nдва')).toBeNull()
  })

  it('readEndpoint без файлов возвращает null вместо исключения', () => {
    expect(readEndpoint()).toBeNull()
  })

  it('readEndpoint читает то, что записал сайдкар', () => {
    fs.mkdirSync(dshHome(), { recursive: true })
    fs.writeFileSync(portPath(), '41000')
    fs.writeFileSync(tokenPath(), 'tok-1')
    expect(readEndpoint()).toEqual({ port: 41000, token: 'tok-1' })
  })
})

describe('clearEndpointFiles', () => {
  it('убирает только свои значения', () => {
    fs.mkdirSync(dshHome(), { recursive: true })
    fs.writeFileSync(portPath(), '41000')
    fs.writeFileSync(tokenPath(), 'tok-1')
    clearEndpointFiles({ port: 41000, token: 'tok-1' })
    expect(fs.existsSync(portPath())).toBe(false)
    expect(fs.existsSync(tokenPath())).toBe(false)
  })

  it('не трогает файлы параллельного запуска', () => {
    fs.mkdirSync(dshHome(), { recursive: true })
    fs.writeFileSync(portPath(), '42000')
    fs.writeFileSync(tokenPath(), 'tok-2')
    clearEndpointFiles({ port: 41000, token: 'tok-1' })
    expect(readEndpoint()).toEqual({ port: 42000, token: 'tok-2' })
  })

  it('на отсутствующих файлах молчит', () => {
    expect(() => clearEndpointFiles({ port: 1, token: 'x' })).not.toThrow()
  })
})
