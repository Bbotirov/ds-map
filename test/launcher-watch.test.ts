import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { probeSidecar, startLauncherWatch, type GoneReason } from '../src/ui/launcher-watch.js'
import type { Endpoint } from '../src/shared/config.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Прогоняет N шагов таймера и ждёт, что каждый `tick` успел завершиться. */
async function tick(n: number, intervalMs = 100): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(intervalMs)
  }
}

describe('startLauncherWatch', () => {
  it('не трогает панель, пока порт сайдкара ещё не записан', async () => {
    const onGone = vi.fn()
    startLauncherWatch({ endpoint: () => null, probe: async () => false, onGone, intervalMs: 100 })
    await tick(5)
    expect(onGone).not.toHaveBeenCalled()
  })

  it('считает мёртвым только после нескольких неудач подряд', async () => {
    const onGone = vi.fn()
    const endpoint: Endpoint = { port: 1234, token: 't' }
    let alive = true
    startLauncherWatch({
      endpoint: () => endpoint,
      probe: async () => alive,
      onGone,
      intervalMs: 100,
      grace: 3,
    })
    await tick(2)
    alive = false
    await tick(1)
    expect(onGone).not.toHaveBeenCalled()
    await tick(2)
    expect(onGone).toHaveBeenCalledTimes(1)
    expect(onGone).toHaveBeenCalledWith('port-dead')
  })

  it('сбрасывает счётчик, когда порт снова ответил', async () => {
    const onGone = vi.fn()
    const endpoint: Endpoint = { port: 1234, token: 't' }
    let alive = false
    startLauncherWatch({
      endpoint: () => endpoint,
      probe: async () => alive,
      onGone,
      intervalMs: 100,
      grace: 3,
    })
    await tick(2)
    alive = true
    await tick(2)
    alive = false
    await tick(2)
    expect(onGone).not.toHaveBeenCalled()
    await tick(1)
    expect(onGone).toHaveBeenCalledWith('port-dead')
  })

  it('исчезновение файлов — чистый выход лаунчера', async () => {
    const onGone = vi.fn()
    const endpoint: Endpoint = { port: 1234, token: 't' }
    let present = true
    startLauncherWatch({
      endpoint: () => (present ? endpoint : null),
      probe: async () => true,
      onGone,
      intervalMs: 100,
    })
    await tick(1)
    present = false
    await tick(1)
    expect(onGone).toHaveBeenCalledWith('endpoint-gone')
  })

  it('срабатывает один раз и молчит после остановки', async () => {
    const reasons: GoneReason[] = []
    let present = true
    const stop = startLauncherWatch({
      endpoint: () => (present ? { port: 1234, token: 't' } : null),
      probe: async () => false,
      onGone: (r) => reasons.push(r),
      intervalMs: 100,
      grace: 1,
    })
    await tick(1)
    expect(reasons).toEqual(['port-dead'])
    await tick(3)
    expect(reasons).toEqual(['port-dead'])
    stop()
    present = false
    await tick(3)
    expect(reasons).toEqual(['port-dead'])
  })
})

describe('probeSidecar', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('ответ 403 без токена — живой лаунчер', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url?.includes('token') ? 200 : 403)
      res.end('nope\n')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await expect(probeSidecar(port)).resolves.toBe(true)
    server.close()
  })

  it('несуществующий порт и мусор в аргументе — false', async () => {
    await expect(probeSidecar(1, 200)).resolves.toBe(false)
    await expect(probeSidecar(0)).resolves.toBe(false)
    await expect(probeSidecar(Number.NaN)).resolves.toBe(false)
  })
})
