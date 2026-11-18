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
  'get-content', 'gc', 'type', 'select-string', 'sls',
  'copy-item', 'move-item', 'remove-item',
])

const WEB = new Set([
  'curl', 'wget', 'http', 'httpie',
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
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue }
    if (t.startsWith('-')) { i++; continue }
    if (/^\d+$/.test(t)) { i++; continue }
    const name = basename(t)
    if (WRAPPERS.has(name)) {
      i++
      while (i < tokens.length) {
        const nt = tokens[i] ?? ''
        if (nt.startsWith('-')) { i++; if (i < tokens.length) i++ }
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
  const inner = [...cmd.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? '')

  const segments = [cmd, ...inner].flatMap((s) =>
    s.split(/\|\||&&|\||;/).filter(Boolean)
  )

  const stations = segments.map(classifySegment)

  if (stations.includes('web')) return 'web'
  if (stations.length > 0 && stations.every((s) => s === 'files')) return 'files'
  return 'shell'
}

/**
 * Имена инструментов dsh — список закрытый: он снят с реальных логов сессий
 * (session.v4.jsonl в папке сессий). Поэтому точная таблица, а не поиск
 * подстрок: порядок проверок становится предсказуемым и не зависит от того,
 * какое слово случайным образом встретилось в имени раньше.
 */
const DSH_TOOLS = new Map<string, Station>([
  ['read', 'files'],
  ['write', 'files'],
  ['edit', 'files'],
  ['glob', 'files'],
  ['grep', 'files'],
  ['pwsh', 'shell'],
  ['working_directory', 'shell'],
  ['todo_write', 'you'],
  ['create_goal', 'you'],
  ['get_goal', 'you'],
  ['update_goal', 'you'],
  ['ask_user_question', 'you'],
  ['subagent', 'agents'],
  ['subagent_fork', 'agents'],
  ['list_agents', 'agents'],
  ['send_message', 'agents'],
  ['job_list', 'agents'],
  ['job_output', 'agents'],
  ['skill', 'skills'],
])

// Станция этих инструментов целиком определяется содержимым команды,
// поэтому вызывающий код передаёт второй аргумент; без него остаётся shell.
const SHELL_TOOLS = new Set([
  'pwsh', 'bash', 'shell', 'powershell', 'terminal',
  'run_command', 'exec_command', 'execute_command',
])

const MCP_BROWSER_SERVERS = new Set([
  'playwright', 'puppeteer', 'selenium', 'chrome', 'chromedevtools',
  'browser', 'browserbase', 'browseruse', 'browserusemcp',
])

// agent_bus — единственный сервер, чьи тулки разносятся по разным станциям,
// поэтому для него разбираем и имя тулки, а не только имя сервера.
const AGENT_BUS_TOOLS = new Map<string, Station>([
  ['browse', 'web'],
  ['history', 'memory'],
  ['agents_list', 'agents'],
  ['ask', 'agents'],
  ['ask_parallel', 'agents'],
  ['panel', 'agents'],
  ['ask_model', 'agents'],
])

function classifyMcp(n: string): Station | undefined {
  if (!n.startsWith('mcp__')) return undefined
  const rest = n.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  const server = (sep < 0 ? rest : rest.slice(0, sep)).replace(/[-_]+/g, '')
  const tool = sep < 0 ? '' : rest.slice(sep + 2)

  if (MCP_BROWSER_SERVERS.has(server) || tool.startsWith('browser_')) return 'browser'
  if (server === 'agentbus') {
    const hit = AGENT_BUS_TOOLS.get(tool)
    if (hit !== undefined) return hit
  }
  return 'web'
}

/**
 * Порядок наборов фиксирован: от узкой станции к широкой. Без него
 * `memory_search` и `web_search` спорили бы за одно слово `search`.
 */
const TOKEN_STATIONS: ReadonlyArray<readonly [Station, Set<string>]> = [
  ['browser', new Set(['browser', 'playwright', 'puppeteer', 'selenium', 'chrome', 'navigate'])],
  ['memory', new Set(['memory', 'remember', 'recall', 'knowledge', 'note', 'notes'])],
  ['hooks', new Set(['hook', 'hooks', 'permission', 'approval', 'deny', 'pretooluse', 'posttooluse'])],
  ['agents', new Set(['agent', 'agents', 'subagent', 'subagents', 'task', 'tasks', 'team', 'swarm', 'delegate', 'job', 'jobs', 'spawn', 'fork'])],
  ['skills', new Set(['skill', 'skills', 'tool', 'tools', 'plugin', 'plugins', 'marketplace', 'catalog'])],
  ['you', new Set(['you', 'user', 'question', 'plan', 'goal', 'todo', 'prompt', 'message', 'messages'])],
  ['model', new Set(['model', 'llm', 'chat', 'completion', 'compact', 'compaction'])],
  ['files', new Set(['file', 'files', 'fs', 'code', 'dir', 'directory', 'folder', 'folders', 'workspace', 'content', 'contents', 'path', 'read', 'write', 'edit', 'patch', 'append', 'prepend', 'replace', 'grep', 'rg', 'glob', 'sed', 'awk', 'mv', 'cp', 'rm', 'mkdir', 'touch', 'ls', 'diff', 'stat'])],
  ['web', new Set(['web', 'http', 'https', 'httpie', 'url', 'fetch', 'search', 'browse', 'network', 'download', 'upload', 'curl', 'wget', 'mcp'])],
  ['shell', new Set(['shell', 'bash', 'zsh', 'powershell', 'pwsh', 'terminal', 'exec', 'command', 'commands', 'run', 'script', 'cmd'])],
]

function classifyByTokens(n: string): Station {
  const tokens = n.split(/[^a-z0-9]+/).filter(Boolean)
  for (const [station, keywords] of TOKEN_STATIONS) {
    if (tokens.some((t) => keywords.has(t))) return station
  }
  // Незнакомое имя — это shell, а не исключение: маппер обязан падать тихо.
  return 'shell'
}

/**
 * Станция по имени инструмента.
 * `command` — необязательное содержимое шелл-команды: только оно позволяет
 * различить `pwsh` «читает файл» и `pwsh` «ходит в сеть».
 */
export function classifyTool(name: string, command?: string): Station {
  const n = name.trim().toLowerCase()
  if (n === '') return 'shell'

  if (SHELL_TOOLS.has(n) && command !== undefined && command.trim() !== '') {
    return classifyShell(command)
  }

  const exact = DSH_TOOLS.get(n)
  if (exact !== undefined) return exact

  const mcp = classifyMcp(n)
  if (mcp !== undefined) return mcp

  return classifyByTokens(n)
}
