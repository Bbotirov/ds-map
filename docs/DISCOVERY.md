# DISCOVERY — ds-map подключение к харнесу DeepSeek

## 1. Как запускается Харнес

Команда: `dsh web` — профиль `web` поднимает Web GUI на `http://127.0.0.1:3080`.
- TUI? Нет, это веб-приложение.
- Версия: `@deepseek-ai/dsh` 0.2.2-rc.1.
- Профили лежат в `C:\Users\user\.dsh\profiles\` (web, headless, acp).
- Сессии пишутся в `C:\Users\user\.dsh\sessions\--<cwd>--\<session-id>\session.v4.jsonl` — **не сжатый JSONL**, по одной строке на событие.

## 2. Хуки, плагины, конфиг

Есть плагины (cordis patch layers):
- `dsh-git-rollback` — чекпоинты git
- `skill-filesystem` + `tool-skill` — скиллы (включены через `~/.dsh/cordis.patch.yml`)
- `mcp-agent-bus`, `mcp-playwright`, `mcp-context7` — MCP клиенты
- `session-persistence-jsonl` — хранение сессий в JSONL

Конфиг: `~/.dsh/cordis.patch.yml` (машинный слой) + `~/.dsh/profiles/web/cordis.patch.yml` (слой профиля).

Переменная `base_url` для API: **не настраивается через CLI флаг**. LLM-провайдер настраивается в `cordis.patch.yml` (блок `llm-pi-ai`, провайдер `kilofree` по умолчанию на `http://127.0.0.1:8082/v1`, сейчас сломан — используется `coarena`).

Вариант B (прокси перед API через `base_url`) — **не применим напрямую**: `base_url` неExposeется как переменная окружения или флаг CLI для отдельного сеанса.

## 3. Формат стрима событий

События приходят не через SSE, а пишутся в `session.v4.jsonl`. Примеры реальных событий из сессии:

```jsonl
{"type":"session","version":4,"id":"session-...","createdAt":1794845464258,"cwd":"C:\\...","isSeeded":false,"delegationDepth":0}
{"type":"permission/preset","seq":0,"time":1794845464287,"data":{"preset":"danger-full-access"}}
{"type":"agent/inbox/spliced","seq":3,"time":1794845464298,"data":{"target":"next-turn","start":0,"inserted":[{"content":[{"type":"text","text":"..."}],"source":{"kind":"user"},"role":"user","id":"..."}]}}
{"type":"turn/start","seq":4,"time":1794845464300,"data":{"turn":1}}
{"type":"system/message","seq":7,"time":1794845464612,"data":{"turn":1,"step":1,"message":{...}}}
{"type":"user/message","seq":8,"time":1794845464613,"data":{"content":[{"type":"text","text":"..."}],"source":{"kind":"user"},"role":"user","id":"..."}}
{"type":"request/header","seq":11,"time":1794845464619,"data":{"header":{"config":{"provider":"kilofree","model":"..."},"adapterDefaults":{},"tools":[...]}}}
{"type":"assistant/message","seq":15,"time":1794845471781,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"..."},{"type":"tool-call","id":"call-...","name":"read","arguments":"{...}"}]}}}
{"type":"tool/call","seq":16,"time":1794845471786,"data":{"turn":1,"step":1,"callId":"call-...","name":"read","arguments":"{\"file_path\":\"kilotarget.txt\"}"}}
{"type":"tool/result","seq":17,"time":1794845471809,"data":{"turn":1,"step":1,"message":{...},"toolCallId":"call-...","content":[...],"isError":false,"meta":{"path":"C:\\...","offset":1,"lines":[...],"totalLines":1}}}
{"type":"step/end","seq":18,"time":1794845471809,"data":{"turn":1,"step":1}}
{"type":"turn/end","seq":23,"time":1794845474396,"data":{"turn":1,"reason":{"kind":"completed"}}}
```

**Вывод:** событий хватает для карты. `tool/call` → `tool.start`, `tool/result` → `tool.end` (статус ok/err по `isError`).

## 4. ОС, терминал, размер экрана

- ОС: Windows 10/11 (пути `C:\Users\user\...`).
- Терминал: не TUI — веб-GUI на `127.0.0.1:3080`.
- Оконный API: Windows — `EnumWindows` + `GetWindowRect` через `user32.dll`. PID окна веб-GUI не получается напрямую из `dsh web` (процесс node).

## 5. Выбранный вариант подключения

**Вариант C (PTY) невозможен** — нет TUI процесса, который можно было бы обёрнуть.
**Вариант B (прокси перед API) невозможен** — `base_url` неExposeется.
**Вариант D (гибрид) не нужен.**

Выбран **новый подход: хвост сессионного JSONL** (`session.v4.jsonl`).
- Daemon (`dsmapd`) находит последнюю сессию для текущей `cwd` и tailит `session.v4.jsonl`.
- Парсит строки JSONL: `tool/call` → `tool.start`, `tool/result` → `tool.end`, `assistant/message` с `tool-call` → начало вызова, `turn/start` → `prompt`, `turn/end` → `answer`.
- События відправляются на локальный WS порт для окна ds-map.

Это работает без модификации харнеса, без `base_url`, без PTY.

## 6. Проверено

- `dsh --version` → `0.2.2-rc.1`
- Порт 3080 открыт (веб-GUI работает).
- `session.v4.jsonl` читается, содержит `tool/call` и `tool/result` с именами инструментов (`read`, `bash`, и т.д.).
- Файл сессии для текущего проекта `c:\Users\user\Desktop\fun proj` — путь `C:\Users\user\.dsh\sessions\--c-Users-user-Desktop-fun~0020proj--\` (сессия пока пуста/не создана).

## Выход фазы M1

Вариант: **хвост сессионного JSONL** (вариант E, вариант D не требуется).
Почему: у харнеса нет настраиваемого `base_url` и нет TUI для PTY. Сессионный JSONL — единственный надёжный источник событий инструментов.