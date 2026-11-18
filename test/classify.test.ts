import { describe, it, expect } from 'vitest'
import { classifyShell, classifyTool, type Station } from '../src/core/classify.js'

// Все строки из таблицы примеров §9 инструкции — проверяем их дословно.
const SPEC_SHELL: Array<[string, Station]> = [
  ['cat src/app.ts', 'files'],
  ['grep -r TODO .', 'files'],
  ['rm -rf dist', 'files'],
  ["sed -i 's/a/b/' x.ts", 'files'],
  ["find . -name '*.ts' -delete", 'files'],
  ['find . -exec grep -l x {} \\;', 'files'],
  ['git status', 'shell'],
  ['npm test', 'shell'],
  ['curl https://api.x.com', 'web'],
  ['gh pr list', 'web'],
  ['git push', 'web'],
  ['npm install', 'web'],
  ['docker pull nginx', 'web'],
  ['npx -y create-app', 'web'],
  ['npx tsc', 'shell'],
  ['sudo cat /etc/hosts', 'files'],
  ['timeout 10 curl x.com', 'web'],
  ['xargs rm', 'files'],
  ['echo $(curl -s x.com)', 'web'],
  ['python -c "import socket"', 'shell'],
  ['/usr/bin/CURL.EXE x.com', 'web'],
  ['Get-Content x.txt', 'files'],
  ['Select-String x', 'files'],
  ['Invoke-WebRequest x', 'web'],
  ['cat x | grep y', 'files'],
  ['curl x | jq .', 'web'],
  ['ls | wc -l', 'files'],
]

describe('classifyShell: таблица примеров §9', () => {
  it.each(SPEC_SHELL)('%s → %s', (cmd, expected) => {
    expect(classifyShell(cmd)).toBe(expected)
  })
})

describe('classifyShell: обёртки и подстановки', () => {
  it('разбирает обратные кавычки так же, как $(...)', () => {
    expect(classifyShell('echo `curl -s x.com`')).toBe('web')
  })

  it('читает вложенную команду под env с присваиваниями', () => {
    expect(classifyShell('env FOO=1 cat /etc/hosts')).toBe('files')
  })

  it('пропускает опции и таймаут-число у обёртки', () => {
    expect(classifyShell('timeout -k 5 10 wget x.com')).toBe('web')
    expect(classifyShell('nohup npm install')).toBe('web')
  })

  it('find без действия всё равно files', () => {
    expect(classifyShell("find . -type f")).toBe('files')
  })

  it('web сильнее files в пайпе, files сильнее shell', () => {
    expect(classifyShell('cat file.txt | curl https://example.com')).toBe('web')
    expect(classifyShell('cat file.txt | grep foo')).toBe('files')
    expect(classifyShell('echo hello | cat file.txt')).toBe('shell')
  })

  it('PowerShell-алиасы и httpie', () => {
    expect(classifyShell('type x.txt')).toBe('files')
    expect(classifyShell('gc x.txt')).toBe('files')
    expect(classifyShell('sls pattern')).toBe('files')
    expect(classifyShell('iwr https://x.com')).toBe('web')
    expect(classifyShell('irm https://x.com')).toBe('web')
    expect(classifyShell('httpie GET https://x.com')).toBe('web')
    expect(classifyShell('COPY-ITEM a.txt b.txt')).toBe('files')
  })

  it('сетевые подкоманды git и пакетных менеджеров', () => {
    expect(classifyShell('git clone https://x.com/y')).toBe('web')
    expect(classifyShell('git fetch origin')).toBe('web')
    expect(classifyShell('git diff')).toBe('shell')
    expect(classifyShell('npm i lodash')).toBe('web')
    expect(classifyShell('pnpm build')).toBe('shell')
    expect(classifyShell('docker push registry/x')).toBe('web')
    expect(classifyShell('docker ps')).toBe('shell')
    expect(classifyShell('ssh user@host')).toBe('web')
  })

  it('пустая и мусорная строка не бросают исключение', () => {
    expect(classifyShell('')).toBe('shell')
    expect(classifyShell('   ')).toBe('shell')
    expect(classifyShell('--only-flags')).toBe('shell')
  })
})

// Имена dsh-инструментов, измеренные по реальным логам сессий.
const DSH_CASES: Array<[string, Station]> = [
  ['read', 'files'],
  ['write', 'files'],
  ['edit', 'files'],
  ['glob', 'files'],
  ['grep', 'files'],
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
  ['working_directory', 'shell'],
  ['pwsh', 'shell'],
]

describe('classifyTool: инструменты dsh по точной таблице', () => {
  it.each(DSH_CASES)('%s → %s', (name, expected) => {
    expect(classifyTool(name)).toBe(expected)
  })

  it('регистр и пробелы в имени не важны', () => {
    expect(classifyTool('READ')).toBe('files')
    expect(classifyTool('  Todo_Write ')).toBe('you')
    expect(classifyTool('Skill')).toBe('skills')
  })

  it('plan и goal больше не уезжают в skills, а вопрос пользователя не агент', () => {
    expect(classifyTool('todo_write')).not.toBe('skills')
    expect(classifyTool('create_goal')).not.toBe('skills')
    expect(classifyTool('ask_user_question')).not.toBe('agents')
  })
})

describe('classifyTool: pwsh разбирается по содержимому команды', () => {
  it('без команды остаётся shell', () => {
    expect(classifyTool('pwsh')).toBe('shell')
    expect(classifyTool('pwsh', '')).toBe('shell')
  })

  it('команда про файлы → files, команда в сеть → web', () => {
    expect(classifyTool('pwsh', 'cat src/app.ts')).toBe('files')
    expect(classifyTool('bash', 'grep -r TODO .')).toBe('files')
    expect(classifyTool('pwsh', 'curl https://api.x.com')).toBe('web')
    expect(classifyTool('pwsh', 'git push')).toBe('web')
    expect(classifyTool('pwsh', 'npm test')).toBe('shell')
  })
})

describe('classifyTool: MCP-вызовы', () => {
  it('браузерные серверы и browser_* тулки → browser', () => {
    expect(classifyTool('mcp__playwright__browser_navigate')).toBe('browser')
    expect(classifyTool('mcp__playwright__browser_tabs')).toBe('browser')
    expect(classifyTool('mcp__playwright__browser_close')).toBe('browser')
    expect(classifyTool('mcp__playwright__browser_network_requests')).toBe('browser')
    expect(classifyTool('mcp__chrome-devtools__click')).toBe('browser')
    expect(classifyTool('mcp__whatever__browser_screenshot')).toBe('browser')
  })

  it('agent_bus разносится по имени тулки', () => {
    expect(classifyTool('mcp__agent_bus__browse')).toBe('web')
    expect(classifyTool('mcp__agent_bus__history')).toBe('memory')
    expect(classifyTool('mcp__agent_bus__agents_list')).toBe('agents')
    expect(classifyTool('mcp__agent_bus__ask')).toBe('agents')
    expect(classifyTool('mcp__agent_bus__ask_parallel')).toBe('agents')
    expect(classifyTool('mcp__agent_bus__panel')).toBe('agents')
    expect(classifyTool('mcp__agent_bus__ask_model')).toBe('agents')
    // незнакомая тулка неизвестного сервера уходит в общее правило MCP
    expect(classifyTool('mcp__agent_bus__unknown_tool')).toBe('web')
  })

  it('любой другой MCP → web', () => {
    expect(classifyTool('mcp__exa__web_search')).toBe('web')
    expect(classifyTool('mcp__github__list_issues')).toBe('web')
    expect(classifyTool('mcp__server')).toBe('web')
  })
})

describe('classifyTool: эвристики для незнакомых имён', () => {
  it('старые имена файловых и веб-инструментов', () => {
    expect(classifyTool('read_file')).toBe('files')
    expect(classifyTool('write_file')).toBe('files')
    expect(classifyTool('search_files')).toBe('files')
    expect(classifyTool('list_dir')).toBe('files')
    expect(classifyTool('web_fetch')).toBe('web')
    expect(classifyTool('web_search')).toBe('web')
  })

  it('узкие станции проверяются раньше широких', () => {
    expect(classifyTool('memory_search')).toBe('memory')
    expect(classifyTool('browser_navigate')).toBe('browser')
    expect(classifyTool('some_hook')).toBe('hooks')
    expect(classifyTool('ask_approval')).toBe('hooks')
    expect(classifyTool('spawn_agent')).toBe('agents')
    expect(classifyTool('tool_search')).toBe('skills')
    expect(classifyTool('todo_clear')).toBe('you')
    expect(classifyTool('switch_model')).toBe('model')
    expect(classifyTool('bash')).toBe('shell')
  })
})

describe('classifyTool: fail-open', () => {
  it('пустое имя и мусор → shell, без исключения', () => {
    expect(classifyTool('')).toBe('shell')
    expect(classifyTool('   ')).toBe('shell')
    expect(classifyTool('mystery_thing')).toBe('shell')
    expect(classifyTool('?!?><')).toBe('shell')
  })

  it('все возвращаемые значения — станции из схемы', () => {
    const allowed: Station[] = [
      'you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks',
    ]
    const names = [
      ...DSH_CASES.map(([n]) => n),
      'read_file', 'web_search', 'mcp__x__y', 'todo_write', 'zzz', '',
    ]
    for (const n of names) expect(allowed).toContain(classifyTool(n))
  })
})
