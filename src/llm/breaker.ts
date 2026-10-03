/**
 * Предохранитель upstream: скользящее окно сбоев; порог сбоев в окне —
 * open на openMs (half-open, один пробный запрос), успех в half-open
 * полностью сбрасывает состояние. nowMs инъецируется для детерминизма в тестах.
 */
export interface CircuitBreakerOptions {
  /** Сколько сбоев в окне переводят breaker в open. */
  failureThreshold?: number;
  /** Ширина скользящего окна сбоев, мс. */
  windowMs?: number;
  /** Сколько остаётся открытым, мс. */
  openMs?: number;
  /** Инъекция часов (Date.now по умолчанию). */
  nowMs?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_OPEN_MS = 30_000;

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly now: () => number;

  /** Метки времени сбоев в скользящем окне (пока breaker закрыт). */
  private readonly failures: number[] = [];
  /** 0 — закрыт; иначе момент, когда open/half-open разрешает пробный запрос. */
  private openUntilMs = 0;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.openMs = opts?.openMs ?? DEFAULT_OPEN_MS;
    this.now = opts?.nowMs ?? Date.now;
  }

  /** Закрыт или уже истёк openMs (half-open — пропускаем один пробный запрос). */
  allowRequest(): boolean {
    return this.now() >= this.openUntilMs;
  }

  /** Успех (в т.ч. первый в half-open) — полный сброс в закрытое состояние. */
  recordSuccess(): void {
    this.failures.length = 0;
    this.openUntilMs = 0;
  }

  recordFailure(): void {
    const now = this.now();
    // Сбой пробного запроса в half-open — снова open на полный срок.
    if (this.openUntilMs !== 0 && now >= this.openUntilMs) {
      this.openUntilMs = now + this.openMs;
      this.failures.length = 0;
      return;
    }
    // Скользящее окно: выбрасываем сбои старше windowMs.
    while (this.failures.length > 0) {
      const oldest = this.failures[0];
      if (oldest !== undefined && now - oldest <= this.windowMs) break;
      this.failures.shift();
    }
    this.failures.push(now);
    if (this.failures.length >= this.failureThreshold) {
      this.openUntilMs = now + this.openMs;
      this.failures.length = 0;
    }
  }
}
