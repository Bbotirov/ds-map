/**
 * ds-map как расширение VS Code: панель — отдельное окно Electron, поэтому
 * задача расширения — поднять харнес вместе с лаунчером в терминале, показать
 * диагностику и корректно всё погасить. Содержимое промптов расширение не
 * читает и не передаёт (§12).
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as vscode from 'vscode'

import { findCliPath, type CliLookup } from './cli-lookup.js'

const CTRL_C = '\u0003'

let terminal: vscode.Terminal | undefined
let output: vscode.LogOutputChannel
let status: vscode.StatusBarItem

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('ds-map', { log: true })
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = 'dsMap.doctor'
  renderStatus(false)
  context.subscriptions.push(output, status)

  context.subscriptions.push(
    vscode.commands.registerCommand('dsMap.start', () => start(context)),
    vscode.commands.registerCommand('dsMap.stop', () => stop()),
    vscode.commands.registerCommand('dsMap.doctor', () => doctor(context)),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return
      terminal = undefined
      renderStatus(false)
    }),
  )
}

export function deactivate(): void {
  // Окно панели живёт от лаунчера: умер терминал — умрёт и оно, сирот не оставляем.
  terminal = undefined
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
      'ds-map не найден: нужна собранный пакет с dist/cli.js (pnpm install && pnpm build).',
      pick,
    )
    if (choice === pick) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'dsMap.cliPath')
    }
    return
  }

  const harness = config().get<string>('harnessCommand', 'dsh')
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  terminal = vscode.window.createTerminal({ name: 'ds-map', cwd })
  // Кавычки — как в cmd: аргументы харнеса передаются как есть, экранирование
  // промпта остаётся на стороне пользователя.
  terminal.sendText(`node "${cli}" run -- ${harness}`)
  terminal.show()
  renderStatus(true)
  output.info(`панель поднята: ${cli} run -- ${harness}`)
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
  output.info('остановка: отправлен Ctrl-C')
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
