import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutoOpen } from '../extension/src/auto-open.js'
import { ASSETS, renderDocument } from '../extension/src/map-html.js'
import {
  DockHeartbeat,
  FRESH_MS,
  STALE_MS,
  decodePresence,
  dockFile,
  encodePresence,
  isFresh,
  sweepPlan,
} from '../extension/src/presence.js'
import { escapeCwd, isLive, listSessions, nodeFs } from '../extension/src/sessions.js'
import { MapModel, sanitizeLabel } from '../extension/src/snapshot.js'

type Mock = typeof import('./mocks/vscode.js')
type ExtensionModule = typeof import('../extension/src/extension.js')
type Provider = import('../extension/src/map-view.js').MapViewProvider
type FakeView = import('./mocks/vscode.js').FakeWebviewView

const existingCli = path.resolve('package.json')
const builtCli = path.resolve('dist', 'cli.js')
const manifest = JSON.parse(fs.readFileSync(path.resolve('extension', 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string }[]
    views: Record<string, { id: string; type: string; name: string }[]>
    viewsContainers: Record<string, { id: string }[]>
  }
}

/** Строки-маркеры: ни одна не имеет права пересечь мост в webview. */
const SECRET_PROMPT = 'ТЕКСТ-ПРОМПТА-КОТОРЫЙ-НЕ-НАРУЖУ'
const SECRET_COMMAND = 'rm -rf /home/user/СЕКРЕТНЫЕ-ФАЙЛЫ --force'
const SECRET_TITLE = 'ЗАГОЛОВОК-СЕССИИ-из-разговора'
const SECRET_TOKEN = 'ТОКЕН-САЙДКАРА-НЕ-ДЛЯ-DOM'

let mock: Mock
let extension: ExtensionModule
let home: string
let previousHome: string | undefined

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

/** Сколько раз расширение попросило показать вкладку. */
function focusCalls(): number {
  return mock.record.filter(
    (r) => r.kind === 'execCommand' && (r as { id: string }).id === 'dsMap.map.focus',
  ).length
}

/** Провайдер, который расширение поставило при activate, + разрешённая вкладка. */
function resolveView(): { provider: Provider; view: FakeView } {
  const provider = mock.viewProviders.get('dsMap.map') as unknown as Provider
  expect(provider, 'провайдер dsMap.map не зарегистрирован').toBeTruthy()
  const view = mock.createWebviewView()
  provider.resolveWebviewView(view as never)
  return { provider, view }
}

function lastSnapshot(view: FakeView): Record<string, unknown> {
  const messages = postedSnapshots(view)
  expect(messages.length, 'в webview не ушло ни одного снимка').toBeGreaterThan(0)
  return messages[messages.length - 1]
}

function postedSnapshots(view: FakeView): Record<string, unknown>[] {
  return (view.webview.posted as { kind?: string; snapshot?: Record<string, unknown> }[])
    .filter((m) => m.kind === 'snapshot')
    .map((m) => m.snapshot as Record<string, unknown>)
}

async function flush(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Каталог сессии в том же виде, в каком его пишет харнес. */
function writeSession(cwd: string, id: string, mtimeMs: number, body: string): string {
  const dir = path.join(home, 'sessions', `--${escapeCwd(cwd)}--`, id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl')
  fs.writeFileSync(file, body)
  const when = new Date(mtimeMs)
  fs.utimesSync(file, when, when)
  return file
}

beforeEach(async () => {
  vi.resetModules()
  previousHome = process.env.DSH_HOME
  // Дом харнеса подменяем всегда: тесты не должны читать ни настоящий токен,
  // ни настоящие сессии пользователя.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmap-test-'))
  process.env.DSH_HOME = home
  mock = await import('./mocks/vscode.js')
  mock.reset()
  mock.workspace.workspaceFolders = undefined
  extension = await import('../extension/src/extension.js')
  extension.activate(context() as never)
})

afterEach(() => {
  vi.useRealTimers()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

describe('расширение VS Code', () => {
  it('регистрирует вкладку и команды ровно как в package.json', () => {
    const declared = manifest.contributes.commands.map((c) => c.command).sort()
    const registered = [...mock.commands.registered.keys()].sort()
    expect(registered).toEqual(declared)

    const container = manifest.contributes.viewsContainers.secondarySidebar[0].id
    const view = manifest.contributes.views[container][0]
    expect(view.type).toBe('webview')
    const recorded = find('view') as { kind: 'view'; id: string; retained: boolean }
    expect(recorded.id).toBe(view.id)
    // Панель переживает переключение таба: пересобирать кольцо на каждый клик — мигание.
    expect(recorded.retained).toBe(true)
    expect(declared).toEqual(expect.arrayContaining(['dsMap.start', 'dsMap.stop', 'dsMap.doctor']))
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
    await flush(50)

    const out = mock.record.filter((r) => r.kind === 'output')
    expect(out.length).toBeGreaterThan(0)
    expect((out[0] as { level: string }).level).toBe('error')
    if (env !== undefined) process.env.DSMAP_BIN = env
  })

  it('doctor с собранным CLI показывает живой вывод', async () => {
    if (!fs.existsSync(builtCli)) return
    mock.settings['dsMap.cliPath'] = builtCli

    run('dsMap.doctor')
    await flush(5_000)

    const lines = mock.record
      .filter((r) => r.kind === 'output')
      .map((r) => (r as { text: string }).text)
      .join('\n')
    expect(lines).toMatch(/ds-map|dsmap/i)
  })

  it('открыть карту зовёт команду фокуса вкладки', async () => {
    const focus = vi.fn()
    mock.commands.registerCommand('dsMap.map.focus', focus)

    await run('dsMap.openMap')

    expect(focus).toHaveBeenCalled()
  })
})

describe('мост host → webview', () => {
  it('html вкладки живёт на own CSP с nonce и без токена', () => {
    // Порт не пишем: эндпоинт неполный → host никуда не стучится во время теста.
    fs.writeFileSync(path.join(home, 'dsmap-token.txt'), SECRET_TOKEN)
    const { view } = resolveView()
    const html = view.webview.html

    expect(html).toContain("default-src 'none'")
    expect(html).toContain("style-src 'unsafe-inline'")
    expect(html).toMatch(/script-src 'nonce-/)
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1]
    expect(nonce, 'nonce в CSP').toBeTruthy()
    expect(html).toContain(`<script nonce="${nonce}">`)
    // Токен сайдкара принадлежит host-у: в DOM вкладки ему не место.
    expect(html).not.toContain(SECRET_TOKEN)
    expect(view.webview.options).toMatchObject({ enableScripts: true, localResourceRoots: [] })
  })

  it('через мост проходят только снимки: ни промпта, ни командной строки, ни заголовка сессии', async () => {
    const { provider, view } = resolveView()
    const ts = Date.now()

    provider.ingest({
      v: 1,
      t: 'session.start',
      ts,
      session: 'sess-aaaa1111',
      model: 'deepseek-chat',
      // Лишние поля — как раз то, что умеет писать будущий харнес.
      prompt: SECRET_PROMPT,
      title: SECRET_TITLE,
    })
    provider.ingest({ v: 1, t: 'prompt', ts, chars: 128, text: SECRET_PROMPT })
    provider.ingest({ v: 1, t: 'tool.start', ts, id: 'c1', name: 'Bash', station: 'shell', label: SECRET_COMMAND })
    provider.ingest({ v: 1, t: 'job.start', ts, id: 'j1', station: 'shell', label: SECRET_COMMAND })
    // Сырая запись журнала: не событие ds-map, проходит через ту же дверь.
    provider.ingest({ type: 'session/title', title: SECRET_TITLE })
    provider.ingest({ v: 1, t: 'неизвестное-событие', title: SECRET_TITLE })
    await flush()

    const wire = JSON.stringify(postedSnapshots(view))
    expect(wire).not.toContain(SECRET_PROMPT)
    expect(wire).not.toContain(SECRET_COMMAND)
    expect(wire).not.toContain(SECRET_TITLE)
    expect(wire).not.toContain('-rf')
    // И при этом снимок живой: голое имя утилиты дошло, мост не пустой.
    const feed = (lastSnapshot(view) as { feed: { label: string | null }[] }).feed
    expect(feed.some((row) => row.label === 'rm')).toBe(true)
    for (const message of view.webview.posted as { kind: string }[]) {
      expect(message.kind).toBe('snapshot')
    }
  })

  it('webview не может приказать host-у что-то выполнить', async () => {
    const { view } = resolveView()
    mock.record.length = 0

    view.emit({ type: 'executeCommand', command: 'dsMap.start' })
    view.emit({ type: 'hide' })
    view.emit('строкой')
    view.emit(null)
    await flush(50)

    expect(find('terminal')).toBeUndefined()
    expect(find('sendText')).toBeUndefined()
  })

  it('сообщение «сессии» из панели открывает выбор сессии', async () => {
    const { view } = resolveView()
    const pick = vi.fn()
    mock.commands.registerCommand('dsMap.pickSession', pick)

    view.emit({ type: 'sessions' })
    await flush(50)

    expect(pick).toHaveBeenCalled()
  })

  it('скопированный снимок — та же обезвреженная проекция', async () => {
    const { provider, view } = resolveView()
    provider.ingest({ v: 1, t: 'tool.start', ts: Date.now(), id: 'c9', name: 'Read', station: 'files', label: SECRET_COMMAND })
    await flush()

    await run('dsMap.copySnapshot')

    const clip = find('clipboard') as { kind: 'clipboard'; text: string }
    expect(clip.text).toContain('"kind": "snapshot"')
    expect(clip.text).not.toContain(SECRET_COMMAND)
    expect(clip.text).not.toContain('rm -rf')
    expect(JSON.parse(clip.text).stations.length).toBe(10)
    expect(lastSnapshot(view)).toBeTruthy()
  })

  it('карта в браузере — статичный снимок без токена', async () => {
    resolveView()
    fs.writeFileSync(path.join(home, 'dsmap-token.txt'), SECRET_TOKEN, { mode: 0o600 })

    await run('dsMap.browserMap')

    const opened = find('openExternal') as { kind: 'openExternal'; target: string }
    expect(opened.target).toMatch(/ds-map-\d+\.html$/)
    const html = fs.readFileSync(opened.target, 'utf8')
    expect(html).toContain('window.__DSMAP_SNAPSHOT__')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain(SECRET_TOKEN)
    fs.rmSync(opened.target, { force: true })
  })

  it('настройки из панели правят только свои поля общего файла', async () => {
    const file = path.join(home, 'dsmap-config.json')
    // `pause`/`counters` принадлежат окну Electron: стирать их кликом по теме — баг.
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', lang: 'ru', motion: 'reduced', pause: true, counters: false }))
    const { view } = resolveView()

    view.emit({ type: 'config', theme: 'light' })
    await flush(50)

    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ theme: 'light', lang: 'ru', motion: 'reduced', pause: true, counters: false })
  })

  it('replay переподнимает канал, а не читает журнал', async () => {
    const { provider } = resolveView()
    provider.ingest({ v: 1, t: 'session.start', ts: Date.now(), session: 's1', model: 'deepseek-chat' })

    run('dsMap.replayLast')
    await flush(50)

    const texts = mock.record
      .filter((r) => r.kind === 'output')
      .map((r) => (r as { text: string }).text)
      .join('\n')
    // Сайдек при коннекте сам досылает недавнюю историю — отдельного ридера нет.
    expect(texts).toMatch(/replay/i)
  })
})

describe('автооткрытие', () => {
  it('чистые правила: не живая — не открываем, живая — один раз, скрытая — навсегда для сессии', () => {
    const gate = new AutoOpen()

    expect(gate.shouldOpen(null)).toBe(false)
    expect(gate.shouldOpen('sess-1')).toBe(true)
    gate.markOpened()
    expect(gate.shouldOpen('sess-1')).toBe(false)
    // Новая сессия — новое право на один показ.
    expect(gate.shouldOpen('sess-2')).toBe(true)
    gate.markOpened()

    const hidden = new AutoOpen()
    expect(hidden.shouldOpen('sess-3')).toBe(true)
    hidden.markOpened()
    hidden.noteDismissed('sess-4')
    expect(hidden.shouldOpen('sess-4')).toBe(false)
  })

  it('сорванный показ (провайдера ещё нет) не считается показом: следующий тик повторит', () => {
    const gate = new AutoOpen()
    expect(gate.shouldOpen('sess-5')).toBe(true)
    gate.release()
    expect(gate.shouldOpen('sess-5')).toBe(true)
    gate.markOpened()
    expect(gate.shouldOpen('sess-5')).toBe(false)
  })

  it('не живая сессия — вкладка не открывается', async () => {
    const cwd = path.resolve('')
    writeSession(cwd, 'sess-old', Date.now() - 10 * 60 * 1000, '{}\n')
    mock.workspace.workspaceFolders = [{ uri: { fsPath: cwd } }]

    extension.deactivate()
    vi.useFakeTimers()
    extension.activate(context() as never)
    mock.commands.registerCommand('dsMap.map.focus', vi.fn())
    await vi.advanceTimersByTimeAsync(30_000)

    expect(focusCalls()).toBe(0)
  })

  it('живая сессия — один показ; повтор после сорванной попытки; скрытая панель не возвращается', async () => {
    const cwd = path.resolve('')
    writeSession(cwd, 'sess-live', Date.now() - 1_000, '{}\n')
    mock.workspace.workspaceFolders = [{ uri: { fsPath: cwd } }]

    extension.deactivate()
    vi.useFakeTimers()
    extension.activate(context() as never)
    await vi.advanceTimersByTimeAsync(0)

    // Просрочка: команды фокуса ещё нет, и первый тик показом не считается.
    const focus = vi.fn()
    mock.commands.registerCommand('dsMap.map.focus', focus)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(focus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(focus).toHaveBeenCalledTimes(1)

    // Новая живая сессия — снова одно право на показ.
    writeSession(cwd, 'sess-next', Date.now(), '{}\n')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(focus).toHaveBeenCalledTimes(2)

    // Пользователь скрыл карту: её сессию больше не трогаем, новую — открываем.
    const { view } = resolveView()
    view.changeVisibility(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(focus).toHaveBeenCalledTimes(2)

    writeSession(cwd, 'sess-after', Date.now(), '{}\n')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(focus).toHaveBeenCalledTimes(3)
  })

  it('настройка dsMap.autoOpen=false глушит автооткрытие', async () => {
    const cwd = path.resolve('')
    writeSession(cwd, 'sess-off', Date.now() - 1_000, '{}\n')
    mock.workspace.workspaceFolders = [{ uri: { fsPath: cwd } }]
    mock.settings['dsMap.autoOpen'] = false

    extension.deactivate()
    vi.useFakeTimers()
    extension.activate(context() as never)
    mock.commands.registerCommand('dsMap.map.focus', vi.fn())
    await vi.advanceTimersByTimeAsync(30_000)

    expect(focusCalls()).toBe(0)
  })
})

describe('presence heartbeat', () => {
  it('свежесть и выметание мусора — чистые правила', () => {
    expect(isFresh({ pid: 7, t: 1_000 }, 1_000 + FRESH_MS)).toBe(true)
    expect(isFresh({ pid: 7, t: 1_000 }, 1_000 + FRESH_MS + 1)).toBe(false)
    expect(isFresh(null, 1_000)).toBe(false)
    // Часы могут спешить: отрицательный возраст — живой, иначе панель осталась бы без карты.
    expect(isFresh({ pid: 7, t: 5_000 }, 1_000)).toBe(true)

    const now = 1_000_000
    const plan = sweepPlan(
      [
        { name: 'dsmap-dock.1.json', presence: { pid: 1, t: now - STALE_MS - 1 } },
        { name: 'dsmap-dock.2.json', presence: { pid: 2, t: now - 1_000 } },
        { name: 'dsmap-dock.3.json', presence: null },
        { name: 'note.txt', presence: null },
      ],
      now,
    )
    expect(plan).toEqual(['dsmap-dock.1.json', 'dsmap-dock.3.json'])
  })

  it('битая или чужая по форме запись не читается как присутствие', () => {
    expect(decodePresence('не json')).toBeNull()
    expect(decodePresence('{"pid":"1","t":2}')).toBeNull()
    expect(decodePresence('{"pid":0,"t":2}')).toBeNull()
    expect(decodePresence(encodePresence(42, 7))).toEqual({ pid: 42, t: 7 })
  })

  it('beat пишет свой файл, чужой свежий = экран занят, проухавший метётся', () => {
    let now = 1_700_000_000_000
    const beat = new DockHeartbeat({ dir: home, pid: 4242, now: () => now })
    beat.beat()

    const own = decodePresence(fs.readFileSync(dockFile(home, 4242), 'utf8'))
    expect(own).toEqual({ pid: 4242, t: now })
    expect(beat.claimedByOther()).toBe(false)

    fs.writeFileSync(dockFile(home, 999), encodePresence(999, now - 1_000))
    expect(beat.claimedByOther()).toBe(true)

    // Упавший процесс: его файл старше минуты — следующий тик убирает его.
    fs.writeFileSync(dockFile(home, 777), encodePresence(777, now - STALE_MS - 1))
    now += 1
    beat.beat()
    expect(fs.existsSync(dockFile(home, 777))).toBe(false)
    expect(fs.existsSync(dockFile(home, 999))).toBe(true)

    beat.stop()
    expect(fs.existsSync(dockFile(home, 4242))).toBe(false)
  })
})

describe('выбор сессии', () => {
  const cwd = path.resolve('')

  it('экранирование cwd, порядок по mtime и только каталоги с session.v4.jsonl', () => {
    expect(escapeCwd('c:\\Users\\user\\Desktop\\fun proj')).toBe('c-Users-user-Desktop-fun~0020proj')

    writeSession(cwd, 'sess-old', Date.now() - 60_000, '{}\n')
    writeSession(cwd, 'sess-mid', Date.now() - 30_000, '{}\n')
    const newest = writeSession(cwd, 'sess-new', Date.now() - 1_000, '{}\n')
    // Чужой каталог и каталог без записи в список не попадают.
    writeSession('d:\\другой-проект', 'sess-other', Date.now(), '{}\n')
    fs.mkdirSync(path.join(home, 'sessions', `--${escapeCwd(cwd)}--`, 'sess-empty'), { recursive: true })

    const list = listSessions(path.join(home, 'sessions'), cwd, nodeFs)
    expect(list.map((s) => s.id)).toEqual(['sess-new', 'sess-mid', 'sess-old'])
    expect(list[0].file).toBe(newest)
    expect(isLive(list[0], Date.now())).toBe(true)
    expect(isLive(list[2], Date.now())).toBe(true)
    expect(isLive({ id: 'x', dir: '', file: '', mtimeMs: Date.now() - 10 * 60_000 }, Date.now())).toBe(false)
    expect(listSessions(path.join(home, 'нет-такого-каталога'), cwd, nodeFs)).toEqual([])
  })

  it('подписи — только id и время: заголовка сессии в них нет', async () => {
    const now = Date.now()
    writeSession(cwd, 'sess-1', now - 5 * 60_000, JSON.stringify({ type: 'session/title', title: SECRET_TITLE }) + '\n')
    writeSession(cwd, 'sess-2', now - 2_000, JSON.stringify({ type: 'session/title', title: SECRET_TITLE }) + '\n')
    mock.workspace.workspaceFolders = [{ uri: { fsPath: cwd } }]
    mock.setQuickPickAnswer({ label: 'sess-2' })
    const { view } = resolveView()

    await run('dsMap.pickSession')
    await flush()

    const pick = find('quickPick') as { kind: 'quickPick'; items: { label: string; description?: string }[] }
    // Порядок — по времени записи, свежие сверху.
    expect(pick.items.map((i) => i.label)).toEqual(['sess-2', 'sess-1'])
    const wire = JSON.stringify(pick.items)
    expect(wire).not.toContain(SECRET_TITLE)
    for (const item of pick.items) {
      expect(item.description).toMatch(/(только что|мин назад|ч назад|дн назад)$/)
    }
    expect((lastSnapshot(view) as { picked: string | null }).picked).toBe('sess-2')
  })

  it('без открытой папки — сообщение, а не исключение', async () => {
    mock.workspace.workspaceFolders = undefined
    await run('dsMap.pickSession')
    expect(find('quickPick')).toBeUndefined()
    expect((find('info') as { message: string } | undefined)?.message).toContain('нет открытой папки')
  })
})

describe('обезвреживание меток', () => {
  it('из подписи остаются только имена', () => {
    expect(sanitizeLabel(SECRET_COMMAND)).toBe('rm')
    expect(sanitizeLabel('git status --porcelain=v1')).toBe('git status')
    expect(sanitizeLabel('pnpm test')).toBe('pnpm test')
    expect(sanitizeLabel('src/ui/map.ts')).toBe('src/ui/map.ts')
    expect(sanitizeLabel('/etc/passwd')).toBe('unknown')
    expect(sanitizeLabel(`echo ${SECRET_PROMPT}`)).toBe('echo')
    expect(sanitizeLabel('кривая "кавычка')).toBe('unknown')
    expect(sanitizeLabel(undefined)).toBe('unknown')
    expect(sanitizeLabel(`a\n${SECRET_TITLE}`)).toBe('a')
  })

  it('сырая запись харнеса не становится событием', () => {
    const model = new MapModel(() => Date.now())
    expect(model.ingest({ type: 'session/title', title: SECRET_TITLE })).toBe(false)
    expect(model.ingest({ v: 2, t: 'prompt', chars: 1, text: SECRET_PROMPT })).toBe(false)
    expect(model.ingest(null)).toBe(false)
    expect(model.ingest('строка')).toBe(false)
    const snap = model.snapshot()
    expect(JSON.stringify(snap)).not.toContain(SECRET_TITLE)
    expect(snap.feed).toEqual([])
  })

  it('новые события схемы доходят до снимка своими рядами', () => {
    const model = new MapModel(() => 1_000)
    model.ingest({ v: 1, t: 'turn.start', ts: 1_000, turn: 4 })
    model.ingest({ v: 1, t: 'model.think', ts: 1_000, ms: 3_200 })
    model.ingest({ v: 1, t: 'model.retry', ts: 1_000, attempt: 2, of: 5, delayMs: 484 })
    model.ingest({ v: 1, t: 'guard.set', ts: 1_000, kind: 'approval', label: 'auto' })
    model.ingest({ v: 1, t: 'agent.msg', ts: 1_000, inserted: 3 })
    const rows = model.snapshot().feed
    expect(rows.map((r) => r.key)).toEqual(['agentMsgLabel', 'guardLabel', 'retryLabel', 'thinkLabel', 'turnLabel'])
    expect(rows[4]).toMatchObject({ station: 'you', vars: { n: 4 } })
    expect(rows[3]).toMatchObject({ station: 'model', ms: 3_200 })
    expect(rows[2]).toMatchObject({ station: 'model', symbol: 'error', vars: { n: 2, of: 5 } })
    expect(rows[1]).toMatchObject({ station: 'hooks', label: 'auto' })
    expect(rows[0]).toMatchObject({ station: 'agents', vars: { n: 3 } })
    expect(model.snapshot().errors).toBe(1)
  })

  it('первое имя модели не печатается как переключение с unknown', () => {
    const model = new MapModel(() => 1_000)
    model.ingest({ v: 1, t: 'model.switch', ts: 1_000, from: '', to: 'nvidia/glm-4.7' })
    const [row] = model.snapshot().feed
    expect(row.label).toBe('nvidia/glm-4.7')
    expect(JSON.stringify(model.snapshot())).not.toContain('unknown')
    expect(model.snapshot().model).toBe('nvidia/glm-4.7')
    // Настоящая смена показывает оба имени.
    model.ingest({ v: 1, t: 'model.switch', ts: 1_000, from: 'nvidia/glm-4.7', to: 'coarena/gpt-6-luna' })
    expect(model.snapshot().feed[0].label).toBe('nvidia/glm-4.7 → coarena/gpt-6-luna')
  })

  it('правило доступа без имени показывает сам род правила', () => {
    const model = new MapModel(() => 1_000)
    model.ingest({ v: 1, t: 'guard.set', ts: 1_000, kind: 'sandbox', label: '' })
    model.ingest({ v: 1, t: 'guard.set', ts: 1_000, kind: 'неизвестный', label: 'standard' })
    const rows = model.snapshot().feed
    expect(rows[1]).toMatchObject({ label: 'sandbox' })
    expect(rows[0]).toMatchObject({ label: 'standard' })
  })
})

describe('документ webview', () => {
  it('клиентский скрипт карты синтаксически цел и не ломает html', () => {
    // Инлайн-скрипт печатается как есть: незакрытая строка или `</script>`
    // внутри строки означали бы пустую вкладку без всякой ошибки в логе.
    expect(ASSETS.script).not.toContain('</scr' + 'ipt>')
    expect(() => new Function(ASSETS.script)).not.toThrow()
  })

  it('клиент рисует кольцо, ленту и тулбар на присланном снимке', () => {
    // Инлайн-скрипт — вся логика вкладки; проверить её можно и без DOM:
    // достаточно подставить узлы, которые он ищет по id.
    const nodes = new Map<string, Record<string, unknown>>()
    const el = (id: string) => {
      if (!nodes.has(id)) {
        nodes.set(id, { id, innerHTML: '', textContent: '', style: {}, setAttribute: () => undefined, onclick: null })
      }
      return nodes.get(id)
    }
    const listeners: ((e: { data: unknown }) => void)[] = []
    const win = { addEventListener: (_t: string, cb: (e: { data: unknown }) => void) => listeners.push(cb) }
    const doc = { body: el('body'), getElementById: el }
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'acquireVsCodeApi', ASSETS.script)(win, doc, {
      postMessage: () => undefined,
    })

    const model = new MapModel(() => Date.now())
    model.setConnected(true)
    model.ingest({ v: 1, t: 'session.start', ts: Date.now(), session: 'sess-1', model: 'deepseek-chat' })
    model.ingest({ v: 1, t: 'tool.start', ts: Date.now(), id: 'c1', name: 'Bash', station: 'shell', label: SECRET_COMMAND })
    for (const cb of listeners) cb({ data: { kind: 'snapshot', snapshot: model.snapshot() } })

    const map = String(el('map').innerHTML)
    expect(map).toContain('<svg')
    expect((map.match(/<circle r="21"/g) ?? []).length).toBe(10)
    expect(map).toContain('dsh')
    const feed = String(el('feed').innerHTML)
    expect(feed).toContain('rm')
    expect(feed).not.toContain(SECRET_COMMAND)
    expect(String(el('head').innerHTML)).toContain('Карта работы')
    expect(String(el('tools').innerHTML)).toContain('счётчики списком')

    const listButton = el('t-list') as { onclick?: () => void }
    expect(typeof listButton.onclick).toBe('function')
    listButton.onclick?.()
    expect(String(el('list').innerHTML)).toContain('Шелл')
  })

  it('карта в браузере строится тем же документом со встроенным снимком', () => {
    const model = new MapModel(() => 1_700_000_000_000)
    model.ingest({ v: 1, t: 'session.start', ts: 1_700_000_000_000, session: 'sess-1', model: 'deepseek-chat' })
    const html = renderDocument({
      csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc'",
      nonce: 'abc',
      snapshot: model.snapshot(),
    })
    expect(html).toContain('window.__DSMAP_SNAPSHOT__')
    expect(html).toContain('nonce="abc"')
    expect(html).toContain('Карта работы')
    // Десять станций в кольце — столько же, сколько в окне панели.
    expect((html.match(/"id":/g) ?? []).length).toBeGreaterThanOrEqual(10)
  })
})




