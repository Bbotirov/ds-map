# Архитектура ds-map

## Слои

```
харнес  ──JSONL tail──►  dsmapd  ──WS/JSON──►  окно ds-map
                        │
                        ├─ classify()   → станция + метка
                        ├─ redact()     → только имена, никогда содержимое
                        ├─ bus          → подписчики
                        └─ events.jsonl → отладочный лог
```

**Правило слоёв:**
- `core/` не знает про Electron, сеть и файловую систему.
- `daemon/` не знает про DOM.
- `ui/` не знает, откуда пришли события.

Это позволяет тестировать всё, кроме окна, без окна.

## Компоненты

### `src/core/events.ts`
Схема событий ds-map (JSONL, v:1). Типы: `session.start`, `prompt`, `model.step`,
`tool.start`, `tool.end`, `answer`, `context.update`.

### `src/core/classify.ts`
Классификатор: команда → станция. Чистые функции, без побочных эффектов.
Главное правило: классифицируем по ИМЕНИ команды, а не по тому, что она делает.

### `src/core/redact.ts`
Приватность: только имена. `fileLabel`, `urlLabel`, `commandLabel`, `safe` (fail-open).

### `src/core/route.ts`
Маршрутизация: сырые события DSH → события ds-map.

### `src/daemon/bus.ts`
Шина событий: подписчики получают события ds-map.

### `src/daemon/session.ts`
Хвост сессионного JSONL (`session.v4.jsonl`). Ищет последнюю сессию для cwd,
парсит строки, публикует в шину.

### `src/daemon/server.ts`
Локальный HTTP + WS сервер на `127.0.0.1` со случайным портом и токеном.

### `src/ui/main.ts`
Electron main: окно, WS к сайдкару, отслеживание позиции окна харнеса по PID.

### `src/ui/window.ts`
Поиск окна харнеса по PID (Windows через PowerShell + user32.dll).
Формула пристегивания: `x = harness.x + harness.width + 8`, `y = harness.y`,
`h = harness.height`, `w = clamp(420, 320, 560)`.

### `src/ui/renderer/map.ts`
SVG карта-раadar 460×430. Геометрия из lot-map (MIT):
W=460, H=430, CX=230, CY=212, RX=176, RY=164, NODE=22, CORE=40.
Пульсы (PULSE_MS=800), маршрут (TRAIL_HOLD_MS=40000, TRAIL_FADE_MS=20000),
кольцо контекста, часы.

### `src/ui/renderer/feed.ts`
Лента событий: последние 16 строк, ●/·/✕/◆ символы, сворачивание подряд.

### `src/ui/renderer/app.ts`
Рендерер: чистый SVG + минимум DOM. IPC через preload, анимация через rAF
(не более 30 fps, остановка в покое).

### `src/ui/preload.ts`
contextBridge с узким API: `onEvent`, `getConfig`, `setConfig`.

### `src/ui/index.html`
HTML оболочка с тулбаром (тема, язык, reduced motion, статус).

### `src/cli.ts`
Лаунчер: `dsmap run -- <команда>` и `dsmap doctor`.

## События

```jsonl
{"v":1,"t":"session.start","ts":...,"session":"s_...","model":"...","cwd":"..."}
{"v":1,"t":"prompt","ts":...,"chars":214}
{"v":1,"t":"model.step","ts":...,"context":{"used":18400,"max":128000}}
{"v":1,"t":"tool.start","ts":...,"id":"call_1","name":"read","station":"files","label":"src/app.ts"}
{"v":1,"t":"tool.end","ts":...,"id":"call_1","status":"ok","ms":400}
{"v":1,"t":"answer","ts":...,"ms":8000}
```

UI игнорирует неизвестные `t` и не падает. Любая ошибка в маппере ловится
локально (fail-open).

## Приватность

Только имена. Никогда содержимое. Никаких сетевых запросов наружу.
Сервер только на `127.0.0.1`. Токен в файле с правами `600`.
Ничего не хранится между сессиями.
