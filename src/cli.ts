#!/usr/bin/env node
/**
 * ds-map CLI: dsmap run -- <harness command>
 * Поднимает сайдкар, запускает харнес, открывает окно справа.
 * dsmap doctor — проверка состояния.
 */

import { DaemonServer } from './daemon/server.js'
import { EventBus } from './daemon/bus.js'
import { SessionTailer } from './daemon/session.js'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const bus = new EventBus()
const server = new DaemonServer(bus)
const tailer = new SessionTailer(bus)

// Подписка на события для отображения в консоли (M2: live console feed)
bus.subscribe((e) => {
  process.stdout.write(`[${new Date(e.ts).toISOString()}] ${e.t}\n`)
})

let harnessProc: ReturnType<typeof spawn> | null = null
let electronProc: ReturnType<typeof spawn> | null = null

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (cmd === 'doctor') {
    runDoctor()
    return
  }

  if (cmd !== 'run') {
    console.error('Использование: dsmap run -- <команда харнеса>')
    console.error('       dsmap doctor')
    process.exit(1)
  }

  const dashIdx = args.indexOf('--', 1)
  const harnessArgs = dashIdx === -1 ? args.slice(1) : args.slice(dashIdx + 1)
  const harnessCmd = harnessArgs[0]
  const harnessCmdArgs = harnessArgs.slice(1)

  if (!harnessCmd) {
    console.error('Не указана команда харнеса')
    process.exit(1)
  }

  // 1. Поднимаем сайдкар (локальный WS сервер)
  const port = await server.start()
  console.log(`[ds-map] сайдкар запущен на порту ${port}, токен в ${path.join(os.homedir(), '.dsh', 'dsmap-token.txt')}`)

  // 2. Определяем cwd для поиска сессии
  const cwd = process.cwd()

  // 3. Запускаем хвост сессии (ищет последнюю сессию для cwd)
  tailer.start(cwd)

  // 4. Запускаем харнес
  // На Windows shell-скрипты (.ps1, .cmd) требуют shell:true.
  // TUI нужен inherit stdio, иначе харнес не получит терминал.
  const isWin = process.platform === 'win32'
  const needsShell = isWin && !/\.exe$/i.test(harnessCmd)
  harnessProc = spawn(harnessCmd, harnessCmdArgs, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    shell: needsShell,
  })

  harnessProc.on('exit', (code) => {
    console.log(`[ds-map] харнес завершён с кодом ${code}`)
    shutdown()
  })

  // 5. Ждём появления порта и запускаем окно Electron
  await new Promise((r) => setTimeout(r, 1_500))
  // У `dsh` в терминале своего окна нет, поэтому пристёгиваемся к терминалу.
  // PID харнеса добавляем на случай GUI-профиля (web/acp) и .cmd-обёрток:
  // наблюдатель сам расширяет список потомками.
  const pids = [process.ppid, harnessProc.pid].filter((p): p is number => typeof p === 'number' && p > 0)
  launchElectron(port, server.getToken()!, pids)

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function runDoctor(): void {
  const TOKEN_PATH = path.join(os.homedir(), '.dsh', 'dsmap-token.txt')
  const PORT_PATH = path.join(os.homedir(), '.dsh', 'dsmap-port.txt')
  const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

  const failed: string[] = []
  function check(name: string, passed: boolean, detail?: string): void {
    console.log(`${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!passed) failed.push(name)
  }

  check('Токен сайдкара', fs.existsSync(TOKEN_PATH), TOKEN_PATH)
  check('Порт сайдкара', fs.existsSync(PORT_PATH), PORT_PATH)
  check('Каталог сессий DSH', fs.existsSync(SESSIONS_ROOT), SESSIONS_ROOT)
  check('Зависимости установлены', fs.existsSync(path.join(process.cwd(), 'node_modules')))
  check('Проект собран', fs.existsSync(path.join(process.cwd(), 'dist')), 'запустите pnpm build')

  if (failed.length > 0) process.exit(1)
}

function launchElectron(port: number, token: string, harnessPids: number[]): void {
  const electronDir = path.dirname(require.resolve('electron'))
  const electronPath = path.join(electronDir, 'dist', 'electron.exe')
  const mainPath = path.join(__dirname, 'ui', 'main.js')
  const electronArgs = [mainPath, `--port=${port}`, `--token=${token}`]
  for (const pid of harnessPids) electronArgs.push(`--harness-pid=${pid}`)
  if (process.env.DSMAP_TITLE) electronArgs.push(`--harness-title=${process.env.DSMAP_TITLE}`)
  electronProc = spawn(electronPath, electronArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  electronProc.stdout?.on('data', (d) => process.stdout.write(d))
  electronProc.stderr?.on('data', (d) => process.stderr.write(d))
}

function shutdown(): void {
  if (harnessProc) {
    try { harnessProc.kill('SIGTERM') } catch { /* ignored */ }
    harnessProc = null
  }
  if (electronProc) {
    try { electronProc.kill('SIGTERM') } catch { /* ignored */ }
    electronProc = null
  }
  tailer.stop()
  server.stop()
  process.exit(0)
}

main().catch((err) => {
  console.error('[ds-map] fatal:', err)
  shutdown()
  process.exit(1)
})
