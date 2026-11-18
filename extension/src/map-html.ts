/**
 * Разумеющий webview документ карты.
 *
 * Electron-рендерер из `dist/ui/` сюда не подходит: он грузится как ESM с
 * относительными импортами и берёт события из `window.dsmap` — моста preload,
 * которого в webview нет физически. Поэтому карта перерисована здесь тем же
 * набором примитивов (10 станций, кольцо контекста, лента «время · станция ·
 * имя»), но источником служит только снимок из host-а.
 *
 * Тот же скрипт работает и в браузере (`dsMap.карта в браузере`): там вместо
 * моста в окно лежит встроенный снимок `window.__DSMAP_SNAPSHOT__`.
 */

import type { MapSnapshot } from './snapshot.js'

/** Геометрические иконки станций — те же path'ы, что в окне панели. */
export const STATION_ICONS: Record<string, string> = {
  you: 'M0 -3.6a3.4 3.4 0 1 0 0 -0.01M-6.5 8c0-4 3-6.2 6.5-6.2s6.5 2.2 6.5 6.2',
  model: 'M-5 -5h10v10h-10zM-2 -8.5v3.5M2 -8.5v3.5M-2 5v3.5M2 5v3.5M-8.5 -2h3.5M-8.5 2h3.5M5 -2h3.5M5 2h3.5',
  memory: 'M-5 4.5L0 -5L6 3.5M-5 4.5L6 3.5M-7.1 4.5a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0M-2.1 -5a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0M3.9 3.5a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0',
  files: 'M-5.5 -8h7.5l3.5 3.5v12.5h-11zM2 -8v3.5h3.5',
  shell: 'M-7.5 -5l5 5l-5 5M0 6h7.5',
  web: 'M-7.8 0a7.8 7.8 0 1 0 15.6 0a7.8 7.8 0 1 0 -15.6 0M-7.8 0h15.6M0 -7.8c-4.2 4.2 -4.2 11.4 0 15.6M0 -7.8c4.2 4.2 4.2 11.4 0 15.6',
  browser: 'M-8.5 -6.5h17v13h-17zM-8.5 -2.8h17M-6.3 -4.7h.1M-3.8 -4.7h.1',
  agents: 'M0 -4v3.5M0 -0.5L-6 4M0 -0.5L6 4M-2.1 -6a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0M-8.6 5.5a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0M4.4 5.5a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0',
  skills: 'M1.5 -8.5L-5.5 1h4.5l-1.5 7.5l7.5 -9.8h-4.5z',
  hooks: 'M2.5 -5.5v8a4.2 4.2 0 1 1 -8.4 0v-1.5M0.7 -7.3a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0',
}

const ORDER = ['you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks']

const STYLE = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;font-family:system-ui,-apple-system,sans-serif;font-size:11px}
:root{--bg:#0a0c11;--node:#12151c;--line:#272c36;--spoke:#1a1e27;--text:#ebe6dc;--label:#9ba1ab;--accent:#e1ac6e;--active:#f0c595;--error:#e8654f;--memory:#a5e6dc}
body[data-theme=light]{--bg:#f6f4ef;--node:#fff;--line:#d8d3c8;--spoke:#e6e1d6;--text:#1d2027;--label:#6b7280;--accent:#9a6b1f;--active:#b8801f;--error:#c0432d;--memory:#1f7a70}
body{background:var(--bg);color:var(--text)}
#app{display:flex;flex-direction:column;height:100%}
#head{padding:4px 6px 2px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--label);display:flex;align-items:center;gap:6px}
#head b{color:var(--text);font-weight:600}
#sub{padding:0 6px 4px;color:var(--label);font-size:10px;display:flex;gap:6px;align-items:baseline;border-bottom:1px solid var(--line)}
#sub .tok{color:var(--text);font-variant-numeric:tabular-nums}
#bar{display:inline-block;width:42px;height:4px;border:1px solid var(--line);border-radius:2px;vertical-align:middle}
#bar i{display:block;height:100%;background:var(--accent)}
#map{flex:1 1 auto;min-height:0}
#map svg{display:block;width:100%;height:100%}
#list{overflow-y:auto;flex:1 1 auto}
#list div{display:flex;justify-content:space-between;padding:2px 8px;border-bottom:1px solid var(--spoke);color:var(--label)}
#list div b{color:var(--text);font-variant-numeric:tabular-nums}
#feed{flex:0 0 auto;border-top:1px solid var(--line);max-height:52%;overflow-y:auto}
.row{display:grid;grid-template-columns:52px 12px minmax(0,52px) minmax(0,1fr) 40px;gap:6px;padding:1px 6px;align-items:baseline}
.row.now{border-bottom:1px solid var(--line);padding:4px 6px}
.t{color:var(--label);font-variant-numeric:tabular-nums}
.s{text-align:center;font-weight:700;color:var(--label)}
.row[data-s=active] .s{color:var(--active)}
.row[data-s=error] .s{color:var(--error)}
.row[data-s=switch] .s{color:var(--memory)}
.st{color:var(--label);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ms{color:var(--label);text-align:right;font-variant-numeric:tabular-nums}
#bar-tools{display:flex;gap:4px;padding:4px 6px;border-top:1px solid var(--line);flex-wrap:wrap}
button{font:inherit;font-size:10px;padding:1px 5px;background:var(--node);color:var(--text);border:1px solid var(--line);border-radius:3px;cursor:pointer}
button:hover{border-color:var(--label)}
button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
.empty{padding:4px 6px;color:var(--label)}
.hint{padding:2px 6px;color:var(--error);font-size:10px}
`.trim()

/** Словарь webview: ключи снимка + подписи станций и тулбара. */
const I18N = {
  ru: {
    title: 'Карта работы',
    stations: {
      you: 'Вы', model: 'Модель', memory: 'Память', files: 'Файлы', shell: 'Шелл', web: 'Сеть',
      browser: 'Браузер', agents: 'Агенты', skills: 'Скиллы', hooks: 'Хуки',
    },
    keys: {
      sessionLabel: 'Сессия', turnLabel: 'Ход {n}', promptChars: 'Запрос · {n} симв.',
      thinkLabel: 'Думала', answerOk: 'Ответ готов', answerErr: 'Ответ с ошибкой',
      answerAborted: 'Ответ прерван', modelSwitchLabel: 'Смена модели', jobLabel: 'Фоновая работа',
      compactionLabel: 'Уплотнение', guardLabel: 'Правило доступа', agentMsgLabel: 'Сообщений: {n}',
      retryLabel: 'Повтор {n}/{of}', contextLabel: 'контекст',
    },
    tools: {
      list: 'счётчики списком', lang: 'EN', theme: 'тема', sessions: 'сессии',
      pause: 'пауза', resume: 'продолжить', hide: 'скрыть карту', show: 'показать карту',
    },
    noConnection: 'нет соединения с сайдкаром',
    nothing: 'Нет событий',
    pickedOther: 'выбрана другая сессия — панель следит за живой',
    errors: 'ошибки',
  },
  en: {
    title: 'Work map',
    stations: {
      you: 'You', model: 'Model', memory: 'Memory', files: 'Files', shell: 'Shell', web: 'Web',
      browser: 'Browser', agents: 'Agents', skills: 'Skills', hooks: 'Hooks',
    },
    keys: {
      sessionLabel: 'Session', turnLabel: 'Turn {n}', promptChars: 'Prompt · {n} chars',
      thinkLabel: 'Thinking', answerOk: 'Answer done', answerErr: 'Answer failed',
      answerAborted: 'Answer aborted', modelSwitchLabel: 'Model switch', jobLabel: 'Background job',
      compactionLabel: 'Compaction', guardLabel: 'Access rule', agentMsgLabel: 'Messages: {n}',
      retryLabel: 'Retry {n}/{of}', contextLabel: 'context',
    },
    tools: {
      list: 'counters as list', lang: 'RU', theme: 'theme', sessions: 'sessions',
      pause: 'pause', resume: 'resume', hide: 'hide map', show: 'show map',
    },
    noConnection: 'no sidecar connection',
    nothing: 'No events',
    pickedOther: 'another session picked — the map follows the live one',
    errors: 'errors',
  },
} as const

/**
 * Клиентский код. Специально ES5-совместимый и без шаблонных строк: он
 * вставляется в TS-шаблон, а webview CSP разрешает только инлайн-скрипт с nonce.
 */
const SCRIPT = `
(function () {
  var ORDER = ${JSON.stringify(ORDER)};
  var ICONS = ${JSON.stringify(STATION_ICONS)};
  var DICT = ${JSON.stringify(I18N)};
  var embedded = window.__DSMAP_SNAPSHOT__ || null;
  var api = null;
  if (!embedded && typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
  var state = embedded || empty();
  var cfg = { theme: 'dark', lang: 'ru' };
  var ui = { zoom: 1, list: false, paused: false, hidden: false, counters: true };
  var queued = null;

  function empty() {
    return { kind: 'snapshot', connected: false, session: null, picked: null, model: null, turn: 0,
      context: null, feed: [], errors: 0, now: Date.now(), activeMs: 1500,
      stations: ORDER.map(function (id) { return { id: id, hits: 0, errors: 0, active: false, lastTs: 0 }; }) };
  }
  function L() { return DICT[cfg.lang] || DICT.ru; }
  function fmt(ms) {
    if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return '—';
    return (ms / 1000).toFixed(1) + 's';
  }
  function clock(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function text(row) {
    if (row.key && L().keys[row.key] !== undefined) {
      var s = L().keys[row.key];
      var vars = row.vars || {};
      return s.replace(/\\{(\\w+)\\}/g, function (m, k) { return vars[k] === undefined ? m : String(vars[k]); });
    }
    return row.label || '';
  }
  function pct(ctx) {
    if (!ctx || !ctx.max || ctx.max <= 0) return null;
    var r = ctx.used / ctx.max;
    if (r < 0) r = 0; if (r > 1) r = 1;
    return { ratio: r, label: (ctx.estimated ? '~' : '') + Math.round(r * 100) + '%' };
  }
  function tokens(used) {
    if (!used) return '';
    return used >= 1000 ? (used / 1000).toFixed(1) + 'k' : String(used);
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderRing() {
    var box = document.getElementById('map');
    var size = 300, c = size / 2, R = 112 * ui.zoom, core = 42, node = 21;
    var out = '<svg viewBox="0 0 ' + size + ' ' + size + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(L().title) + '">';
    out += '<circle cx="' + c + '" cy="' + c + '" r="' + R + '" fill="none" stroke="var(--spoke)" stroke-width="1"/>';
    var total = 0;
    for (var i = 0; i < ORDER.length; i++) { total += (state.stations[i] && state.stations[i].hits) || 0; }
    var p = pct(state.context);
    for (var j = 0; j < ORDER.length; j++) {
      var st = state.stations[j] || { id: ORDER[j], hits: 0, active: false };
      var a = (j / ORDER.length) * Math.PI * 2 - Math.PI / 2;
      var x = c + Math.cos(a) * R, y = c + Math.sin(a) * R;
      var stroke = st.active ? 'var(--active)' : st.errors ? 'var(--error)' : 'var(--line)';
      out += '<line x1="' + c + '" y1="' + c + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="var(--spoke)" stroke-width="1"/>';
      out += '<g transform="translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')">';
      if (st.active) out += '<circle r="' + (node + 5) + '" fill="none" stroke="var(--active)" stroke-opacity="0.35" stroke-width="2"/>';
      out += '<circle r="' + node + '" fill="var(--node)" stroke="' + stroke + '" stroke-width="' + (st.active ? 2 : 1) + '"/>';
      out += '<path d="' + ICONS[st.id] + '" fill="none" stroke="' + (st.active ? 'var(--active)' : 'var(--label)') + '" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>';
      if (ui.counters && st.hits) {
        out += '<text y="' + (node + 11) + '" text-anchor="middle" font-size="9" fill="var(--label)">' + st.hits + '</text>';
      }
      out += '<text y="' + (-node - 6) + '" text-anchor="middle" font-size="8.5" fill="' + (st.active ? 'var(--text)' : 'var(--label)') + '">' + esc(L().stations[st.id]) + '</text>';
      out += '</g>';
    }
    if (p) {
      var rr = core + 5, len = 2 * Math.PI * rr * p.ratio;
      out += '<circle cx="' + c + '" cy="' + c + '" r="' + rr + '" fill="none" stroke="var(--line)" stroke-width="3"/>';
      out += '<circle cx="' + c + '" cy="' + c + '" r="' + rr + '" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="' + len.toFixed(1) + ' ' + (2 * Math.PI * rr).toFixed(1) + '" transform="rotate(-90 ' + c + ' ' + c + ')"/>';
    }
    out += '<circle cx="' + c + '" cy="' + c + '" r="' + core + '" fill="var(--node)" stroke="var(--line)" stroke-width="2"/>';
    out += '<text x="' + c + '" y="' + (c - 8) + '" text-anchor="middle" font-size="12" font-weight="600" fill="var(--text)">dsh</text>';
    out += '<text x="' + c + '" y="' + (c + 6) + '" text-anchor="middle" font-size="10" fill="var(--label)">' + esc(p ? p.label : '—') + '</text>';
    out += '<text x="' + c + '" y="' + (c + 20) + '" text-anchor="middle" font-size="9" fill="var(--label)">' + esc(tokens(state.context ? state.context.used : 0)) + ' tok</text>';
    out += '</svg>';
    box.innerHTML = out;
  }

  function renderList() {
    var box = document.getElementById('list');
    var html = '';
    for (var i = 0; i < ORDER.length; i++) {
      var st = state.stations[i] || { id: ORDER[i], hits: 0, errors: 0 };
      html += '<div><span>' + esc(L().stations[ORDER[i]]) + '</span><b>' + st.hits + (st.errors ? ' · ' + st.errors : '') + '</b></div>';
    }
    box.innerHTML = html;
  }

  function renderFeed() {
    var rows = state.feed || [];
    var html = '';
    if (!rows.length) html = '<div class="empty">' + esc(L().nothing) + '</div>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var now = i === 0 ? ' now' : '';
      html += '<div class="row' + now + '" data-s="' + r.symbol + '">' +
        '<span class="t">' + clock(r.ts) + '</span>' +
        '<span class="s">' + (r.symbol === 'active' ? '●' : r.symbol === 'error' ? '✕' : r.symbol === 'switch' ? '◆' : '·') + '</span>' +
        '<span class="st">' + esc(L().stations[r.station] || r.station) + '</span>' +
        '<span class="lb">' + esc(text(r)) + '</span>' +
        '<span class="ms">' + fmt(r.ms) + '</span></div>';
    }
    document.getElementById('feed').innerHTML = html;
  }

  function renderHead() {
    var p = pct(state.context);
    var name = (state.model && state.model !== 'unknown') ? state.model : 'dsh';
    document.getElementById('head').innerHTML = '<b>' + esc(L().title) + '</b><span>ds-map</span>' +
      '<span style="margin-left:auto">' + (state.connected ? '' : esc(L().noConnection)) + '</span>';
    var sub = '<span>' + esc(name) + '</span><span>·</span><span>' + esc(state.session ? state.session.slice(0, 8) : '—') + '</span>' +
      (p ? '<span>·</span><span id="bar"><i style="width:' + Math.round(p.ratio * 100) + '%"></i></span><span class="tok">' + esc(p.label) + ' · ' + esc(tokens(state.context.used)) + ' tok</span>' : '') +
      (state.errors ? '<span>·</span><span style="color:var(--error)">' + state.errors + ' ' + esc(L().errors) + '</span>' : '');
    document.getElementById('sub').innerHTML = sub;
    var hint = document.getElementById('hint');
    hint.textContent = state.picked && state.session && state.picked !== state.session ? L().pickedOther : '';
  }

  function renderTools() {
    var t = L().tools;
    var html = '<button id="z-out">−</button><button id="z-in">+</button>' +
      '<button id="t-list" aria-pressed="' + ui.list + '">' + esc(t.list) + '</button>' +
      '<button id="t-lang">' + esc(t.lang) + '</button>' +
      '<button id="t-theme">' + esc(t.theme) + '</button>' +
      '<button id="t-sessions">' + esc(t.sessions) + '</button>' +
      '<button id="t-pause" aria-pressed="' + ui.paused + '">' + esc(ui.paused ? t.resume : t.pause) + '</button>' +
      '<button id="t-hide">' + esc(ui.hidden ? t.show : t.hide) + '</button>';
    document.getElementById('tools').innerHTML = html;
    bind('z-out', function () { ui.zoom = Math.max(0.6, ui.zoom - 0.1); draw(); });
    bind('z-in', function () { ui.zoom = Math.min(1.6, ui.zoom + 0.1); draw(); });
    bind('t-list', function () { ui.list = !ui.list; draw(); });
    bind('t-lang', function () { cfg.lang = cfg.lang === 'ru' ? 'en' : 'ru'; send({ type: 'config', lang: cfg.lang }); draw(); });
    bind('t-theme', function () { cfg.theme = cfg.theme === 'dark' ? 'light' : 'dark'; send({ type: 'config', theme: cfg.theme }); paint(); });
    bind('t-sessions', function () { send({ type: 'sessions' }); });
    bind('t-pause', function () { ui.paused = !ui.paused; if (!ui.paused && queued) { state = queued; queued = null; } draw(); });
    bind('t-hide', function () { ui.hidden = !ui.hidden; send({ type: ui.hidden ? 'hide' : 'show' }); paint(); });
  }

  function bind(id, fn) {
    var el = document.getElementById(id);
    if (el) el.onclick = fn;
  }
  function send(msg) { if (api) api.postMessage(msg); }

  function paint() {
    document.body.setAttribute('data-theme', cfg.theme);
    document.getElementById('map').style.display = ui.list || ui.hidden ? 'none' : 'block';
    document.getElementById('list').style.display = ui.list && !ui.hidden ? 'block' : 'none';
    document.getElementById('feed').style.display = ui.hidden ? 'none' : 'block';
    document.getElementById('tools').style.display = 'flex';
  }

  function draw() {
    renderHead(); renderTools(); paint();
    if (ui.list) renderList(); else renderRing();
    renderFeed();
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'snapshot') {
      if (ui.paused) { queued = msg.snapshot; return; }
      state = msg.snapshot;
      draw();
    } else if (msg.kind === 'config') {
      if (msg.config) { cfg.theme = msg.config.theme; cfg.lang = msg.config.lang; }
      draw();
    } else if (msg.kind === 'replay') {
      ui.paused = false; queued = null; draw();
    }
  });

  renderTools();
  paint();
  draw();
  send({ type: 'ready' });
})();
`.trim()

export interface WebviewAssets {
  style: string
  script: string
}

export const ASSETS: WebviewAssets = { style: STYLE, script: SCRIPT }

export interface DocumentOptions {
  csp: string
  nonce: string
  /** Для браузера: снимок вшивается прямо в страницу, мост webview там нечем заменить. */
  snapshot?: MapSnapshot
}

/** Голый HTML: никаких внешних ресурсов, `default-src 'none'`, скрипт — только с nonce. */
export function renderDocument(options: DocumentOptions): string {
  const embedded = options.snapshot
    ? `<script nonce="${options.nonce}">window.__DSMAP_SNAPSHOT__=${JSON.stringify(options.snapshot)}</script>`
    : ''
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${options.csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Карта работы ds-map</title>
<style>${STYLE}</style>
</head>
<body data-theme="dark">
<div id="app">
  <div id="head"></div>
  <div id="sub"></div>
  <div id="hint" class="hint"></div>
  <div id="map"></div>
  <div id="list"></div>
  <div id="feed"></div>
  <div id="tools"></div>
</div>
${embedded}
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`
}
