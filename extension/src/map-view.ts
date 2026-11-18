/**
 * Webview-представление «Карта работы ds-map».
 *
 * Мост ровно один и он односторонний: host собрал снимок и послал
 * `{kind:'snapshot', …}`. В webview не летят ни сырые строки журнала, ни токен
 * сайдкара, ни содержимое промптов — только проекция из `snapshot.ts`.
 * Presence-heartbeat бьётся, только пока панель реально видима: иначе окно
 * Electron и вкладка редактора спорят за один и тот же край экрана.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as vscode from 'vscode'

import { dshHome, patchConfig, readEndpoint } from './endpoint.js'
import { renderDocument } from './map-html.js'
import { DockHeartbeat } from './presence.js'
import { SidecarClient, type Connector } from './sidecar.js'
import { MapModel, type MapSnapshot } from './snapshot.js'

export const VIEW_ID = 'dsMap.map'
/** VS Code сам заводит `<id view>.focus` для каждого view из package.json. */
export const FOCUS_COMMAND = `${VIEW_ID}.focus`
/** Кадры сливаются: рисовать каждый из потока событий — только тормозить панель. */
const POST_COALESCE_MS = 100

export interface ProviderDeps {
  log(message: string): void
  /** Дом харнеса и коннектор инжектятся тестам: проверка моста не должна поднимать сеть. */
  home?: () => string
  connect?: Connector
  now?: () => number
}

export class MapViewProvider implements vscode.WebviewViewProvider {
  readonly model: MapModel
  private view: vscode.WebviewView | undefined
  private client: SidecarClient | undefined
  private heartbeat: DockHeartbeat | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private dismissed: (() => void) | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    context: vscode.ExtensionContext,
    private readonly deps: ProviderDeps,
  ) {
    this.model = new MapModel(deps.now)
    context.subscriptions.push({ dispose: () => this.teardown() })
  }

  /** Реакция на «скрыть карту»: автооткрытие обязано уважать выбор пользователя. */
  onDismissed(cb: () => void): void {
    this.dismissed = cb
  }

  get resolved(): boolean {
    return this.view !== undefined
  }

  get visible(): boolean {
    return this.view?.visible === true
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    // Локальных ресурсов нет: всё рисует инлайн-скрипт, поэтому
    // `localResourceRoots` пустой — читать с диска webview не сможет ничего.
    view.webview.options = { enableScripts: true, localResourceRoots: [] }
    view.webview.html = this.html()

    this.disposables.push(
      view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg)),
      view.onDidChangeVisibility(() => this.onVisibilityChanged()),
      view.onDidDispose(() => this.teardown()),
    )

    this.startChannel()
    // Первый кадр сразу: панель не должна висеть пустой до следующего события.
    this.post()
  }

  /** nonce на каждый резолв: переиспользовать значение между сессиями — не nonce. */
  private html(): string {
    const nonce = crypto.randomBytes(16).toString('base64')
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      // Сеть webview не нужна вовсе; запрет явный, чтобы `default-src` не
      // оставался единственной преградой для чужого кода.
      "connect-src 'none'",
    ].join('; ')
    return renderDocument({ csp, nonce })
  }

  private home(): string {
    return this.deps.home?.() ?? dshHome()
  }

  private onVisibilityChanged(): void {
    if (!this.view) return
    if (this.view.visible) {
      this.startHeartbeat()
      this.post()
      return
    }
    this.stopHeartbeat()
    this.dismissed?.()
  }

  private startChannel(): void {
    if (this.client) return
    try {
      this.client = new SidecarClient({
        endpoint: { read: () => readEndpoint((p) => fs.readFileSync(p, 'utf8'), this.home()) },
        connect: this.deps.connect,
        onEvent: (raw) => this.ingest(raw),
        onStatus: (connected) => {
          this.model.setConnected(connected)
          this.post()
        },
        log: this.deps.log,
      })
      this.client.start()
    } catch (err) {
      // Канал не поднялся — панель статична, редактор работает.
      this.deps.log(`канал сайдкара не поднят: ${nameOf(err)}`)
    }
    if (this.visible) this.startHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    try {
      this.heartbeat = new DockHeartbeat({ dir: this.home(), log: this.deps.log })
      this.heartbeat.start()
    } catch (err) {
      this.deps.log(`heartbeat не запущен: ${nameOf(err)}`)
    }
  }

  private stopHeartbeat(): void {
    const beat = this.heartbeat
    this.heartbeat = undefined
    try {
      beat?.stop()
    } catch {
      // файлы presence протухнут сами
    }
  }

  /** Точка входа любого источника событий — и единственная дверь для тестов моста. */
  ingest(raw: unknown): void {
    if (this.model.ingest(raw)) this.requestPost()
  }

  snapshot(): MapSnapshot {
    return this.model.snapshot()
  }

  /** «проиграть последнюю запись»: переподключение = replay недавних событий от сайдкара. */
  replay(): void {
    const client = this.client
    if (!client) {
      this.deps.log('нет канала — играть нечего')
      return
    }
    try {
      // Сайдкар при подключении сам досылает недавнюю историю: отдельного
      // «ридера журнала» в расширении нет и быть не должно (§12.4).
      client.restart()
      this.view?.webview.postMessage({ kind: 'replay' })
      this.deps.log('replay: переподключение к сайдкару')
    } catch (err) {
      this.deps.log(`replay не удался: ${nameOf(err)}`)
    }
  }

  pickSession(session: string | null): void {
    this.model.setPicked(session)
    this.requestPost()
  }

  private requestPost(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.post()
    }, POST_COALESCE_MS)
    // Таймер не удерживает хост расширения.
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  /** Единственное сообщение наружу. */
  private post(): void {
    const view = this.view
    // Скрытую панель не обновляем: модель всё равно копит, а снимок уйдёт на show.
    if (!view || view.visible === false) return
    try {
      view.webview.postMessage({ kind: 'snapshot', snapshot: this.model.snapshot() })
    } catch (err) {
      this.deps.log(`снимок не отправлен: ${nameOf(err)}`)
    }
  }

  private handleMessage(message: unknown): void {
    try {
      if (!message || typeof message !== 'object') return
      const msg = message as Record<string, unknown>
      switch (msg.type) {
        case 'ready':
          this.post()
          break
        case 'sessions':
          void vscode.commands.executeCommand('dsMap.pickSession')
          break
        case 'config': {
          // Правим только свои поля: файл настроек общий с окном панели.
          const next = patchConfig(
            {
              theme: msg.theme === 'light' || msg.theme === 'dark' ? msg.theme : undefined,
              lang: msg.lang === 'ru' || msg.lang === 'en' ? msg.lang : undefined,
            },
            this.home(),
          )
          this.view?.webview.postMessage({ kind: 'config', config: next })
          break
        }
        case 'hide':
          this.stopHeartbeat()
          this.dismissed?.()
          break
        case 'show':
          this.startHeartbeat()
          break
        default:
          // Неизвестное сообщение из webview игнорируется: прочитать оно ничего не может.
          break
      }
    } catch (err) {
      this.deps.log(`сообщение webview не обработано: ${nameOf(err)}`)
    }
  }

  private teardown(): void {
    this.view = undefined
    this.stopHeartbeat()
    try {
      this.client?.stop()
    } catch {
      // сокет мог умереть вместе с сайдкаром
    }
    this.client = undefined
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.disposables.length) {
      const d = this.disposables.pop()
      try {
        d?.dispose()
      } catch {
        // подписчик мог быть снят вместе с view
      }
    }
  }
}

/** В лог — только имя ошибки: в `message` Node кладёт куски входа (§12.6). */
function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
