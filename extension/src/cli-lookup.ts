/**
 * Поиск собранного CLI ds-map. Отдельный модуль без зависимости от `vscode`,
 * чтобы выбор пути можно было проверить тестом, а не только в интерфейсе.
 */

import * as path from 'node:path'

export interface CliLookup {
  /** Значение настройки `dsMap.cliPath`. */
  setting: string
  env: Record<string, string | undefined>
  workspaceFolders: string[]
  extensionPath: string
  home: string
  platform: string
  exists: (p: string) => boolean
}

/** Порядок поиска: явный настройкой → DSMAP_BIN → открытый проект → глобальная установка. */
export function findCliPath(lookup: CliLookup): string | undefined {
  for (const candidate of cliCandidates(lookup)) {
    if (candidate && lookup.exists(candidate)) return candidate
  }
  return undefined
}

export function cliCandidates(lookup: CliLookup): string[] {
  const out: string[] = []
  const setting = lookup.setting.trim()
  if (setting) out.push(expand(setting, lookup))

  if (lookup.env.DSMAP_BIN) out.push(expand(lookup.env.DSMAP_BIN, lookup))

  for (const folder of lookup.workspaceFolders) {
    out.push(path.join(folder, 'dist', 'cli.js'))
  }

  // Расширение, собранное вместе с пакетом, носит CLI при себе.
  out.push(path.join(lookup.extensionPath, 'bundled', 'dist', 'cli.js'))

  // Глобальная установка: `npm i -g ds-map` / `pnpm add -g ds-map`.
  const npmPrefix = lookup.platform === 'win32'
    ? lookup.env.APPDATA
      ? path.join(lookup.env.APPDATA, 'npm', 'node_modules')
      : undefined
    : lookup.env.npm_config_prefix
      ? path.join(lookup.env.npm_config_prefix, 'lib', 'node_modules')
      : '/usr/local/lib/node_modules'
  if (npmPrefix) out.push(path.join(npmPrefix, 'ds-map', 'dist', 'cli.js'))

  out.push(path.join(lookup.home, '.dsh', 'dsmap', 'dist', 'cli.js'))
  return out
}

/** Поддержка `~`, `${workspaceFolder}` и `${userHome}` в настройке. */
export function expand(input: string, lookup: Pick<CliLookup, 'workspaceFolders' | 'home'>): string {
  const folder = lookup.workspaceFolders[0] ?? ''
  return input
    .replace(/\$\{workspaceFolder\}/g, folder)
    .replace(/\$\{userHome\}/g, lookup.home)
    .replace(/^~(?=[/\\]|$)/, lookup.home)
}
