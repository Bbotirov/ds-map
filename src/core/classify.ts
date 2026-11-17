/**
 * Классификатор: вызов инструмента / шелл-команда → станция карты.
 *
 * Главное правило: классифицируем по ИМЕНИ команды, а не по тому, что она делает.
 * Чистые функции, без побочных эффектов.
 */

export type Station =
  | 'you'
  | 'model'
  | 'memory'
  | 'files'
  | 'shell'
  | 'web'
  | 'browser'
  | 'agents'
  | 'skills'
  | 'hooks'

const FILES = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'ag', 'ack',
  'mv', 'cp', 'rm', 'mkdir', 'touch', 'ln',
  'sed', 'awk', 'tee', 'truncate',
  'ls', 'stat', 'file', 'wc', 'diff', 'find',
  'get-content', 'gc', 'select-string', 'sls',
  'copy-item', 'move-item', 'remove-item',
])

const WEB = new Set([
  'curl', 'wget', 'http',
  'gh', 'glab', 'ssh', 'scp', 'rsync',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
])

const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'timeout', 'nohup', 'xargs', 'command',
  'nice', 'ionice', 'time', 'stdbuf', 'exec', 'watch', 'parallel',
])

function basename(token: string): string {
  const clean = token.replace(/^["']|["']$/g, '')
  const parts = clean.split(/[\\/]/)
  return (parts[parts.length - 1] ?? clean).toLowerCase().replace(/\.exe$/, '')
}

function firstWord(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue }   // присваивание
    if (t.startsWith('-')) { i++; continue }                     // опция обёртки
    if (/^\d+$/.test(t)) { i++; continue }                       // числовой аргумент (timeout 10 curl)
    const name = basename(t)
    if (WRAPPERS.has(name)) {
      i++
      // Пропускаем опции и их значения после обёртки (sudo -u root cat → cat)
      while (i < tokens.length) {
        const nt = tokens[i] ?? ''
        if (nt.startsWith('-')) { i++; if (i < tokens.length) i++ } // опция + значение
        else break
      }
      continue
    }
    return name
  }
  return ''
}

function classifySegment(s: string): Station {
  const name = firstWord(s)
  if (name === '') return 'shell'
  if (name === 'npx') return /\s-y\b/.test(s) ? 'web' : 'shell'
  if (name === 'git') return /\b(push|pull|fetch|clone)\b/.test(s) ? 'web' : 'shell'
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') return /\b(install|add|i)\b/.test(s) ? 'web' : 'shell'
  if (name === 'docker') return /\b(pull|push)\b/.test(s) ? 'web' : 'shell'
  if (WEB.has(name)) return 'web'
  if (FILES.has(name)) return 'files'
  return 'shell'
}

/**
 * Классифицировать шелл-команду.
 * Правило приоритета: web > files > shell.
 */
export function classifyShell(cmd: string): Station {
  // Разбираем подстановки $(...) и обратные кавычки
  const inner = [...cmd.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? '')

  // Разбиваем на сегменты по пайпам, &&, ||, ;
  // Пустые сегменты (от \; в find -exec) отбрасываются
  const segments = [cmd, ...inner].flatMap((s) =>
    s.split(/\|\||&&|\||;/).filter(Boolean)
  )

  const stations = segments.map(classifySegment)

  if (stations.includes('web')) return 'web'
  if (stations.length > 0 && stations.every((s) => s === 'files')) return 'files'
  return 'shell'
}

export function classifyTool(name: string): Station {
  const n = name.toLowerCase()

  // DSH-специфичные инструменты — точные совпадения и префиксы
  if (n === 'ask_user_question' || n.startsWith('ask_')) return 'agents'
  if (n === 'create_goal' || n === 'update_goal') return 'skills'
  if (n === 'todo_write' || n.startsWith('todo_')) return 'skills'
  if (n === 'working-directory:current') return 'files'
  if (n === 'time-context') return 'memory'

  // read_file, write_file, edit, grep, glob и т.п. → files
  if (FILES.has(n)) return 'files'
  if (WEB.has(n)) return 'web'
  if (n.includes('file') || n.includes('read') || n.includes('write') || n.includes('edit') || n.includes('grep') || n.includes('glob')) return 'files'
  if (n.includes('web') || n.includes('fetch') || n.includes('search') || n.includes('http')) return 'web'
  if (n.includes('agent') || n.includes('subagent')) return 'agents'
  if (n.includes('skill') || n.includes('tool')) return 'skills'
  if (n.includes('hook')) return 'hooks'
  if (n.includes('memory')) return 'memory'
  if (n.includes('bash') || n.includes('shell') || n.includes('command')) return 'shell'
  if (n.includes('browser')) return 'browser'
  return 'shell'
}
