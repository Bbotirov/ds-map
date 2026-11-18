/**
 * Реальный прогон расширения в хосте VS Code (`code --extensionTestsPath`).
 *
 * Два цикла: сначала безопасный фейковый харнес — поднятие панели, её решение о
 * пристыковке и честная остановка вместе с порядком за собой; потом настоящий
 * `dsh --profile headless` — чтобы увидеть живой снимок карты и проверить, что
 * содержимое разговора наружу не вышло. Второй цикл помечает промпт маркером и
 * требует, чтобы маркера не было ни в снимке, ни в строках лаунчера
 * (§12 «только имена»).
 */

const assert = require('node:assert')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Харнес в первом цикле — безопасный sleep вместо настоящего dsh. Редирект
// `*>` нужен не для харнеса, а для лаунчера: PowerShell применяет его ко всей
// строке (проверено: `"Start-Sleep 150"` доезжает одним аргументом), и в файл
// попадают строки лаунчера и piped-вывод окна панели — в том числе решение о
// том, к какому окну пристыковываться. Панель живёт все 150 с сна, поэтому
// успевает его напечатать даже на загруженном столе; в headless-ходе она
// умирает раньше наблюдателя.
const FAKE_LOG = path.join(os.tmpdir(), `dsmap-fake-${process.pid}.log`)
const FAKE_HARNESS = `powershell -NoProfile -Command "Start-Sleep 150" *> "${FAKE_LOG}"`
// Любая из четырёх строк панели означает, что наблюдатель за окном жив и решил,
// что делать: `[ds-map] окно-якорь: parent (Code.exe)`, `якоря нет`,
// `окно харнеса не найдено`, `окно харнеса свёрнуто`.
const DOCK_RE = /окно-якорь:|якоря нет|не найдено|свёрнуто/
// Промпт без пробелов: лаунчер передаёт аргументы через shell, и кавычки по
// дороге теряются — многословный промпт превратился бы в несколько аргументов.
const MARKER = 'PLUMCAKE77'
const REAL_HARNESS = `dsh --profile headless say-the-word-${MARKER}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Отчёт в файл: `--extensionTestsPath` печатает результат только в тот терминал,
 * который поднял экземпляр, а при «пристыковке» к уже открытому окну этот вывод
 * теряется. DSMAP_TEST_REPORT делает прогон проверяемым извне.
 */
const REPORT = process.env.DSMAP_TEST_REPORT || path.join(__dirname, '..', '..', 'build', 'extension-tests.log')
function report(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  process.stdout.write(line)
  if (!REPORT) return
  try {
    fs.appendFileSync(REPORT, line)
  } catch {
    // отчёт не должен ронять проверку
  }
}

async function run() {
  try {
    await suite()
    report('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ')
  } catch (err) {
    report(`ПАДЕНИЕ: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown'}`)
    throw err
  }
}

async function suite() {
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
  // `dsh` без `--profile` печатает usage и выходит с кодом 1, поэтому дефолт
  // обязан содержать профиль — иначе «запустить панель» даёт мёртвый терминал.
  const harnessDefault = String(conf().get('harnessCommand') ?? '')
  assert.ok(/--profile\s+\S+/.test(harnessDefault), `дефолт dsMap.harnessCommand без профиля: ${harnessDefault}`)

  // doctor на ненастроенном CLI обязан отработать без исключения.
  await vscode.commands.executeCommand('dsMap.doctor')
  await sleep(1_500)

  const repo = path.resolve(__dirname, '..', '..')
  const cli = path.join(repo, 'dist', 'cli.js')
  assert.ok(fs.existsSync(cli), 'для проверки нужен собранный dist/cli.js')

  try {
    await conf().update('cliPath', cli, target)
    await conf().update('harnessCommand', FAKE_HARNESS, target)

    // Сравниваем PID-ы, а не «есть ли вообще electron»: чужая или оставшаяся от
    // прошлого прогона панель не должна ни проваливать проверку, ни проходить её.
    const before = new Set(panelPids())
    await vscode.commands.executeCommand('dsMap.start')
    await waitFor(() => panelPids().some((pid) => !before.has(pid)), 30_000)

    const started = vscode.window.terminals.filter((t) => t.name === 'ds-map')
    assert.strictEqual(started.length, 1, 'терминал ds-map не создан')
    const spawned = panelPids().filter((pid) => !before.has(pid))
    assert.ok(spawned.length > 0, 'панель Electron не поднялась вместе с харнесом')

    // Куда пристыковалась панель — видно только по её собственной строке: без
    // неё `dsmap run` даёт окно не у терминала, и пользователь не понимает, что
    // панель цепляла не то. Честных ответов четыре: якорь назван, якоря нет,
    // окно не найдено, окно харнеса свёрнуто. Время до первого состояния
    // наблюдателя не гарантировано (на загруженном столе это десятки секунд),
    // поэтому ждём любую из строк, а не одну конкретную.
    let dock = null
    await waitFor(() => {
      dock = readMapLines(FAKE_LOG).find((line) => DOCK_RE.test(line)) ?? null
      return dock !== null
    }, 60_000)
    assert.ok(dock, 'панель не сказала ничего о пристыковке — наблюдатель за окном молчит')
    report(`пристыковка: ${dock}`)

    await vscode.commands.executeCommand('dsMap.stop')
    // `stop` гасит панель Ctrl-C, а терминал снимает только через 2 с. Уборка
    // порта/токена идёт после закрытия терминала и с HTTP-пробой, поэтому
    // ждать нужно всех трёх фактов, а не только «терминал исчез».
    const home = path.join(process.env.USERPROFILE || '', '.dsh')
    const gone = {
      panel: () => panelPids().every((pid) => before.has(pid)),
      terminal: () => vscode.window.terminals.filter((t) => t.name === 'ds-map').length === 0,
      endpoint: () => !fs.existsSync(path.join(home, 'dsmap-port.txt')) && !fs.existsSync(path.join(home, 'dsmap-token.txt')),
    }
    await waitFor(() => gone.panel() && gone.terminal() && gone.endpoint(), 30_000)
    const stillUp = panelPids().filter((pid) => !before.has(pid))

    assert.strictEqual(stillUp.length, 0, `после stop остались окна панели: ${stillUp.join(',')}`)
    assert.strictEqual(vscode.window.terminals.filter((t) => t.name === 'ds-map').length, 0, 'после stop терминал должен закрыться')
    assert.ok(gone.endpoint(), 'после stop файлы порта/токена должны быть удалены')
  } finally {
    for (const t of vscode.window.terminals.filter((x) => x.name === 'ds-map')) t.dispose()
    try {
      fs.rmSync(FAKE_LOG, { force: true })
    } catch {
      // файл ещё держит оболочка терминала — следующий прогон удалит свой
    }
    await conf().update('cliPath', undefined, target)
    await conf().update('harnessCommand', undefined, target)
  }

  report('активация, команды, start/stop, панель — ок')

  await realHarnessRound(vscode, cli, target)
}

/**
 * Живой ход настоящего харнеса. Вывод консоли перенаправляется в файл (`*>`
 * съедает PowerShell, лаунчер об этом не знает) — из него читаются только
 * строки `[ds-map]`: имена событий и тайминги. Файл удаляется в finally,
 * потому что рядом с ними лежит весь stdout харнеса, то есть содержимое.
 */
async function realHarnessRound(vscode, cli, target) {
  const conf = () => vscode.workspace.getConfiguration('dsMap')
  const log = path.join(os.tmpdir(), `dsmap-live-${process.pid}.log`)
  const harness = `${REAL_HARNESS} *> "${log}"`
  const before = new Set(panelPids())
  let leaked = false
  try {
    await conf().update('cliPath', cli, target)
    await conf().update('harnessCommand', harness, target)

    await vscode.commands.executeCommand('dsMap.openMap')
    await sleep(2_000)
    await vscode.commands.executeCommand('dsMap.start')
    report('живой ход запущен')

    const deadline = Date.now() + 300_000
    let snap = null
    let polls = 0
    while (Date.now() < deadline) {
      await sleep(6_000)
      polls++
      await vscode.commands.executeCommand('dsMap.copySnapshot')
      const text = await vscode.env.clipboard.readText()
      if (!text.startsWith('{')) continue
      const parsed = JSON.parse(text)
      if (parsed && parsed.kind === 'snapshot') snap = parsed
      if (snap) {
        report(
          `снимок #${polls}: connected=${snap.connected} turn=${snap.turn} rows=${snap.feed.length} errors=${snap.errors}`,
        )
        if (snap.feed.some((row) => row.key === 'answerOk')) break
      }
    }

    assert.ok(snap, 'снимок карты не появился за 5 минут — живого хода не видно')
    assert.strictEqual(snap.connected, true, 'webview показывает неподключённый сайдкар')
    assert.ok(snap.session, 'в снимке нет id сессии')
    assert.ok(snap.turn >= 1, `ход не засчитан, turn=${snap.turn}`)
    assert.strictEqual(snap.stations.length, 10, 'станции кольца потеряны')
    assert.ok(
      snap.feed.some((row) => row.key === 'answerOk'),
      'в ленте нет строки ответа — ход до карты не дошёл',
    )

    const json = JSON.stringify(snap)
    assert.ok(!json.includes(MARKER), 'содержимое промпта ушло в снимок webview')
    assert.ok(!json.includes('session/title'), 'в снимок попало поле чужого журнала')
  } finally {
    // Сначала честный stop: `dispose()` терминала на Windows снимает только
    // оболочку, а лаунчер с панелью остаются сиротами — их и ловит проверка.
    try {
      await vscode.commands.executeCommand('dsMap.stop')
      await waitFor(() => panelPids().every((pid) => before.has(pid)), 25_000)
    } catch {
      // панель могла погаснуть вместе с завершившимся харнесом
    }
    // Строки лаунчера читаем после остановки: к этому моменту ход точно
    // завершён и в файле лежит вся строка запуска. Здесь только собираем —
    // бросать из finally нельзя, он заместит настоящую ошибку хода.
    const lines = readMapLines(log)
    report(`в логе консоли строк лаунчера: ${lines.length}`)
    leaked = lines.some((line) => line.includes(MARKER))

    // Файл ещё держит оболочка терминала: удаляем как получится, иначе EPERM
    // из finally заместит настоящую ошибку проверки.
    try {
      fs.rmSync(log, { force: true })
    } catch {
      // занят до выхода оболочки — следующий прогон удалит свой
    }
    for (const t of vscode.window.terminals.filter((x) => x.name === 'ds-map')) t.dispose()
    await conf().update('cliPath', undefined, target)
    await conf().update('harnessCommand', undefined, target)
  }

  assert.ok(!leaked, 'строки лаунчера содержат содержимое')
  report('настоящий dsh: живой снимок, приватность — ок')
}

/**
 * Обратная таблица кодовой страницы: PowerShell пишет редирект в UTF-16LE, но
 * байты детей декодирует через OEM-страницу консоли, и кириллица доезжает
 * mojibake. Таблица строится из самого TextDecoder — чем декодируется, тем и
 * кодируется обратно, — поэтому повторять её руками не нужно.
 */
function reverseCpTable(encoding) {
  let dec
  try {
    dec = new TextDecoder(encoding)
  } catch {
    return null
  }
  const table = new Map()
  for (let byte = 0x80; byte <= 0xff; byte++) {
    const ch = dec.decode(Uint8Array.from([byte]))
    if (ch.length === 1 && ch !== '\ufffd' && !table.has(ch.charCodeAt(0))) table.set(ch.charCodeAt(0), byte)
  }
  return table
}

/** UTF-16LE-строка из-под редиректа → нормальный UTF-8. Годной считается страница с минимумом мусора. */
function unmojibake(text) {
  let best = null
  let bestJunk = Infinity
  for (const encoding of ['cp866', 'cp1251', 'cp437']) {
    const table = reverseCpTable(encoding)
    if (!table) continue
    const bytes = []
    let junk = 0
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c < 0x80) bytes.push(c)
      else if (table.has(c)) bytes.push(table.get(c))
      else junk += 1
    }
    const decoded = new TextDecoder('utf-8').decode(Uint8Array.from(bytes))
    // Ровно на UTF-8 указывают заменительные символы: неверная страница даёт их
    // почти в каждой кириллической паре. Строки самой PowerShell (её вывод тоже
    // лежит в файле) в статистику попадают и потому порог относительный.
    junk += (decoded.match(/\ufffd/g) || []).length
    if (junk < bestJunk) {
      bestJunk = junk
      best = decoded
    }
  }
  return best !== null && bestJunk <= text.length / 100 ? best : text
}

/**
 * Только строки лаунчера: вывод харнеса в том же файле — это содержимое.
 * `*>` в PowerShell 5.1 пишет UTF-16LE, а чтение такого файла как utf8 даёт
 * мусор без единого совпадения — на этой кодировке проверка пристыковки уже
 * молча ломалась.
 */
function readMapLines(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return []
  }
  const raw = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8')
  const text = buf[0] === 0xff && buf[1] === 0xfe ? unmojibake(raw) : raw
  return text.split(/\r?\n/).filter((line) => line.includes('[ds-map]'))
}

function panelPids() {
  const text = cp.execSync('tasklist /FI "IMAGENAME eq electron.exe" /NH /FO CSV', { encoding: 'utf8' })
  const pids = []
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('","')
    if (!line.includes('electron.exe') || cells.length < 2) continue
    const pid = Number.parseInt(cells[1].replace(/[^0-9]/g, ''), 10)
    if (Number.isFinite(pid)) pids.push(pid)
  }
  return [...new Set(pids)]
}

/** Ждём условие с поллом: фиксированный `sleep` либо не дожидается, либо тормозит. */
async function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(1_000)
  }
  return false
}

module.exports = run
module.exports.run = run
module.exports.default = run
