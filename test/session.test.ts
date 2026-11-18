import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionTailer, escapeCwd, findLatestSession } from '../src/daemon/session.js'
import { sessionsRoot } from '../src/shared/config.js'
import { EventBus } from '../src/daemon/bus.js'
import type { DsMapEvent } from '../src/core/events.js'

/**
 * Тейл читает реальные session.v4.jsonl харнеса. Здесь проверяется не разбор
 * (он в route.test.ts), а именно слежение за файлом: позиция, неполная строка,
 * смена сессии, чужие каталоги.
 */

let root: string | null = null
let tailer: SessionTailer | null = null

function useFakeDshHome(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmap-test-'))
  process.env.DSH_HOME = root
  return path.join(root, 'sessions')
}

function sessionDir(cwd: string, id: string): string {
  const dir = path.join(sessionsRoot(), `--${escapeCwd(cwd)}--`, id)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fileIn(dir: string): string {
  return path.join(dir, 'session.v4.jsonl')
}

function writeLines(file: string, records: unknown[]): void {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function appendText(file: string, text: string): void {
  fs.appendFileSync(file, text)
}

function sessionRecord(id: string, cwd: string): unknown {
  return { type: 'session', version: 4, id, cwd, createdAt: 1, isSeeded: false }
}

function collect(): { events: DsMapEvent[]; bus: EventBus } {
  const bus = new EventBus()
  const events: DsMapEvent[] = []
  bus.subscribe((e) => events.push(e))
  return { events, bus }
}

async function waitFor(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`условие не наступило за ${timeoutMs} мс`)
}

function typesOf(events: DsMapEvent[]): string[] {
  return events.map((e) => e.t)
}

afterEach(() => {
  tailer?.stop()
  tailer = null
  if (root) {
    fs.rmSync(root, { recursive: true, force: true })
    root = null
  }
  delete process.env.DSH_HOME
})

describe('escapeCwd и поиск сессии', () => {
  it('экранирует cwd как харнес', () => {
    expect(escapeCwd('c:\\Users\\user\\Desktop\\fun proj')).toBe('c-Users-user-Desktop-fun~0020proj')
  })

  it('берёт самую свежую сессию по mtime', () => {
    useFakeDshHome()
    const cwd = 'c:\\proj'
    const old = fileIn(sessionDir(cwd, 'session-old'))
    const fresh = fileIn(sessionDir(cwd, 'session-fresh'))
    writeLines(old, [sessionRecord('session-old', cwd)])
    writeLines(fresh, [sessionRecord('session-fresh', cwd)])
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(old, past, past)

    const found = findLatestSession(sessionsRoot(), cwd)
    expect(found?.file).toBe(fresh)
  })

  it('не берёт сессии другого каталога', () => {
    useFakeDshHome()
    writeLines(fileIn(sessionDir('c:\\proj', 'session-mine')), [])
    writeLines(fileIn(sessionDir('c:\\other', 'session-other')), [])
    expect(findLatestSession(sessionsRoot(), 'c:\\proj')?.file).toContain('session-mine')
    expect(findLatestSession(sessionsRoot(), 'c:\\missing')?.file).toBeUndefined()
  })

  it('находит сессию независимо от регистра диска', () => {
    useFakeDshHome()
    const file = fileIn(sessionDir('C:\\Users\\user\\Desktop', 'session-1'))
    writeLines(file, [])
    expect(findLatestSession(sessionsRoot(), 'c:\\users\\user\\desktop')?.file).toBe(file)
  })
})

describe('SessionTailer', () => {
  it('доедает историю и живые события в правильном порядке', async () => {
    useFakeDshHome()
    const cwd = 'c:\\proj'
    const file = fileIn(sessionDir(cwd, 'session-1'))
    const time = 1_000

    writeLines(file, [
      sessionRecord('session-1', cwd),
      { type: 'turn/start', seq: 1, time, data: { turn: 1 } },
      { type: 'request/context', seq: 2, time, data: { provider: 'nvidia', model: 'm', contextWindow: 1000 } },
      { type: 'user/message', seq: 3, time, data: { content: [{ type: 'text', text: 'прочитай' }], source: { kind: 'user' } } },
      { type: 'tool/call', seq: 4, time, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"src/app.ts"}', turn: 1, step: 1 } },
      { type: 'tool/result', seq: 5, time, data: { message: { toolCallId: 'c1', isError: false } } },
      { type: 'turn/end', seq: 6, time, data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    const { events, bus } = collect()
    tailer = new SessionTailer(bus)
    tailer.start(cwd)
    await waitFor(() => typesOf(events).includes('answer'))

    expect(typesOf(events).slice(0, 4)).toEqual(['session.start', 'prompt', 'tool.start', 'tool.end'])
    const start = events.find((e) => e.t === 'tool.start')
    const end = events.find((e) => e.t === 'tool.end')
    expect(start).toMatchObject({ station: 'files', label: 'src/app.ts' })
    expect(end).toMatchObject({ status: 'ok', station: 'files', label: 'src/app.ts' })
  })

  it('не публикует неполную строку, а после её завершения публикует', async () => {
    useFakeDshHome()
    const cwd = 'c:\\proj'
    const file = fileIn(sessionDir(cwd, 'session-2'))
    writeLines(file, [sessionRecord('session-2', cwd)])

    const { events, bus } = collect()
    tailer = new SessionTailer(bus)
    tailer.start(cwd)
    await waitFor(() => typesOf(events).includes('session.start'))

    const half = JSON.stringify({ type: 'tool/call', time: 2, data: { callId: 'c', name: 'grep', arguments: '{}' } })
    appendText(file, half.slice(0, 30))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(typesOf(events)).not.toContain('tool.start')

    appendText(file, half.slice(30) + '\n')
    await waitFor(() => typesOf(events).includes('tool.start'))
  })

  it('переключается на новую сессию того же каталога', async () => {
    useFakeDshHome()
    const cwd = 'c:\\proj'
    const first = fileIn(sessionDir(cwd, 'session-a'))
    writeLines(first, [sessionRecord('session-a', cwd)])

    const { events, bus } = collect()
    tailer = new SessionTailer(bus)
    tailer.start(cwd)
    await waitFor(() => typesOf(events).includes('session.start'))

    const second = fileIn(sessionDir(cwd, 'session-b'))
    writeLines(second, [
      sessionRecord('session-b', cwd),
      { type: 'tool/call', time: 5, data: { callId: 'x', name: 'skill', arguments: '{"name":"unslop"}' } },
    ])
    const future = new Date(Date.now() + 2_000)
    fs.utimesSync(second, future, future)

    await waitFor(() => events.some((e) => e.t === 'tool.start' && e.label === 'unslop'), 8_000)
    const sessions = events.filter((e) => e.t === 'session.start')
    expect(sessions.map((e) => (e as { session: string }).session)).toContain('session-b')
  })

  it('не падает, когда каталога сессий вовсе нет', async () => {
    useFakeDshHome()
    const { events, bus } = collect()
    tailer = new SessionTailer(bus)
    tailer.start('c:\\nowhere')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(events).toEqual([])
  })

  it('stop() освобождает файловый дескриптор и гасит опрос', async () => {
    useFakeDshHome()
    const cwd = 'c:\\proj'
    const file = fileIn(sessionDir(cwd, 'session-c'))
    writeLines(file, [sessionRecord('session-c', cwd)])

    const { events, bus } = collect()
    tailer = new SessionTailer(bus)
    tailer.start(cwd)
    await waitFor(() => typesOf(events).includes('session.start'))
    expect(tailer.currentFile).toBe(file)

    tailer.stop()
    tailer = null
    appendText(file, JSON.stringify({ type: 'turn/start', time: 9, data: { turn: 2 } }) + '\n')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(typesOf(events)).not.toContain('model.step')
  })
})
