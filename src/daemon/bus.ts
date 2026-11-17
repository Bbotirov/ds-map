/**
 * Шина событий: подписчики получают события ds-map.
 * Не знает про DOM, про сеть, про файловую систему.
 */

import type { DsMapEvent } from '../core/events.js'

type Subscriber = (e: DsMapEvent) => void

export class EventBus {
  private subscribers = new Set<Subscriber>()

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  publish(e: DsMapEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(e)
      } catch {
        // подписчик не должен ронять шину
      }
    }
  }

  get size(): number {
    return this.subscribers.size
  }
}
