import { describe, it, expect } from 'vitest'
import { exitCodeFor, formatCheck, type Check } from '../src/doctor.js'

/**
 * Doctor — это текст, по которому человек решает, что чинить. Поэтому здесь
 * проверяются только чистые части: знак статуса и правило «падает лишь честная
 * поломка». Сетевые и файловые проверки живут в runDoctor и проверяются вживую.
 */

describe('formatCheck', () => {
  it('Ставит ✓ / ✗ / – по статусу', () => {
    const line = (status: Check['status']) => formatCheck({ name: 'Проверка', status })
    expect(line('ok')).toBe('✓ Проверка')
    expect(line('fail')).toBe('✗ Проверка')
    expect(line('info')).toBe('– Проверка')
  })

  it('Добавляет подробности через тире', () => {
    expect(formatCheck({ name: 'Сборка', status: 'fail', detail: 'нет dist/ui/main.js' }))
      .toBe('✗ Сборка — нет dist/ui/main.js')
  })
})

describe('exitCodeFor', () => {
  const ok: Check = { name: 'Node', status: 'ok' }
  const warn: Check = { name: 'Сайдкар', status: 'info', detail: 'не запущен' }
  const bad: Check = { name: 'Electron', status: 'fail' }

  it('ноль, когда всё хорошо или когда что-то просто не запущено', () => {
    expect(exitCodeFor([ok, ok])).toBe(0)
    expect(exitCodeFor([ok, warn])).toBe(0)
    expect(exitCodeFor([])).toBe(0)
  })

  it('единица при любой честной поломке', () => {
    expect(exitCodeFor([ok, warn, bad])).toBe(1)
  })
})
