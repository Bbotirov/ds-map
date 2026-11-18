/**
 * Признак «лаунчера больше нет» — молчание его порта.
 *
 * Сайдкар живёт в процессе лаунчера, поэтому отвечающий порт = живой лаунчер.
 * Два других способа не сработали на Windows:
 * — опрос PID (`kill(pid, 0)`): дети держат handle родителя, и убитый процесс
 *   выглядит живым вечно;
 * — EOF на stdin pipe: Electron — GUI-подсистема, его stdin закрыт сразу на
 *   старте, и панель гаслась через секунду после запуска.
 * Закрытый listening-сокет OS убирает сама даже при `taskkill /F`, так что
 * ошибка соединения — честный сигнал.
 *
 * Запас в несколько попыток нужен не для убитого лаунчера, а для кратковременных
 * сбоев localhost-соединения: антивирус, сон сети, перезапуск сайдкара.
 */

import type { Endpoint } from '../shared/config.js'

export type GoneReason = 'endpoint-gone' | 'port-dead'

export interface LauncherWatchOptions {
  /** Файлы сайдкара: лаунчер убирает их при чистом выходе. */
  endpoint: () => Endpoint | null
  /** true — порт ответил (любым HTTP-кодом), false — соединения нет. */
  probe: (port: number) => Promise<boolean>
  onGone: (reason: GoneReason) => void
  intervalMs?: number
  /** Сколько подряд неудачных проб, прежде чем признать лаунчер мёртвым. */
  grace?: number
}

/** Возвращает остановку: таймер обязан умереть вместе с панелью. */
export function startLauncherWatch(options: LauncherWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? 1_000
  const grace = options.grace ?? 3
  let misses = 0
  let portSeen = 0
  let busy = false
  let done = false

  const tick = async (): Promise<void> => {
    if (busy || done) return
    busy = true
    try {
      const endpoint = options.endpoint()
      if (!endpoint) {
        // До первого порта файлы могут быть ещё не записаны: ждём.
        // Исчезнувший после подключения порт — лаунчер вышел по своей воле.
        if (portSeen > 0) finish('endpoint-gone')
        return
      }
      portSeen = endpoint.port
      if (await options.probe(endpoint.port)) {
        misses = 0
        return
      }
      misses += 1
      if (misses >= grace) finish('port-dead')
    } finally {
      busy = false
    }
  }

  const finish = (reason: GoneReason): void => {
    if (done) return
    done = true
    clearInterval(timer)
    options.onGone(reason)
  }

  const timer = setInterval(() => void tick(), intervalMs)
  return () => {
    done = true
    clearInterval(timer)
  }
}

/**
 * Один GET без токена: 403 — тоже ответ, значит лаунчер жив.
 * Ничего наружу не уходит — адрес жёстко 127.0.0.1 (§12.2).
 */
export async function probeSidecar(port: number, timeoutMs = 700): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

/**
 * GET с токеном: `200` отвечает только наш живой сайдкар. Нужен именно этот
 * ответ, когда решается вопрос «удалять ли файлы порта и токена»: порт мог
 * достаться чужому процессу, и тогда файлы мусорные, а мог на секунду
 * заглючить у антивируса, и тогда их трогать нельзя.
 */
export async function probeEndpoint(endpoint: Endpoint, timeoutMs = 700): Promise<boolean> {
  if (!Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535) return false
  if (!endpoint.token) return false
  try {
    const res = await fetch(
      `http://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    )
    return res.ok
  } catch {
    return false
  }
}
