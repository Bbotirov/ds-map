import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Mock = typeof import('./mocks/vscode.js')
type ExtensionModule = typeof import('../extension/src/extension.js')

const existingCli = path.resolve('package.json')
const builtCli = path.resolve('dist', 'cli.js')

let mock: Mock
let extension: ExtensionModule

function context(): { subscriptions: { dispose(): void }[]; extensionPath: string } {
  return { subscriptions: [], extensionPath: '/mock/extension' }
}

function run(id: string): unknown {
  const handler = mock.commands.registered.get(id)
  expect(handler, `команда ${id} не зарегистрирована`).toBeTypeOf('function')
  return handler?.()
}

function find(kind: string): Mock.Recorded | undefined {
  return mock.record.find((r) => r.kind === kind)
}

beforeEach(async () => {
  vi.resetModules()
  mock = await import('./mocks/vscode.js')
  mock.reset()
  mock.workspace.workspaceFolders = undefined
  extension = await import('../extension/src/extension.js')
  extension.activate(context() as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('расширение VS Code', () => {
  it('регистрирует три команды', () => {
    const ids = mock.record.filter((r) => r.kind === 'command').map((r) => (r as { id: string }).id)
    expect(ids).toEqual(['dsMap.start', 'dsMap.stop', 'dsMap.doctor'])
  })

  it('start поднимает харнес через лаунчер в терминале', async () => {
    mock.settings['dsMap.cliPath'] = existingCli
    mock.settings['dsMap.harnessCommand'] = 'dsh --profile web'

    await run('dsMap.start')

    expect(find('terminal')).toMatchObject({ name: 'ds-map' })
    expect(find('sendText')).toEqual({
      kind: 'sendText',
      terminal: 'ds-map',
      text: `node "${existingCli}" run -- dsh --profile web`,
    })
    expect(find('show')).toBeTruthy()
  })

  it('второй start не поднимает второй терминал, а показывает существующий', async () => {
    mock.settings['dsMap.cliPath'] = existingCli
    await run('dsMap.start')
    mock.record.length = 0

    await run('dsMap.start')
    expect(find('terminal')).toBeUndefined()
    expect(find('show')).toBeTruthy()
  })

  it('stop шлёт честный Ctrl-C в PTY', async () => {
    mock.settings['dsMap.cliPath'] = existingCli
    await run('dsMap.start')
    mock.record.length = 0

    await run('dsMap.stop')
    expect(find('sendText')).toEqual({ kind: 'sendText', terminal: 'ds-map', text: '\u0003' })
  })

  it('stop без терминала ничего не убивает', async () => {
    await run('dsMap.stop')
    expect(find('sendText')).toBeUndefined()
    expect(find('dispose')).toBeUndefined()
  })

  it('статус-бар отражает запуск и остановку', async () => {
    mock.settings['dsMap.cliPath'] = existingCli
    const idle = mock.record.filter((r) => r.kind === 'status').pop()
    expect(idle).toMatchObject({ text: '$(circle-outline) ds-map: выключено' })

    await run('dsMap.start')
    const running = mock.record.filter((r) => r.kind === 'status').pop()
    expect(running).toMatchObject({ text: '$(radiowave) ds-map: работает', command: 'dsMap.stop' })
  })

  it('без найденного CLI — понятная ошибка вместо молчаливого запуска', async () => {
    const env = process.env.DSMAP_BIN
    delete process.env.DSMAP_BIN
    mock.settings['dsMap.cliPath'] = ''

    await run('dsMap.start')

    expect((find('error') as { message: string } | undefined)?.message).toContain('ds-map не найден')
    expect(find('terminal')).toBeUndefined()
    if (env !== undefined) process.env.DSMAP_BIN = env
  })

  it('doctor пишет вывод в канал и не падает без CLI', async () => {
    const env = process.env.DSMAP_BIN
    delete process.env.DSMAP_BIN
    mock.settings['dsMap.cliPath'] = ''

    run('dsMap.doctor')
    await new Promise((r) => setTimeout(r, 50))

    const out = mock.record.filter((r) => r.kind === 'output')
    expect(out.length).toBeGreaterThan(0)
    expect((out[0] as { level: string }).level).toBe('error')
    if (env !== undefined) process.env.DSMAP_BIN = env
  })

  it('doctor с собранным CLI показывает живой вывод', async () => {
    if (!fs.existsSync(builtCli)) return
    mock.settings['dsMap.cliPath'] = builtCli

    run('dsMap.doctor')
    await new Promise((r) => setTimeout(r, 5_000))

    const lines = mock.record
      .filter((r) => r.kind === 'output')
      .map((r) => (r as { text: string }).text)
      .join('\n')
    expect(lines).toMatch(/ds-map|dsmap/i)
  })
})
