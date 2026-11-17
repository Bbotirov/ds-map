import { describe, it, expect } from 'vitest'
import { classifyShell, classifyTool, type Station } from '../src/core/classify.ts'

const cases: Array<[string, Station]> = [
  ['cat src/app.ts', 'files'],
  ['grep -r TODO .', 'files'],
  ['rm -rf dist', 'files'],
  ['sed -i \'s/a/b/\' x.ts', 'files'],
  ['find . -name \'*.ts\' -delete', 'files'],
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
  ['head -20 log.txt', 'files'],
  ['tail -f access.log', 'files'],
  ['cp src/a.ts src/b.ts', 'files'],
  ['mkdir -p dist', 'files'],
  ['touch .env', 'files'],
  ['awk \'{print $1}\' data.csv', 'files'],
  ['wc -l file.txt', 'files'],
  ['diff a.txt b.txt', 'files'],
  ['stat file.txt', 'files'],
  ['file image.png', 'files'],
  ['ln -s target link', 'files'],
  ['mv old.ts new.ts', 'files'],
  ['npm run build', 'shell'],
  ['pnpm add lodash', 'web'],
  ['yarn add express', 'web'],
  ['docker push myimage', 'web'],
  ['git pull origin main', 'web'],
  ['git fetch origin', 'web'],
  ['git clone https://github.com/x/y.git', 'web'],
  ['gh issue list', 'web'],
  ['scp file.txt server:/path', 'web'],
  ['rsync -a src/ dest/', 'web'],
  ['ssh user@host', 'web'],
  ['npx -y vitest', 'web'],
]

describe('classifyShell', () => {
  it.each(cases)('%s → %s', (cmd, expected) => {
    expect(classifyShell(cmd)).toBe(expected)
  })

  it('неизвестная команда → shell', () => {
    expect(classifyShell('foobar --flag')).toBe('shell')
  })

  it('пустая строка → shell', () => {
    expect(classifyShell('')).toBe('shell')
  })

  it('регистр не важен для Windows команд', () => {
    expect(classifyShell('CURL.EXE x.com')).toBe('web')
    expect(classifyShell('GET-CONTENT x.txt')).toBe('files')
  })

  it('обёртки с опциями пропускаются', () => {
    expect(classifyShell('sudo -u root cat /etc/passwd')).toBe('files')
    expect(classifyShell('timeout 30 curl https://x.com')).toBe('web')
  })

  it('приоритет web > files > shell в пайпах', () => {
    expect(classifyShell('curl x | grep y')).toBe('web')
    expect(classifyShell('cat x | grep y')).toBe('files')
  })

  it('подстановка $() разбирается', () => {
    expect(classifyShell('cat $(cat file.txt)')).toBe('files')
    expect(classifyShell('echo $(curl -s x.com)')).toBe('web')
  })
})

describe('classifyTool', () => {
  it.each([
    ['read_file', 'files'],
    ['write_file', 'files'],
    ['edit', 'files'],
    ['grep', 'files'],
    ['glob', 'files'],
    ['bash', 'shell'],
    ['web_search', 'web'],
    ['fetch', 'web'],
    ['subagent', 'agents'],
    ['skill', 'skills'],
    ['hook', 'hooks'],
    ['memory', 'memory'],
    ['browser', 'browser'],
  ])('%s → %s', (name, expected) => {
    expect(classifyTool(name)).toBe(expected)
  })
})
