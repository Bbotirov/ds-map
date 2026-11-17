#!/usr/bin/env node
/**
 * dsmap doctor — проверка состояния ds-map.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const TOKEN_PATH = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh', 'dsmap-token.txt')
const PORT_PATH = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh', 'dsmap-port.txt')
const SESSIONS_ROOT = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh', 'sessions')

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  let ok = true

  // 1. Токен
  const tokenExists = fs.existsSync(TOKEN_PATH)
  check('Токен сайдкара', tokenExists, TOKEN_PATH)

  // 2. Порт
  const portExists = fs.existsSync(PORT_PATH)
  check('Порт сайдкара', portExists, PORT_PATH)

  // 3. Сессии
  const sessionsExist = fs.existsSync(SESSIONS_ROOT)
  check('Каталог сессий DSH', sessionsExist, SESSIONS_ROOT)

  // 4. node_modules
  const nmExists = fs.existsSync(path.join(process.cwd(), 'node_modules'))
  check('Зависимости установлены', nmExists)

  // 5. Сборка
  const distExists = fs.existsSync(path.join(process.cwd(), 'dist'))
  check('Проект собран', distExists, 'запустите pnpm build')

  if (!ok) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
