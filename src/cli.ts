#!/usr/bin/env node
/**
 * ds-map CLI: dsmap run -- <harness command>
 * Поднимает сайдкар, запускает харнес, открывает окно справа.
 * dsmap doctor — проверка состояния.
 */

import { DaemonServer } from './daemon/server.js'
import { EventBus } from './daemon/bus.js'
import { SessionTailer } from './daemon/session.js'
import { runDoctor } from './doctor.js'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { tokenPath } from './shared/config.js'

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
    process.exit(await runDoctor(process.cwd()))
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
  console.log(`[ds-map] сайдкар запущен на 127.0.0.1:${port}, токен в ${tokenPath()}`)

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
  launchElectron(pids)

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function launchElectron(harnessPids: number[]): void {
  const electronDir = path.dirname(require.resolve('electron'))
  const electronPath = path.join(electronDir, 'dist', 'electron.exe')
  const mainPath = path.join(__dirname, 'ui', 'main.js')
  // Порт и токен не передаются через аргументы: в командной строке токен
  // прочитал бы любой перечислитель процессов. Окно берёт их из файлов сайдкара.
  const electronArgs = [mainPath]
  for (const pid of harnessPids) electronArgs.push(`--harness-pid=${pid}`)
  if (process.env.DSMAP_TITLE) electronArgs.push(`--harness-title=${process.env.DSMAP_TITLE}`)
  electronProc = spawn(electronPath, electronArgs, {
    // stdin — не для ввода, а для сигнала: когда этот процесс умирает даже
    // от taskkill /F, pipe закрывается, и панель видит EOF и гаснется сама.
    stdio: ['pipe', 'pipe', 'pipe'],
    // Owner-PID нужен панели и её наблюдателю: если этот процесс убили через
    // диспетчер задач (на Windows сигнал обработчик не доходит), окно всё равно
    // должно закрыться само и не остаться сиротой.
    env: { ...process.env, DSMAP_OWNER_PID: String(process.pid) },
  })
  electronProc.stdout?.on('data', (d) => process.stdout.write(d))
  electronProc.stderr?.on('data', (d) => process.stderr.write(d))
}

/** Гасит всё, что подняли. Повторный вызов безвреден. */
function shutdown(code = 0): void {
  killTree(harnessProc)
  harnessProc = null
  killTree(electronProc)
  electronProc = null
  tailer.stop()
  server.stop()
  process.exit(code)
}

/**
 * На Windows у ребёнка обычно есть обёртка: `.cmd`-лаунчер харнеса и `shell:true`
 * ставят над ним cmd.exe, а `kill()` снимает только её. Без `taskkill /T`
 * dsh и electron.exe переживают лаунчер и остаются висеть сиротами.
 */
function killTree(child: ReturnType<typeof spawn> | null): void {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // процесс уже мёртв
  }
}

// Смерть процесса по любой причине тоже убирает порт и токен: иначе следующее
// окно подключится к мёртвому порту и молча покажет пустую карту.
process.on('exit', () => {
  tailer.stop()
  server.stop()
})

main().catch((err) => {
  console.error('[ds-map] fatal:', err)
  shutdown(1)
})
