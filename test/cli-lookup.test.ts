import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { cliCandidates, expand, findCliPath, type CliLookup } from '../extension/src/cli-lookup.js'

function lookup(over: Partial<CliLookup> = {}): CliLookup {
  return {
    setting: '',
    env: {},
    workspaceFolders: [],
    extensionPath: '/ext',
    home: '/home/botirov',
    platform: 'linux',
    exists: () => false,
    ...over,
  }
}

describe('поиск dist/cli.js', () => {
  it('настройка важнее всего остального', () => {
    const found = findCliPath(
      lookup({ setting: '/custom/cli.js', env: { DSMAP_BIN: '/env/cli.js' }, exists: (p) => p === '/custom/cli.js' }),
    )
    expect(found).toBe('/custom/cli.js')
  })

  it('DSMAP_BIN используется, если настройки нет', () => {
    expect(findCliPath(lookup({ env: { DSMAP_BIN: '/env/cli.js' }, exists: (p) => p === '/env/cli.js' }))).toBe('/env/cli.js')
  })

  it('открытый проект с собранным dist подходит', () => {
    const repo = path.join('/repo')
    const expected = path.join(repo, 'dist', 'cli.js')
    expect(findCliPath(lookup({ workspaceFolders: [repo], exists: (p) => p === expected }))).toBe(expected)
  })

  it('порядок кандидатов: настройка → DSMAP_BIN → проект → внутри расширения → глобально', () => {
    const list = cliCandidates(
      lookup({
        setting: '/custom/cli.js',
        env: { DSMAP_BIN: '/env/cli.js', APPDATA: 'C:\\Users\\botirov\\AppData\\Roaming' },
        workspaceFolders: ['C:\\repo'],
        platform: 'win32',
      }),
    )
    expect(list.slice(0, 3)).toEqual([
      '/custom/cli.js',
      '/env/cli.js',
      path.join('C:\\repo', 'dist', 'cli.js'),
    ])
    expect(list).toContain(path.join('/ext', 'bundled', 'dist', 'cli.js'))
    expect(list).toContain(
      path.join('C:\\Users\\botirov\\AppData\\Roaming', 'npm', 'node_modules', 'ds-map', 'dist', 'cli.js'),
    )
  })

  it('на unix ищется префикс npm или /usr/local', () => {
    const withPrefix = cliCandidates(lookup({ env: { npm_config_prefix: '/opt/npm' } }))
    expect(withPrefix).toContain(path.join('/opt/npm', 'lib', 'node_modules', 'ds-map', 'dist', 'cli.js'))
    const plain = cliCandidates(lookup())
    expect(plain).toContain(path.join('/usr/local/lib/node_modules', 'ds-map', 'dist', 'cli.js'))
  })

  it('раскрывает workspaceFolder, userHome и тильду', () => {
    const base = lookup({ workspaceFolders: ['/work/proj'], home: '/home/botirov' })
    expect(expand('${workspaceFolder}/dist/cli.js', base)).toBe('/work/proj/dist/cli.js')
    expect(expand('${userHome}/x/cli.js', base)).toBe('/home/botirov/x/cli.js')
    expect(expand('~/x/cli.js', base)).toBe('/home/botirov/x/cli.js')
    expect(expand('~', base)).toBe('/home/botirov')
    expect(expand('~username/x', base)).toBe('~username/x')
  })

  it('ничего не найдено — undefined, а не выдуманный путь', () => {
    expect(findCliPath(lookup({ setting: '/missing/cli.js' }))).toBeUndefined()
  })
})
