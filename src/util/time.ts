export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export type Period = 'minute' | 'hour' | 'day';

export function windowStartMs(nowMs: number, period: Period): number {
  if (period === 'minute') return Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  if (period === 'hour') return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const date = new Date(nowMs);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function windowEndMs(nowMs: number, period: Period): number {
  const span = period === 'minute' ? MINUTE_MS : period === 'hour' ? HOUR_MS : DAY_MS;
  return windowStartMs(nowMs, period) + span;
}

export function secondsUntilWindowEnd(nowMs: number, period: Period): number {
  return Math.max(1, Math.ceil((windowEndMs(nowMs, period) - nowMs) / 1000));
}

/** День по UTC в виде YYYY-MM-DD — ключ таблиц usage_daily и ip_devices (лексикографически сортируется). */
export function utcDayString(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
