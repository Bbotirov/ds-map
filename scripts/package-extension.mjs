/**
 * Сборка .vsix: компилирует расширение, растеризует иконку, складывает
 * содержимое в staging и вызывает @vscode/vsce. Никакой сети — только локальные
 * бинарники из node_modules.
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ext = path.join(root, 'extension')
const stage = path.join(root, 'build', 'extension')

function run(cmd, args, cwd) {
  // Без shell:true: путь к node.exe содержит пробел («C:\Program Files»), и
  // оболочка разрезает его пополам.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[package-extension] ${cmd} ${args.join(' ')} завершился с кодом ${r.status}`)
    process.exit(r.status ?? 1)
  }
}

function step(title) {
  console.log(`[package-extension] ${title}`)
}

step('сборка TypeScript расширения')
run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', ext], root)

step('иконка 128×128 из SVG')
const { Resvg } = require('@resvg/resvg-js')
const svg = fs.readFileSync(path.join(ext, 'images', 'icon.svg'), 'utf8')
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 } }).render().asPng()

step('staging')
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(path.join(stage, 'images'), { recursive: true })
fs.mkdirSync(path.join(stage, 'out'), { recursive: true })
fs.cpSync(path.join(ext, 'out'), path.join(stage, 'out'), { recursive: true })
// WS-клиент для host-а расширения. Глобального WebSocket в Electron старых
// VS Code нет, поэтому `ws` тащим в .vsix; `dereference` обязателен — pnpm
// держит пакет за симлинком в .pnpm-дереве.
fs.mkdirSync(path.join(stage, 'node_modules'), { recursive: true })
fs.cpSync(path.join(root, 'node_modules', 'ws'), path.join(stage, 'node_modules', 'ws'), {
  recursive: true,
  dereference: true,
})
fs.copyFileSync(path.join(ext, 'package.json'), path.join(stage, 'package.json'))
fs.copyFileSync(path.join(ext, '.vscodeignore'), path.join(stage, '.vscodeignore'))
fs.writeFileSync(path.join(stage, 'images', 'icon.png'), png)
for (const file of ['README.md', 'CHANGELOG.md']) {
  const src = path.join(ext, file)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, file))
}
const license = path.join(root, 'LICENSE')
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(stage, 'LICENSE'))

step('vsce package')
// pnpm держит пакеты в .pnpm-дереве, поэтому путь к bin берём из package.json
// самой vsce, а не из node_modules/@vscode/vsce напрямую.
const vsceManifest = require.resolve('@vscode/vsce/package.json')
const vscePkg = JSON.parse(fs.readFileSync(vsceManifest, 'utf8'))
const vsceBin = typeof vscePkg.bin === 'string' ? vscePkg.bin : vscePkg.bin.vsce
const vsce = path.resolve(path.dirname(vsceManifest), vsceBin)
const version = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8')).version
fs.mkdirSync(path.join(root, 'build'), { recursive: true })
run(process.execPath, [vsce, 'package', '--allow-missing-repository', '--out', path.join(root, 'build', `ds-map-${version}.vsix`)], stage)

const vsix = path.join(root, 'build', `ds-map-${version}.vsix`)
console.log(`[package-extension] готово: ${vsix} (${fs.statSync(vsix).size} байт)`)
