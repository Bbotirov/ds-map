/**
 * Автооткрытие панели: один раз на живую сессию, как в эталонном продукте.
 *
 * Правила, которые легко потерять в таймере, поэтому они вынесены в чистый
 * класс и покрыты тестами:
 *  - сессия живая = харнес писал в файл меньше `liveMs` назад;
 *  - открываем не чаще одного раза на id сессии;
 *  - пользователь скрыл панель — в этой сессии больше не навязываемся;
 *  - фокус команды может не быть зарегистрирован (view ещё не поднялся) —
 *    это не попытка «открыть», а повод повторить в следующий тик.
 */

export class AutoOpen {
  private readonly opened = new Set<string>()
  private readonly dismissed = new Set<string>()
  private pending: string | null = null

  /** @returns true, если стоит попытаться показать панель. */
  shouldOpen(liveSession: string | null): boolean {
    if (!liveSession) {
      this.pending = null
      return false
    }
    if (this.pending === liveSession) return true
    if (this.opened.has(liveSession) || this.dismissed.has(liveSession)) return false
    this.pending = liveSession
    return true
  }

  /** Вызов фокуса прошёл: сессия открыта, повторять не нужно. */
  markOpened(): void {
    if (this.pending) this.opened.add(this.pending)
    this.pending = null
  }

  /** Провайдера ещё нет — снимаем пометку, чтобы попробовать на следующем тике. */
  release(): void {
    this.pending = null
  }

  /** Пользователь сам закрыл/скрыл панель: уважаем выбор до следующей сессии. */
  noteDismissed(session: string | null): void {
    if (session) this.dismissed.add(session)
    if (this.pending === session) this.pending = null
  }

  get pendingSession(): string | null {
    return this.pending
  }

  /** Для тестов и диагностики: без содержимого, только счётчик. */
  get openedCount(): number {
    return this.opened.size
  }
}
