/**
 * Приватность: только имена. Никогда содержимое.
 * Маппер падает тихо (fail-open) — любой сбой даёт станцию shell и метку unknown.
 */

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
 * Метка шелл-команды — только имя команды.
 */
export function commandLabel(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? ''
  return clean(first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
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
