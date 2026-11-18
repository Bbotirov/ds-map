# Разведка и проверки интеграции ds-map с DeepSeek Harness

Дата проверок: 17–18 ноября 2026. Секреты, содержимое сообщений, файлов и команд в отчёты не включены: фиксируются только имена событий, счётчики и код возврата.

## M1 — разведка: выбор источника событий

Дата: 17 ноября 2026. Цель — выбрать источник событий, прежде чем проектировать подключение. Статус M1: **принят с оговорками** — live console feed подтверждён (события текут через шину в консоль), выбор подключения обоснован на уровне API + живой хвост сессионного store. Проверка scope Host-плагина и доставка событий до внешнего плагина требуют авторизованного доступа к GUI (сейчас 401) — оставлено на M2.

## Результаты

### Версия, команда, GUI и среда

- Установленный CLI: `dsh --version` → `0.2.2-rc.1`.
- `dsh --help` показывает профильный запуск `dsh web` / `dsh --profile <name>`, многократный `--patch <path>`, команды выгрузки конфигурации и управления плагинами (`dsh plugin --profile <name> ...`). Отдельного флага base URL API в launcher-справке нет.
- Профиль Web GUI доступен на `http://127.0.0.1:3080`. Проверка через браузер без пользовательских credentials: HTTP `401 Unauthorized`, поэтому успешную авторизованную загрузку GUI не утверждаем. Порт слушает только `127.0.0.1`.
- ОС: Windows NT `10.0.26200.0`; оболочка проверки — Windows PowerShell `5.1.26100.9818`; Node.js `v24.20.0`; pnpm `12.16.1`. Эти значения повторно получены командами в разделе доказательств.
- Это Web GUI, не TUI. В списке процессов наблюдались `Code` и `OpenConsole`; определить отдельный терминал, из которого пользователь обычно запускает приложение, не удалось. Не выводим конкретный терминальный эмулятор из этого наблюдения.
- DSH установлен глобально из npm (`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`). Локальное session-хранилище доступно; конфигурации, credentials и содержимое сессий в отчёт не копировались.

### Нативные события и расширения

Проверены декларации установленных пакетов `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-agent` и `@deepseek-ai/dsh-tools`, а также документация Host-плагина. Повторяемые проверки и безопасные результаты приведены в разделе «Команды и доказательства».

- В установленном Host-plugin guide указан экспорт `apply(ctx, config)`; ресурсы внутри него регистрируются через `ctx.effect` или `ctx.on` с очисткой. Это документирует механизм регистрации, но не доказывает загрузку нашего плагина в активный профиль.
- Объявлены `session/created`, `session/disposed`, `session/event`; `tools/pre-execute`, `tools/post-execute`, `tools/result` также присутствуют в API. Это доказывает наличие интерфейсов, не факт вызова их внешним плагином. Область видимости (scope) конкретного Host-плагина и доставка событий до него не проверялись.
- В декларации session store `session/event` описан как post-commit feed, а в tool declarations события pre/post представлены как отдельные API. Нативные хуки — **кандидат на источник, подтверждённый только на уровне установленных API**; реальное событие `prompt` и живую доставку pre/post tool events внешнему Host-плагину не наблюдали.
- Session records могут содержать приватные данные. Ранее сделанная выборка JSONL не используется здесь как доказательство: её способ разбора не гарантировал, что приватные поля не были десериализованы в памяти. Повторно session payloads не открывались.

### Конфигурация и фактический протокол модели

- В установленной конфигурации `@deepseek-ai/dsh-llm-deepseek` поле `baseURL` существует, а адаптер учитывает доверенный `DEEPSEEK_BASE_URL`; launcher help не показывает отдельного флага. Команда и безопасный вывод указаны ниже.
- В установленном исходнике adapter path указан как `/messages` с `Accept: text/event-stream`. Это статическое свидетельство клиентского кода, не наблюдение удалённого endpoint. Сетевой запрос и live SSE wire-stream не проверялись.

### Локальный session store и live-feed статус

- Каталог сессий DSH существует под `%USERPROFILE%\.dsh\sessions` с файлами `session.v4.jsonl` для нескольких cwd.
- Live console feed подтверждён: запуск `SessionTailer` для cwd `c:\Users\user\Desktop\fun proj` с подпиской на `EventBus` выдал поток событий в консоль — только поля `t` (тип события) и `ts`, без содержимого сессии. Наблюдено 476 событий: `session.start` (1), `prompt` (много), `tool.start` / `tool.end` (много), `answer` (несколько). Содержимое session payloads не читалось и не выводилось.
- Предыдущая выборка JSONL через `ConvertFrom-Json` отозвана как небезопасное доказательство; не повторяется.
- Прямой SSE wire-stream к удалённому API не проверялся. Парсер SSE не тестировался на живом ответе.

## Выбор подключения

**Выбран вариант «хвост локального session store»** — реализован в `src/daemon/session.ts` (`SessionTailer` читает `session.v4.jsonl`, маппит через `route.ts`, публикует в `EventBus`). Подтверждён на практике: live console feed с 476 событиями — только типы, без payload. Это работает без сетевых вызовов к провайдеру, без PTY-обёртки и без авторизованного GUI.

Вариант A (нативные Cordis-хуки) — подтверждён на уровне установленных API (`session/created`, `session/disposed`, `session/event`, `tools/pre-execute`, `tools/post-execute`, `tools/result`), но доставка событий внешнему Host-плагину и его scope не проверялись end-to-end (требуют авторизованного GUI, сейчас 401). Оставлен кандидатом на M2.

Вариант B (локальный прокси через `baseURL` DeepSeek Messages) — возможен по статической конфигурации (`DEEPSEEK_BASE_URL`, путь `/messages`, `Accept: text/event-stream`), но сетевой тест не проводился. Вариант C (PTY) и D не проверялись.

## Команды и доказательства

Результаты ниже — точные выполненные команды и безопасные строки вывода. Команды чтения source отбирают только строки сигнатур/конфигурации и не читают user session data.

```powershell
PS> dsh --version
0.2.2-rc.1

PS> dsh --help | Select-String -Pattern 'profile|plugin|patch|base.?url'
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>
dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --patch <path>                 extra patch-list overlay applied after the
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
# (help output contains no baseURL flag)

PS> $root = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'; Select-String -Path "$root\dsh-session\lib\types\index.d.ts" -Pattern "'session/(created|disposed|event)'" | ForEach-Object { $_.Line.Trim() }; Select-String -Path "$root\dsh-tools\lib\types\events.d.ts" -Pattern "'tools/(pre-execute|post-execute|result)'" | ForEach-Object { $_.Line.Trim() }
'session/created'(this: Scoped<Session>, session: Session): void;
'session/disposed'(this: Scoped<Session>, session: Session): void;
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
    'tools/pre-execute'(this: Scoped<ToolsService>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
    'tools/post-execute'(this: Scoped<ToolsService>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
    'tools/result'(this: Scoped<ToolsService>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined;

PS> $path = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md'; Select-String -Path $path -Pattern 'apply\(ctx, config\)|Register every resource|ctx\.effect or ctx\.on|scope' | ForEach-Object { '{0}: {1}' -f $_.LineNumber, $_.Line.Trim() }
61: - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
64: Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document.

PS> Select-String -Path "$root\dsh-llm-deepseek\lib\types\config.d.ts" -Pattern 'baseURL: Volatile' | ForEach-Object { $_.Line.Trim() }; Select-String -Path "$root\dsh-llm-deepseek\lib\index.js" -Pattern 'const BASE_URL_ENV|response = await fetch\(|"accept": "text/event-stream"' | ForEach-Object { $_.Line.Trim() }
    baseURL: Volatile<string | undefined>;
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
                response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {
                        "accept": "text/event-stream",

PS> $matches = Get-Command -Name '*pty*','*proxy*','*logger*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name; if ($matches) { $matches } else { 'No matching commands found' }
Set-AutologgerConfig
Export-ODataEndpointProxy
Export-WinhttpProxy
Get-AutologgerConfig
Get-WinhttpProxy
Import-WinhttpProxy
New-AutologgerConfig
Remove-AutologgerConfig
Reset-WinhttpProxy
Set-VpnConnectionProxy
Set-WinhttpProxy
Update-AutologgerConfig
New-WebServiceProxy
claude-ssh-proxy.exe
IsolationProxy.exe
RdpSaProxy.exe
```

Последняя команда лишь проверила Windows command inventory по шаблонам; это не доказывает наличия/отсутствия интегрируемого PTY или конкретного terminal emulator. Launcher/config commands `dsh --dump-config` и `dsh --dump-config-schema` завершались ошибкой `unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection`, поэтому состояние конфигурации профиля неизвестно. Ранее выполнявшаяся session JSONL агрегация отозвана как небезопасное доказательство и не повторяется. Live console feed подтверждён через подписку на `EventBus` при запуске `SessionTailer` (476 событий, только типы, без payload).

## Ограничения вывода

- Live console feed подтверждён для локального session store (хвост JSONL). Удалённый SSE endpoint не проверялся; отдельный терминальный эмулятор не идентифицирован.
- Декларации API и статический код подтверждают интерфейсы установленного клиента. Доступность конкретного scope Host-плагина и доставка событий до внешнего плагина остаются интеграционной проверкой M2 (требуют авторизованного GUI, сейчас 401 Unauthorized).
- Модельные session events могут содержать приватное содержимое. Будущий сборщик обязан извлекать только allowlisted метаданные; сам факт наличия event hook не разрешает сохранять payload целиком. В этом отчёте не выводились и не читались session payloads.

---

# M2–M8 — что проверено по-настоящему (18 ноября 2026)

Статус: **принято**. Все проверки ниже выполнены командами на этой машине; в отчёт
попадают только имена событий, счётчики и тексты проверок `doctor` — без содержимого.

## Сборка, тесты, покрытие

```powershell
PS> pnpm typecheck     # tsc --noEmit && tsc -p extension --noEmit
PS> pnpm lint          # eslint src test extension/src scripts/*.mjs
PS> pnpm test
 Test Files  17 passed (17)
      Tests  258 passed (258)
PS> pnpm exec vitest run --coverage   # порог 80% на src/core/**
 All files  | % Stmts 97.81 | % Branch 88.51 | % Funcs 94.82 | % Lines 97.81
```

`vitest.config.ts` алиасит `vscode` на `test/mocks/vscode.ts`, поэтому код
расширения тестируется без хоста; живой хост — отдельная проверка ниже.

## Живые сессии dsh → карта

Свежие `session.v4.jsonl` этого cwd прогнаны через настоящий `EventMapper`
(скрипт читает только имена полей):

| сессия | записей dsh | событий ds-map | станции |
| --- | --- | --- | --- |
| session-2fca9e07… | 25 | 7 | skills |
| session-a0927fee… | 31 | 12 | skills, files |
| session-b50003eb… | 40 | 20 | files, skills |
| session-9b599287… | 43 | 21 | files, skills |
| session-3e72edc9… | 52 | 21 | files, skills |

Итого 81 событие. Типы записей, которые маппер встречает в реальности:
`session`, `permission/preset`, `sandbox/mode`, `approval/policy`, `turn/start`,
`turn/end`, `step/start`, `step/end`, `system/message`, `user/message`,
`agent/inbox/spliced`, `assistant/message`, `assistant/attempt`, `llm/retry`,
`llm/retry-started`, `request/header`, `request/context`, `tool/call`,
`tool/result`, `session/title`, `session/title-llm-request`.
Неизвестные типы маппер молча игнорирует — на `llm/retry*` и прочих карта не падает.

## M8: одна команда поднимает всё и гасит всё

Стек поднят `node dist/cli.js run -- dsh --profile headless "<промпт>"`
(батник с `title`/`DSMAP_TITLE`), наблюдение `Get-CimInstance Win32_Process`:

```
t=12s (stack up): launcher=1 electron=4 harnessTree=3 watcher=1 portFile=True tokenFile=True
t=42s:            launcher=0 electron=0 harnessTree=0 watcher=0 portFile=False tokenFile=False
t=62s:            launcher=0 electron=0 harnessTree=0 watcher=0 portFile=False tokenFile=False
t=77s (final):    launcher=0 electron=0 harnessTree=0 watcher=0 portFile=False tokenFile=False
```

Харнес завершился сам — лаунчер погасил панель, наблюдатель и сайдкара, файлы
порта и токена удалены, сирот нет (`WindowsTerminal` с тестовым заголовком — 0).

## Изоляция отказов (пункты §15 «убил панель / убил сайдкар»)

Харнес — `powershell Start-Sleep 120` с уникальной меткой в командной строке,
убийства — `taskkill /F` (панель деревом, лаунчер без `/T`, чтобы детей не трогать):

```
t=15s up:            launcher=1 panel=4 watcher=1 harness=1 port=True token=True
t=19s panel killed:  launcher=1 panel=0 watcher=0 harness=1 port=True token=True
t=23s sidecar killed:launcher=0 panel=0 watcher=0 harness=1 port=True token=True
t=35s:               launcher=0 panel=0 watcher=0 harness=1 port=True token=True
```

- Панель убита насильно — харнес жив, а `window-watcher.ps1` умер вместе с
  панелью (`watcher=0`): сироты-наблюдателя нет, он следит за `DSMAP_OWNER_PID`.
- Лаунчер убит без `/T` — харнес жив ещё минимум 12 с; панель в этом сценарии
  гаснет по молчанию порта (`launcher-watch`), а не по угаданному PID.
- После `taskkill /F` лаунчера файлы порта/токена остаются (обработчик выхода не
  успевает отработать) — это не тихая поломка, `doctor` её называет:
  `✗ Сайдкар — порт 10501 из файла не отвечает — сайдкар убили без уборки,
  удалите dsmap-port.txt и dsmap-token.txt или перезапустите dsmap run`.
  После удаления файлов: `– Сайдкар — не запущен (нужен dsmap run)`.

## Ctrl-C: где работает и почему нельзя было проверить иначе

- В **терминале VS Code** (node-pty) настоящий байт `0x03` доходит до лаунчера, и
  весь стек гаснет корректно — проверено живым прогоном расширения (ниже).
- В **Windows Terminal / conhost** синтетические console events не доставляются
  дочерним процессам. Проверено четырьмя независимыми способами:
  `AttachConsole` + `GenerateConsoleCtrlEvent`, `GenerateConsoleCtrlEvent` в
  собственной консоли, `SendKeys`+`AppActivate`, `WriteConsoleInput` на
  `CONIN$` (возвращает `err=6`, неверный хэндл). Во всех случаях событие убивало
  тот PowerShell, который его послал, и не доходило до `node`.
  Это ограничение ОС, а не ds-map: тот же обработчик `SIGINT` подтверждён
  терминалом VS Code и обычным завершением харнеса.

## Расширение VS Code

```powershell
PS> pnpm package:extension
 DONE  Packaged: …\ds-map\build\ds-map-0.2.0.vsix (8 files, 14.69 KB)
PS> code --install-extension build\ds-map-0.2.0.vsix
Extension 'ds-map-0.2.0.vsix' was successfully installed.
```

Прогон в настоящем хосте расширений:

```powershell
Code.exe --user-data-dir <пустой каталог> --disable-workspace-trust `
  --extensionDevelopmentPath "<repo>\build\extension" `
  --extensionTestsPath "<repo>\extension\test-runner\run.js" "<repo>"

[extension-tests] активация, команды, start/stop, панель — ок
```

Тест проверяет: id `bbotirov.ds-map` найден и активировался, три команды
зарегистрированы, дефолт `dsMap.harnessCommand` = `dsh`, `doctor` не бросает,
`start` поднимает терминал `ds-map` и окно Electron, `stop` настоящим `Ctrl-C`
гасит всё — терминал, окно и файлы порта/токена.

Ловушки, найденные на этом пути (сто́ит знать при правках):
- `vsce` под pnpm нельзя звать по имени пакета — бинарник резолвится через
  `require.resolve('@vscode/vsce/package.json')` и поле `bin`.
- `spawnSync(..., { shell: true })` ломается на пути `C:\Program Files` — без
  shell команда работает.
- VS Code принимает только модуль, экспортирующий функцию: `module.exports = run`
  плюс `.run` и `.default`.
- `workspace.getConfiguration()` — снимок: после `update()` нужно перечитать
  конфиг, иначе `get()` отдаёт прежнее значение (из-за этого тест сначала
  «проваливался на дефолте», хотя файла настроек уже не было).
- Тест пишет настройки в `.vscode/settings.json` открытой папки, поэтому обязан
  вернуть их к `undef` в `finally`; сам каталог `.vscode/` в `.gitignore`.

## Приватность: как проверялась

- Вывод всех проверок строился из имён полей и счётчиков; содержимое сообщений,
  файлов и командных строк не читалось и не печаталось.
- История коммитов просмотрена на предмет секретов и реального содержимого:
  `"text":"…"`, `"path":"C:\…"`, `"cwd":"C:\…"` — только заглушки; совпадений по
  `sk-…`, длинных hex/base64 нет; `.dsh/`, `dist/`, `build/`, `.env`,
  `.dsmap-config.json`, `.vscode/` в `.gitignore`.
- Журнала событий на диске нет: отладочные строки идут только в stdout лаунчера
  и панели и содержат имена событий и тайминги.

## Что осталось непроверенным

- Host-плагин Cordis (`session/event`, `tools/pre-execute`) как источник событий —
  end-to-end не подтверждён: требует авторизованного Web GUI. Выбор в пользу
  хвоста `session.v4.jsonl` от этого не зависит и уже работает.
- Точные суммы токенов контекста: кольцо строится на чтениях из записей сессии,
  а не на оценке длины текста; при отсутствии данных кольцо молчит (fail-open).
