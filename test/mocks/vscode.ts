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
  | { kind: 'info'; message: string }
  | { kind: 'command'; id: string }
  | { kind: 'execCommand'; id: string; args: unknown[] }
  | { kind: 'status'; text: string; command: string }
  | { kind: 'output'; level: 'info' | 'error'; text: string }
  | { kind: 'view'; id: string; retained: boolean }
  | { kind: 'quickPick'; items: { label: string; description?: string }[]; title?: string }
  | { kind: 'clipboard'; text: string }
  | { kind: 'openExternal'; target: string }

export const record: Recorded[] = []

export const settings: Record<string, unknown> = {}

interface FakeTerminal {
  name: string
  sendText(text: string): void
  show(): void
  dispose(): void
}

const closed: ((t: FakeTerminal) => void)[] = []

/** Зарегистрированные webview-провайдеры: тест отдаёт им сообщения как host. */
export const viewProviders = new Map<string, { resolveWebviewView(view: unknown): void }>()

/** Что вернёт следующий showQuickPick (`undefined` = пользователь нажал Esc). */
export let quickPickAnswer: { label: string } | undefined

export function setQuickPickAnswer(item: { label: string } | undefined): void {
  quickPickAnswer = item
}

export function reset(): void {
  record.length = 0
  commands.registered.clear()
  viewProviders.clear()
  quickPickAnswer = undefined
  for (const key of Object.keys(settings)) delete settings[key]
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

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

/**
 * Макет webview-вкладки: копит отправленные снимки и позволяет тесту послать
 * сообщение в host. Реального HTML здесь нет — важен контракт моста.
 */
export function createWebviewView(visible = true): {
  visible: boolean
  show(): void
  webview: {
    html: string
    options: Record<string, unknown>
    cspSource: string
    posted: unknown[]
    asWebviewUri(uri: unknown): unknown
  }
  messages: ((message: unknown) => unknown)[]
  visibility: (() => void)[]
  didDispose: (() => void)[]
  onDidChangeVisibility(cb: () => void): { dispose(): void }
  onDidDispose(cb: () => void): { dispose(): void }
  emit(message: unknown): void
  changeVisibility(next: boolean): void
  dispose(): void
} {
  const posted: unknown[] = []
  const messages: ((message: unknown) => unknown)[] = []
  const visibility: (() => void)[] = []
  const didDispose: (() => void)[] = []
  const view = {
    visible,
    show: () => {
      view.visible = true
    },
    webview: {
      html: '',
      options: {} as Record<string, unknown>,
      cspSource: 'vscode-webview:',
      posted,
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => {
        posted.push(message)
        return true
      },
      onDidReceiveMessage: (cb: (message: unknown) => unknown) => {
        messages.push(cb)
        return { dispose: () => messages.splice(messages.indexOf(cb), 1) }
      },
    },
    messages,
    visibility,
    didDispose,
    onDidChangeVisibility: (cb: () => void) => {
      visibility.push(cb)
      return { dispose: () => visibility.splice(visibility.indexOf(cb), 1) }
    },
    onDidDispose: (cb: () => void) => {
      didDispose.push(cb)
      return { dispose: () => didDispose.splice(didDispose.indexOf(cb), 1) }
    },
    emit: (message: unknown) => {
      for (const cb of [...messages]) cb(message)
    },
    changeVisibility: (next: boolean) => {
      view.visible = next
      for (const cb of [...visibility]) cb()
    },
    dispose: () => {
      for (const cb of [...didDispose]) cb()
    },
  }
  return view
}

export type FakeWebviewView = ReturnType<typeof createWebviewView>

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
  showInformationMessage: async (message: string, ..._items: string[]) => {
    record.push({ kind: 'info', message })
    return undefined
  },
  showQuickPick: async <T extends { label: string }>(items: T[] | Promise<T[]>) => {
    const list = await items
    record.push({ kind: 'quickPick', items: list.map((i) => ({ label: i.label, description: i.description })) })
    const answer = quickPickAnswer
    quickPickAnswer = undefined
    if (!answer) return undefined
    return list.find((i) => i.label === answer.label)
  },
  registerWebviewViewProvider(
    viewId: string,
    provider: { resolveWebviewView(view: unknown): void },
    options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
  ) {
    viewProviders.set(viewId, provider)
    record.push({ kind: 'view', id: viewId, retained: options?.webviewOptions?.retainContextWhenHidden === true })
    return { dispose: () => viewProviders.delete(viewId) }
  },
}

export const env = {
  clipboard: {
    writeText: async (text: string) => {
      record.push({ kind: 'clipboard', text })
    },
  },
  openExternal: async (target: { fsPath?: string; toString(): string }) => {
    record.push({ kind: 'openExternal', target: target.fsPath ?? target.toString() })
    return true
  },
}

/** `vscode.Uri` в миниатюре: хватит file-схемы, которую использует расширение. */
export const Uri = {
  file(p: string): { fsPath: string; scheme: string; toString(): string } {
    return {
      fsPath: p,
      scheme: 'file',
      toString: () => `file:///${p.replace(/\\/g, '/')}`,
    }
  },
}

export const commands = {
  registered: new Map<string, (...args: unknown[]) => unknown>(),
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    commands.registered.set(id, handler)
    record.push({ kind: 'command', id })
    return { dispose: () => commands.registered.delete(id) }
  },
  /**
   * Как настоящий хост: неизвестная команда отклоняется. На этом держится
   * проверка «view ещё не зарегистрирован → повторить в следующий тик».
   */
  executeCommand: async (id: string, ...args: unknown[]) => {
    record.push({ kind: 'execCommand', id, args })
    const handler = commands.registered.get(id)
    if (!handler) throw new Error(`command '${id}' not found`)
    return handler(...args)
  },
}

export const extensionUri = { fsPath: '/mock/extension' }
