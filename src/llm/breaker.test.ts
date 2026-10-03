import { describe, expect, test } from 'bun:test';
import { CircuitBreaker } from './breaker.ts';

/** Детерминированные часы: время двигается только вручную. */
function makeBreaker(opts?: { failureThreshold?: number; windowMs?: number; openMs?: number }): {
  breaker: CircuitBreaker;
  advance: (ms: number) => void;
} {
  let now = 1_000_000;
  const breaker = new CircuitBreaker({ nowMs: () => now, ...opts });
  return { breaker, advance: (ms: number) => (now += ms) };
}

describe('CircuitBreaker', () => {
  test('starts closed', () => {
    const { breaker } = makeBreaker();
    expect(breaker.allowRequest()).toBe(true);
  });

  test('opens after threshold failures within the window', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(false);
  });

  test('old failures fall out of the sliding window', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 3, windowMs: 10_000 });
    breaker.recordFailure();
    advance(9_000);
    breaker.recordFailure();
    advance(11_000); // Первый сбой уже вне окна.
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(true);
  });

  test('lets a probe through only after openMs (half-open)', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 2, openMs: 5_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    advance(4_999);
    expect(breaker.allowRequest()).toBe(false);
    advance(2); // 5001 мс после открытия.
    expect(breaker.allowRequest()).toBe(true);
  });

  test('half-open failure reopens for a full openMs', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 2, openMs: 5_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    advance(5_001);
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(false);
    advance(5_001);
    expect(breaker.allowRequest()).toBe(true);
  });

  test('success after half-open resets to closed', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 2, openMs: 5_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    advance(5_001);
    breaker.recordSuccess();
    expect(breaker.allowRequest()).toBe(true);
    // Окно сбоев пусто: порог нужно набирать заново.
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(true);
  });

  test('success clears accumulated failures below threshold', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(false);
  });
});
