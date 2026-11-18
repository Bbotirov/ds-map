// tsc компилирует только .ts — статические ассеты Electron-окна копируем руками.
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/ui', { recursive: true })
for (const file of ['index.html', 'window-watcher.ps1', 'preload.cjs']) {
  cpSync(`src/ui/${file}`, `dist/ui/${file}`)
}
