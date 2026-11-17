# M1 — разведка интеграции ds-map с DeepSeek Harness

Дата проверок: 17 ноября 2026. Цель — выбрать источник событий, прежде чем проектировать подключение. Секреты, содержимое сообщений, файлов и команд в этот отчёт не включены. Статус M1: **не принят** — валидация пока только на уровне API, без live console feed и проверки scope.

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

- Ранее в M1 на диске обнаруживались persistent-session файлы под `%USERPROFILE%\.dsh\sessions`. Предыдущая выборка их JSONL пыталась агрегировать event types через `ConvertFrom-Json`; поскольку так мог десериализоваться полный payload, эта выборка отозвана как privacy-safe доказательство. Payload повторно не читался, а перечисленные прежде типы и counts не используются для выбора подключения.
- Прямого наблюдения live событий через console или загруженный Host-плагин в рамках этой разведки не было. Поэтому §5 live-feed критерий и доставка в нужном scope не подтверждены; до такой проверки нельзя утверждать, что вариант A фактически работает end-to-end. Парсер SSE также не проверялся на живом ответе удалённого API.

## Выбор подключения (предварительный)

**Предварительно выбран вариант A — нативные Cordis-хуки с профильным Host-плагином**, так как установленные декларации предоставляют session/tool hook APIs, а Host-plugin guide документирует регистрацию обработчиков. Это только API-level кандидат: ни запуск собственного Host-плагина, ни его scope/delivery, ни критерий §5 live console-feed здесь не проверены. Поэтому выбор не равен подтверждённой технической жизнеспособности интеграции; решение о переходе дальше остаётся условным до live проверки.

Вариант B (локальный прокси) возможен по статической конфигурации DeepSeek Messages `baseURL`, но требует отдельного live захвата provider stream; сетевой тест не проводился. Вариант C (PTY) не выбран, PTY/terminal wrapper availability не проверена. Вариант D не проверялся, его условие (B и C оба работают) не установлено. Inventory wrapper-команд см. в результатах ниже.

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

Последняя команда лишь проверила Windows command inventory по шаблонам; это не доказывает наличия/отсутствия интегрируемого PTY или конкретного terminal emulator. Launcher/config commands `dsh --dump-config` и `dsh --dump-config-schema` завершались ошибкой `unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection`, поэтому состояние конфигурации профиля неизвестно. Ранее выполнявшаяся session JSONL агрегация отозвана как небезопасное доказательство и не повторяется. Live console feed не снимался.

## Ограничения вывода

- Не утверждается, что удалённый SSE endpoint был проверен или что какой-либо отдельный терминальный эмулятор идентифицирован.
- Декларации API и статический код подтверждают интерфейсы/поведение установленного клиента; доступность конкретного scope и установка отдельного Host-плагина остаются интеграционной проверкой M2.
- Модельные session events могут содержать приватное содержимое (в частности, prompt, raw tool arguments, результаты, tool metadata). Будущий сборщик обязан извлекать только allowlisted метаданные; сам факт наличия event hook не разрешает сохранять payload целиком.
