import { describe, it, expect } from 'vitest'
import {
  isToolStart,
  isToolEnd,
  isModelStep,
  isContextUpdate,
  isSessionStart,
  type DsMapEvent,
} from '../src/core/events.js'

describe('events type guards', () => {
  it('isToolStart', () => {
    const e: DsMapEvent = { v: 1, t: 'tool.start', ts: 1, id: 'c1', name: 'read', station: 'files', label: 'a.ts' }
    expect(isToolStart(e)).toBe(true)
    expect(isToolStart({ v: 1, t: 'prompt', ts: 1, chars: 2 } as unknown as DsMapEvent)).toBe(false)
  })

  it('isToolEnd', () => {
    const e: DsMapEvent = { v: 1, t: 'tool.end', ts: 1, id: 'c1', status: 'ok', ms: 5 }
    expect(isToolEnd(e)).toBe(true)
    expect(isToolEnd({ v: 1, t: 'answer', ts: 1, ms: 5 } as unknown as DsMapEvent)).toBe(false)
  })

  it('isModelStep', () => {
    const e: DsMapEvent = { v: 1, t: 'model.step', ts: 1, context: { used: 1, max: 2 } }
    expect(isModelStep(e)).toBe(true)
    expect(isModelStep({ v: 1, t: 'prompt', ts: 1, chars: 2 } as unknown as DsMapEvent)).toBe(false)
  })

  it('isContextUpdate', () => {
    const e: DsMapEvent = { v: 1, t: 'context.update', ts: 1, used: 1, max: 2 }
    expect(isContextUpdate(e)).toBe(true)
    expect(isContextUpdate({ v: 1, t: 'answer', ts: 1, ms: 5 } as unknown as DsMapEvent)).toBe(false)
  })

  it('isSessionStart', () => {
    const e: DsMapEvent = { v: 1, t: 'session.start', ts: 1, session: 's1', model: 'm', cwd: 'c' }
    expect(isSessionStart(e)).toBe(true)
    expect(isSessionStart({ v: 1, t: 'prompt', ts: 1, chars: 2 } as unknown as DsMapEvent)).toBe(false)
  })
})
