/**
 * ds-map как расширение VS Code.
 *
 * Карту показывают два носителя: вкладка «Карта работы ds-map» во второй
 * боковой панели (webview, события читает host) и отдельное окно Electron для
 * работы вне редактора. Здесь же — запуск харнеса через лаунчер, диагностика и
 * автооткрытие вкладки на новую живую сессию. Содержимое промптов, сырые
 * командные строки и заголовки сессий расширение не показывает (§12).
 */

import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

import { AutoOpen } from './auto-open.js'
import { findCliPath, type CliLookup } from './cli-lookup.js'
import { clearStaleEndpoint, dshHome, sessionsRoot } from './endpoint.js'
import { renderDocument } from './map-html.js'
import { FOCUS_COMMAND, MapViewProvider, VIEW_ID } from './map-view.js'
import { isLive, listSessions, relativeTime, type SessionEntry } from './sessions.js'

/** Ctrl-C для PTY: лаунчер сам гасит харнес, панель и сайдкар. */
const CTRL_C = String.fromCharCode(3)
/** Опрос живых сессий: чаще не нужно, харнес пишет файл на каждый шаг. */
const AUTOPEN_MS = 5_000

let terminal: vscode.Terminal | undefined
let output: vscode.LogOutputChannel
let status: vscode.StatusBarItem
let provider: MapViewProvider
const autoOpen = new AutoOpen()
let pollTimer: ReturnType<typeof setInterval> | null = null

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('ds-map', { log: true })
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = 'dsMap.doctor'
  renderStatus(false)
  context.subscriptions.push(output, status)

  provider = new MapViewProvider(context, { log: (message) => safeLog(message) })
  // Панель скрыли — значит, в этой сессии больше не навязываемся.
  provider.onDismissed(() => autoOpen.noteDismissed(liveSessionId()))

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsMap.start', () => start(context)),
    vscode.commands.registerCommand('dsMap.stop', () => stop()),
    vscode.commands.registerCommand('dsMap.doctor', () => doctor(context)),
    vscode.commands.registerCommand('dsMap.openMap', () => openMap()),
    vscode.commands.registerCommand('dsMap.pickSession', () => pickSession()),
    vscode.commands.registerCommand('dsMap.copySnapshot', () => copySnapshot()),
    vscode.commands.registerCommand('dsMap.browserMap', () => browserMap()),
    vscode.commands.registerCommand('dsMap.replayLast', () => replayLast()),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return
      terminal = undefined
      renderStatus(false)
      // Терминал мог умереть без Ctrl-C: закрыли вручную, перезагрузка окна.
      // Тогда лаунчер свой cleanup не успевает сделать и в `~/.dsh` остаётся
      // порт и токен мёртвого сайдкара.
      void clearStaleEndpoint().then(
        (removed) => {
          if (removed) safeLog('убраны порт и токен мёртвого сайдкара')
        },
        () => safeLog('уборка эндпоинта не выполнена'),
      )
    }),
  )

  startAutoOpen()
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  // Окно панели живёт от лаунчера: умер терминал — умрёт и оно, сирот не оставляем.
  terminal = undefined
}

/** Ни одна ветка расширения не имеет права показать exception в редакторе. */
function guard(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    safeLog(`${label}: ${err instanceof Error ? err.name : 'unknown'}`)
  }
}

function safeLog(message: string): void {
  try {
    output?.info(message)
  } catch {
    // канал логов мог быть закрыт вместе с окном расширения
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('dsMap')
}

function cliPath(context: vscode.ExtensionContext): string | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
  const lookup: CliLookup = {
    setting: config().get<string>('cliPath', ''),
    env: process.env,
    workspaceFolders: folders,
    extensionPath: context.extensionPath,
    home: os.homedir(),
    platform: process.platform,
    exists: (p) => fs.existsSync(p),
  }
  return findCliPath(lookup)
}

async function start(context: vscode.ExtensionContext): Promise<void> {
  if (terminal) {
    terminal.show()
    return
  }
  const cli = cliPath(context)
  if (!cli) {
    const pick = 'Указать путь к dsmap'
    const choice = await vscode.window.showErrorMessage(
      'ds-map не найден: нужен собранный пакет с dist/cli.js (pnpm install && pnpm build).',
      pick,
    )
    if (choice === pick) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'dsMap.cliPath')
    }
    return
  }

  // `dsh` без профиля сразу выходит с ошибкой, поэтому дефолт — долгий профиль.
  const harness = config().get<string>('harnessCommand', 'dsh --profile web')
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  terminal = vscode.window.createTerminal({ name: 'ds-map', cwd })
  // Кавычки — как в cmd: аргументы харнеса передаются как есть, экранирование
  // промпта остаётся на стороне пользователя.
  terminal.sendText(`node "${cli}" run -- ${harness}`)
  terminal.show()
  renderStatus(true)
  safeLog(`панель поднята: ${cli} run -- ${harness}`)
}

function stop(): void {
  if (!terminal) {
    renderStatus(false)
    return
  }
  // Сначала честный Ctrl-C в PTY: лаунчер сам гасит харнес, панель и сайдкар.
  terminal.sendText(CTRL_C)
  const closing = terminal
  setTimeout(() => {
    // Если через 2 с терминал всё ещё жив — закрываем его принудительно.
    if (terminal === closing) closing.dispose()
  }, 2_000)
  renderStatus(false)
  safeLog('остановка: отправлен Ctrl-C')
}

function doctor(context: vscode.ExtensionContext): void {
  const cli = cliPath(context)
  if (!cli) {
    output.error('dsmap не найден — проверьте настройку dsMap.cliPath')
    output.show()
    return
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  const child = spawn(process.execPath, [cli, 'doctor'], { cwd, windowsHide: true })
  child.stdout.on('data', (d: Buffer) => output.info(d.toString().trimEnd()))
  child.stderr.on('data', (d: Buffer) => output.error(d.toString().trimEnd()))
  child.on('exit', (code) => {
    output.info(`doctor завершился с кодом ${code}`)
    renderStatus(!!terminal)
  })
  output.show()
}

function renderStatus(running: boolean): void {
  status.text = running ? '$(radiowave) ds-map: работает' : '$(circle-outline) ds-map: выключено'
  status.tooltip = running
    ? 'Панель ds-map поднята из этого терминала. Ctrl-C в терминале гасит всё.'
    : 'Запустить харнес вместе с панелью ds-map'
  status.command = running ? 'dsMap.stop' : 'dsMap.start'
  status.show()
}

// --- карта ---

/** Показ вкладки — тот же путь, что и у «открыть карту» из палитры. */
function openMap(): void {
  guard('открыть карту', () => {
    void vscode.commands
      .executeCommand(FOCUS_COMMAND)
      .then(undefined, () => safeLog(`провайдер ещё не поднялся: ${FOCUS_COMMAND}`))
  })
}

/**
 * Выбор сессии: в подписи только id каталога и время записи. Файл сессии не
 * читается — там `session/title` (текст из разговора) и `job/registered.label`
 * (сырая командная строка), а §12 разрешает наружу только имена.
 */
async function pickSession(): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!cwd) {
    void vscode.window.showInformationMessage('ds-map: нет открытой папки — выбирать сессию не из чего.')
    return
  }
  let entries: SessionEntry[] = []
  try {
    entries = listSessions(sessionsRoot(dshHome()), cwd)
  } catch (err) {
    safeLog(`список сессий не собран: ${err instanceof Error ? err.name : 'unknown'}`)
  }
  if (!entries.length) {
    void vscode.window.showInformationMessage('ds-map: записанных сессий для этого каталога нет.')
    return
  }
  const now = Date.now()
  const items = entries.map((entry) => ({
    label: entry.id,
    description: relativeTime(entry.mtimeMs, now),
    entry,
  }))
  const picked = await vscode.window.showQuickPick(items, {
    title: 'ds-map: выбрать сессию',
    placeHolder: 'Только идентификатор и время записи',
    ignoreFocusOut: false,
  })
  if (!picked) return
  guard('выбор сессии', () => provider.pickSession(picked.entry.id))
  safeLog(`выбрана сессия ${picked.entry.id}`)
}

function copySnapshot(): void {
  guard('копирование снимка', () => {
    void vscode.env.clipboard.writeText(JSON.stringify(provider.snapshot(), null, 2))
    void vscode.window.showInformationMessage('ds-map: снимок карты скопирован в буфер обмена.')
  })
}

/**
 * Карта в браузере — статичный снимок: сайдкар обслуживает только токенized
 * HTTP/WS и не отдаёт страницу, поэтому в файл кладётся уже обезвреженная
 * проекция. Токена в файле нет и быть не может.
 */
function browserMap(): void {
  guard('карта в браузере', () => {
    const nonce = crypto.randomBytes(16).toString('base64')
    const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join('; ')
    const html = renderDocument({ csp, nonce, snapshot: provider.snapshot() })
    const file = path.join(os.tmpdir(), `ds-map-${process.pid}.html`)
    fs.writeFileSync(file, html, { mode: 0o600 })
    void vscode.env.openExternal(vscode.Uri.file(file))
    safeLog(`снимок открыт в браузере: ${path.basename(file)}`)
  })
}

function replayLast(): void {
  guard('replay', () => provider.replay())
}

/** Живая сессия каталога: та, в которую харнес писал меньше `LIVE_MS` назад. */
function liveSessionId(): string | null {
  try {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!cwd) return null
    const newest = listSessions(sessionsRoot(dshHome()), cwd)[0]
    return isLive(newest, Date.now()) ? newest.id : null
  } catch (err) {
    safeLog(`список сессий не прочитан: ${err instanceof Error ? err.name : 'unknown'}`)
    return null
  }
}

/**
 * Автооткрытие: не чаще одного раза на живую сессию, и никогда — если панель
 * скрыли сами. Таймер живёт всё время работы расширения; любой сбой тихо
 * уходит в Output, а повтор попытки делает следующий тик.
 */
function startAutoOpen(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => tickAutoOpen(), AUTOPEN_MS)
  pollTimer.unref?.()
  tickAutoOpen()
}

function tickAutoOpen(): void {
  guard('автооткрытие', () => {
    if (!config().get<boolean>('autoOpen', true)) return
    if (!autoOpen.shouldOpen(liveSessionId())) return
    void vscode.commands.executeCommand(FOCUS_COMMAND).then(
      () => autoOpen.markOpened(),
      // Команды фокуса ещё нет (view не зарегистрирован) — не считаем попытку состоявшейся.
      () => autoOpen.release(),
    )
  })
}



