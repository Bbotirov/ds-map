/**
 * Хвост сессионного JSONL файла DSH.
 * Читает session.v4.jsonl и извлекает события ds-map.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventBus } from './bus.js'
import {
  sessionStart, prompt, modelStep, contextUpdate, answer,
  toolStart, toolEnd,
  type RawSession, type RawToolCall, type RawToolResult, type RawContext,
} from '../core/route.js'
import type { DsMapEvent } from '../core/events.js'

const SESSIONS_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

interface RawEvent {
  type: string
  seq?: number
  time?: number
  data?: any
}

export class SessionTailer {
  private bus: EventBus
  private sessionDir: string | null = null
  private sessionFile: string | null = null
  private lastSize = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private sessionId: string | null = null

  constructor(bus: EventBus) {
    this.bus = bus
  }

  /**
   * Найти последнюю сессию для текущей cwd.
   * Структура: sessions/--<cwd-escaped>--/<session-id>/session.v4.jsonl
   * Экранирование cwd: ":" 제거, "\" → "-", пробел → "~0020", оборачивается в "--".
   */
  findSessionForCwd(cwd: string): string | null {
    try {
      const entries = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
      const escaped = escapeCwd(cwd)
      const prefix = `--${escaped}--`
      const cwdDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
        .map((e) => path.join(SESSIONS_ROOT, e.name))
      if (cwdDirs.length === 0) return null

      // Внутри --cwd-- каталога есть подкаталоги с ID сессий, каждый содержит session.v4.jsonl
      // Берём самую новую сессию по дате модификации session.v4.jsonl
      let latestSessionDir: string | null = null
      let latestTime = 0

      for (const cwdDir of cwdDirs) {
        try {
          const sessionEntries = fs.readdirSync(cwdDir, { withFileTypes: true })
          for (const se of sessionEntries) {
            if (!se.isDirectory()) continue
            const sessionFile = path.join(cwdDir, se.name, 'session.v4.jsonl')
            try {
              const stat = fs.statSync(sessionFile)
              if (stat.mtimeMs > latestTime) {
                latestTime = stat.mtimeMs
                latestSessionDir = path.join(cwdDir, se.name)
              }
            } catch {
              // session.v4.jsonl ещё не создан
            }
          }
        } catch {
          // пропускаем недоступный каталог
        }
      }

      return latestSessionDir
    } catch {
      return null
    }
  }

  start(cwd: string): void {
    this.stop()
    const dir = this.findSessionForCwd(cwd)
    if (!dir) {
      console.log('[ds-map] сессия не найдена для', cwd)
      return
    }
    this.sessionDir = dir
    this.sessionFile = path.join(dir, 'session.v4.jsonl')
    this.lastSize = 0
    this.sessionId = path.basename(dir)

    // Инициализируем событие session.start из существующего файла
    this.processExisting()

    // Tail: опрос каждые 250 мс
    this.timer = setInterval(() => this.poll(), 250)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.sessionDir = null
    this.sessionFile = null
    this.lastSize = 0
    this.sessionId = null
  }

  private processExisting(): void {
    if (!this.sessionFile) return
    try {
      const content = fs.readFileSync(this.sessionFile, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        this.parseLine(line)
      }
      this.lastSize = Buffer.byteLength(content, 'utf8')
    } catch {
      // Файл ещё не создан — это нормально
    }
  }

  private poll(): void {
    if (!this.sessionFile) return
    try {
      const stat = fs.statSync(this.sessionFile)
      if (stat.size <= this.lastSize) return
      const content = fs.readFileSync(this.sessionFile, 'utf8')
      const allBytes = Buffer.byteLength(content, 'utf8')
      // Читаем только новые байты — примерно по символам (UTF-8 multi-byte осторожно,
      // но JSONL события ASCII, так что символ ≈ байт для наших целей)
      const lines = content.split('\n')
      // Обрабатываем все строки кроме, возможно, последней incomplete
      const complete = lines.slice(0, -1)
      const lastLine = lines[lines.length - 1]

      // Определяем, с какой строки начинать — эвристика по размеру
      let startIdx = 0
      if (this.lastSize > 0) {
        // Пропускаем строки, которые уже обработали
        const processedBytes = Buffer.byteLength(lines.slice(0, startIdx).join('\n') + '\n', 'utf8')
        // Проще: обрабатываем все完整ные строки, пусть дубли будут — bus имеет подписчиков, которые игнорируют повторы
        // Но лучше не дублировать: найдём индекс по накопленному размеру
      }

      for (const line of complete) {
        if (line.trim()) this.parseLine(line)
      }

      // Последняя строка — может быть неполной, обрабатываем только если выглядит полной
      if (lastLine.trim()) {
        try {
          JSON.parse(lastLine)
          this.parseLine(lastLine)
        } catch {
          // неполная строка — ждём次の итерации
        }
      }

      this.lastSize = allBytes
    } catch {
      // Файл временно недоступен — пропускаем итерацию
    }
  }

  private parseLine(line: string): void {
    let raw: RawEvent
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }

    const evt = this.mapRawEvent(raw)
    if (evt) this.bus.publish(evt)
  }

  private mapRawEvent(raw: RawEvent): DsMapEvent | null {
    const t = raw.type
    const data = raw.data ?? {}

    switch (t) {
      case 'session': {
        const session = data.id || 'unknown'
        const model = (data as any).model ?? 'unknown'
        const cwd = (data as any).cwd ?? ''
        this.sessionId = session
        return sessionStart({ id: session, model, cwd })
      }

      case 'turn/start': {
        // Начало хода — считаем промптом
        return prompt(0)
      }

      case 'user/message': {
        const chars = Array.isArray(data.content)
          ? data.content.reduce((sum: number, c: any) => sum + (c.text?.length ?? 0), 0)
          : 0
        return prompt(chars)
      }

      case 'assistant/message': {
        // Ищем tool-call в сообщении ассистента
        const calls = Array.isArray(data.content)
          ? data.content.filter((c: any) => c.type === 'tool-call')
          : []
        // tool.start будет создан из tool/call события ниже, здесь ничего не делаем
        return null
      }

      case 'tool/call': {
        return toolStart({
          callId: data.callId,
          name: data.name,
          arguments: data.arguments,
          turn: data.turn ?? 0,
          step: data.step ?? 0,
        })
      }

      case 'tool/result': {
        return toolEnd({
          toolCallId: data.toolCallId,
          isError: data.isError ?? false,
          meta: data.meta,
          turn: data.turn ?? 0,
          step: data.step ?? 0,
        })
      }

      case 'turn/end': {
        // Конец хода — ответ получен
        return answer(0)
      }

      case 'request/context': {
        const used = data.contextWindow ?? 0
        const max = data.contextWindow ?? 1
        // request/context даёт размер окна, не использование. Пропускаем,
        // модель.step или иной источник даст реальные used/max.
        return null
      }

      default:
        return null
    }
  }
}

/**
 * Экранировать cwd в имя каталога сессии DSH.
 * Пример: "c:\\Users\\user\\Desktop\\fun proj" → "c-Users-user-Desktop-fun~0020proj"
 */
function escapeCwd(cwd: string): string {
  return cwd
    .replace(/:/g, '')           // убрать двоеточие после буквы диска
    .replace(/\\/g, '-')         // обратные слэши → дефисы
    .replace(/ /g, '~0020')      // пробелы → URL-кодировка
}
