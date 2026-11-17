#!/usr/bin/env node
/**
 * ds-map CLI: dsmap run -- <harness command>
 * Поднимает сайдкар, запускает харнес, открывает окно справа.
 */

import { DaemonServer } from './daemon/server.js'
import { EventBus } from './daemon/bus.js'
import { SessionTailer } from './daemon/session.js'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'

const bus = new EventBus()
const server = new DaemonServer(bus)
const tailer = new SessionTailer(bus)

let harnessProc: ReturnType<typeof spawn> | null = null
let electronProc: ReturnType<typeof spawn> | null = null

async function main() {
  const args = process.argv.slice(2)
  const runIdx = args.indexOf('run')
  if (runIdx === -1) {
    console.error('Использование: dsmap run -- <команда харнеса>')
    process.exit(1)
  }

  const dashIdx = args.indexOf('--', runIdx + 1)
  const harnessArgs = dashIdx === -1 ? args.slice(runIdx + 1) : args.slice(dashIdx + 1)
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

  // 4. Запускаем哈рес
  harnessProc = spawn(harnessCmd, harnessCmdArgs, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  harnessProc.stdout?.on('data', (d) => process.stdout.write(d))
  harnessProc.stderr?.on('data', (d) => process.stderr.write(d))

  harnessProc.on('exit', (code) => {
    console.log(`[ds-map] харнес завершён с кодом ${code}`)
    shutdown()
  })

  // 5. Ждём появления порта и запускаем окно Electron
  await new Promise((r) => setTimeout(r, 1500)) // даём сайдкару время запуститься
  launchElectron(port, server.getToken()!, harnessProc.pid)

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function launchElectron(port: number, token: string, harnessPid?: number): void {
  const electronPath = require.resolve('electron')
  const mainPath = path.join(__dirname, 'ui', 'main.js')
  const electronArgs = [mainPath, `--port=${port}`, `--token=${token}`]
  if (harnessPid) electronArgs.push(`--harness-pid=${harnessPid}`)
  electronProc = spawn(electronPath, electronArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  electronProc.stdout?.on('data', (d) => process.stdout.write(d))
  electronProc.stderr?.on('data', (d) => process.stderr.write(d))
}

function shutdown(): void {
  if (harnessProc) {
    try { harnessProc.kill('SIGTERM') } catch {}
    harnessProc = null
  }
  if (electronProc) {
    try { electronProc.kill('SIGTERM') } catch {}
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
