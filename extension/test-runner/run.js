/**
 * Реальный прогон расширения в хосте VS Code (`code --extensionTestsPath`).
 * Проверяет активацию, регистрацию команд и живой start/stop панели.
 */

const assert = require('node:assert')
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Харнес в этом прогоне — безопасный sleep вместо настоящего dsh.
const FAKE_HARNESS = 'powershell -NoProfile -Command "Start-Sleep 60"'

async function run() {
  const vscode = require('vscode')

  const extension = vscode.extensions.getExtension('bbotirov.ds-map')
  assert.ok(extension, 'расширение bbotirov.ds-map не найдено')
  await extension.activate()

  const commands = await vscode.commands.getCommands(true)
  for (const id of ['dsMap.start', 'dsMap.stop', 'dsMap.doctor']) {
    assert.ok(commands.includes(id), `команда ${id} не зарегистрирована`)
  }

  // getConfiguration возвращает снимок: после update() нужно перечитать,
  // иначе get() отдаёт значение, которое было на момент создания снимка.
  const conf = () => vscode.workspace.getConfiguration('dsMap')
  assert.strictEqual(typeof conf().get('cliPath'), 'string', 'dsMap.cliPath должна быть строкой')

  // Настройки пишутся в .vscode/settings.json открытой папки, поэтому их
  // обязательно вернуть к undef — иначе следующий прогон читает прошлый sleep.
  const target = vscode.ConfigurationTarget.Workspace
  await conf().update('cliPath', undefined, target)
  await conf().update('harnessCommand', undefined, target)
  assert.strictEqual(conf().get('harnessCommand', 'dsh'), 'dsh', 'дефолт dsMap.harnessCommand')

  // doctor на ненастроенном CLI обязан отработать без исключения.
  await vscode.commands.executeCommand('dsMap.doctor')
  await new Promise((r) => setTimeout(r, 1_500))

  const repo = path.resolve(__dirname, '..', '..')
  const cli = path.join(repo, 'dist', 'cli.js')
  assert.ok(fs.existsSync(cli), 'для проверки нужен собранный dist/cli.js')

  try {
    await conf().update('cliPath', cli, target)
    await conf().update('harnessCommand', FAKE_HARNESS, target)

    await vscode.commands.executeCommand('dsMap.start')
    await new Promise((r) => setTimeout(r, 14_000))

    const started = vscode.window.terminals.filter((t) => t.name === 'ds-map')
    assert.strictEqual(started.length, 1, 'терминал ds-map не создан')
    assert.ok(panelUp(), 'панель Electron не поднялась вместе с харнесом')

    await vscode.commands.executeCommand('dsMap.stop')
    await new Promise((r) => setTimeout(r, 8_000))
    const left = vscode.window.terminals.filter((t) => t.name === 'ds-map')
    const stillUp = panelUp()
    const portLeft = fs.existsSync(path.join(process.env.USERPROFILE || '', '.dsh', 'dsmap-port.txt'))

    assert.strictEqual(left.length, 0, 'после stop терминал должен закрыться')
    assert.ok(!stillUp, 'после stop не должно остаться окна панели')
    assert.ok(!portLeft, 'после stop файлы порта/токена должны быть удалены')
  } finally {
    for (const t of vscode.window.terminals.filter((x) => x.name === 'ds-map')) t.dispose()
    await conf().update('cliPath', undefined, target)
    await conf().update('harnessCommand', undefined, target)
  }

  console.log('[extension-tests] активация, команды, start/stop, панель — ок')
}

function panelUp() {
  return cp
    .execSync('tasklist /FI "IMAGENAME eq electron.exe" /NH', { encoding: 'utf8' })
    .includes('electron.exe')
}

module.exports = run
module.exports.run = run
module.exports.default = run
