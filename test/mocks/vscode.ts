/**
 * Заменяемая в тестах реализация API VS Code: запись вызовов вместо настоящего
 * интерфейса. Алиас `vscode` → этот файл настроен в vitest.config.ts.
 */

export type Recorded =
  | { kind: 'terminal'; command: string; name: string; cwd?: string }
  | { kind: 'sendText'; terminal: string; text: string }
  | { kind: 'dispose'; terminal: string }
  | { kind: 'show'; terminal: string }
  | { kind: 'error'; message: string }
  | { kind: 'command'; id: string }
  | { kind: 'status'; text: string; command: string }
  | { kind: 'output'; level: 'info' | 'error'; text: string }

export const record: Recorded[] = []

export const settings: Record<string, unknown> = {}

export function reset(): void {
  record.length = 0
  commands.registered.clear()
  for (const key of Object.keys(settings)) delete settings[key]
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

interface FakeTerminal {
  name: string
  sendText(text: string): void
  show(): void
  dispose(): void
}

const closed: ((t: FakeTerminal) => void)[] = []

export const workspace = {
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        return (settings[`${section}.${key}`] as T) ?? fallback
      },
    }
  },
}

export const window = {
  createOutputChannel(_name: string, _opts?: unknown) {
    return {
      info: (text: string) => record.push({ kind: 'output', level: 'info', text }),
      error: (text: string) => record.push({ kind: 'output', level: 'error', text }),
      show: () => undefined,
      dispose: () => undefined,
    }
  },
  createStatusBarItem(_align: StatusBarAlignment, _priority: number) {
    const item = {
      text: '',
      tooltip: '',
      command: '',
      show: () => record.push({ kind: 'status', text: item.text, command: item.command }),
      hide: () => undefined,
      dispose: () => undefined,
    }
    return item
  },
  createTerminal(options: { name?: string; cwd?: string }) {
    const name = options.name ?? 'terminal'
    record.push({ kind: 'terminal', command: '', name, cwd: options.cwd })
    const terminal: FakeTerminal = {
      name,
      sendText: (text: string) => record.push({ kind: 'sendText', terminal: name, text }),
      show: () => record.push({ kind: 'show', terminal: name }),
      dispose: () => {
        record.push({ kind: 'dispose', terminal: name })
        for (const cb of closed) cb(terminal)
      },
    }
    return terminal
  },
  onDidCloseTerminal(cb: (t: FakeTerminal) => void) {
    closed.push(cb)
    return { dispose: () => undefined }
  },
  showErrorMessage: async (message: string, ..._items: string[]) => {
    record.push({ kind: 'error', message })
    return undefined
  },
}

export const commands = {
  registered: new Map<string, (...args: unknown[]) => unknown>(),
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    commands.registered.set(id, handler)
    record.push({ kind: 'command', id })
    return { dispose: () => commands.registered.delete(id) }
  },
  executeCommand: async (id: string, ...args: unknown[]) => commands.registered.get(id)?.(...args),
}

export const extensionUri = { fsPath: '/mock/extension' }
