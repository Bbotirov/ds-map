/**
 * Приватность: только имена. Никогда содержимое.
 * Маппер падает тихо (fail-open) — любой сбой даёт станцию shell и метку unknown.
 */

// Вырезаем управляющие символы (поток не должен содержать промпты/содержимое файлов).
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g
const MAX = 48

export function clean(v: string): string {
  return v.replace(CTRL, '').slice(0, MAX)
}

/**
 * Метка файла — последние два сегмента пути.
 */
export function fileLabel(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return clean(parts.slice(-2).join('/'))
}

/**
 * Метка URL — только хост, без пути, логина и query.
 */
export function urlLabel(u: string): string {
  try {
    return clean(new URL(u).host)
  } catch {
    const scheme = u.split('://')[0]
    return clean(scheme && scheme.length < 12 ? scheme : 'url')
  }
}

/**
 * Метка шелл-команды — имя команды плюс подкоманда, если она bare-слово.
 * `git status` и `pnpm install` — это ещё имена, а `--pattern`, `./src/x.ts`
 * и `2>&1` — уже командная строка, её показывать нельзя (§7 правило 5).
 */
const SUBCOMMAND = /^[a-z][a-z0-9_-]{1,15}$/

export function commandLabel(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/)
  const first = baseName(tokens[0] ?? '')
  if (!first) return clean('unknown')
  const second = tokens[1] ?? ''
  return clean(SUBCOMMAND.test(second) ? `${first} ${second}` : first)
}

/** Путь к исполняемому файлу → голое имя в нижнем регистре и без `.exe`. */
function baseName(token: string): string {
  return token.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? ''
}

/**
 * Обёртка fail-open: любой вызов маппера обёрнут в safe.
 * Упавший маппер даёт станцию shell и метку unknown, а не исключение наверх.
 */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (err) {
    console.error('[ds-map] mapper failed', err instanceof Error ? err.message : 'unknown')
    return fallback
  }
}
