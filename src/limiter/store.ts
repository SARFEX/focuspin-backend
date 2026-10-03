import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { DAY_MS, utcDayString, type Period } from '../util/time.ts';

/** Сроки жизни строк для purgeExpired. */
const COUNTERS_TTL_MS = 2 * DAY_MS;
const IP_DEVICES_TTL_DAYS = 2;
const DEVICES_IDLE_TTL_MS = 90 * DAY_MS;
const USAGE_TTL_DAYS = 30;

/**
 * Тонкие синхронные хелперы над схемой из src/db.ts (bun:sqlite).
 * Все ключи — уже хешированные IdentityKeys, сырых id здесь нет.
 */
export class LimiterStore {
  constructor(private readonly db: Database) {}

  /** db.query с явной типизацией строки результата (bun-типы требуют два type-аргумента). */
  private q<Row>(sql: string): Statement<Row, SQLQueryBindings[]> {
    return this.db.query<Row, SQLQueryBindings[]>(sql);
  }

  /** +1 к счётчику окна, возвращает новое значение (upsert). */
  bumpCounter(scope: string, key: string, period: Period, windowStart: number): number {
    const row = this
      .q<{ count: number }>(
        `INSERT INTO counters (scope, key, period, window_start, count) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(scope, key, period, window_start) DO UPDATE SET count = count + 1
         RETURNING count`,
      )
      .get(scope, key, period, windowStart);
    return row?.count ?? 0;
  }

  /** Текущее значение счётчика окна без инкремента (0, если окна нет). */
  readCounter(scope: string, key: string, period: Period, windowStart: number): number {
    const row = this.q<{ count: number }>(
      'SELECT count FROM counters WHERE scope = ? AND key = ? AND period = ? AND window_start = ?',
    ).get(scope, key, period, windowStart);
    return row?.count ?? 0;
  }

  /** first_seen устройства; INSERT OR IGNORE + SELECT — при повторных визитах остаётся первый. */
  upsertDeviceFirstSeen(idkey: string, nowMs: number): number {
    this.q('INSERT OR IGNORE INTO devices (idkey, first_seen, last_seen) VALUES (?, ?, ?)').run(idkey, nowMs, nowMs);
    const row = this.q<{ first_seen: number }>('SELECT first_seen FROM devices WHERE idkey = ?').get(idkey);
    if (!row) throw new Error(`LimiterStore: device row missing after upsert (${idkey.slice(0, 8)})`);
    return row.first_seen;
  }

  touchDeviceLastSeen(idkey: string, nowMs: number): void {
    this.q('UPDATE devices SET last_seen = ? WHERE idkey = ?').run(nowMs, idkey);
  }

  addIpDevice(ipkey: string, day: string, idkey: string): void {
    this.q('INSERT OR IGNORE INTO ip_devices (ipkey, day, idkey) VALUES (?, ?, ?)').run(ipkey, day, idkey);
  }

  countIpDevices(ipkey: string, day: string): number {
    const row = this.q<{ n: number }>('SELECT COUNT(*) AS n FROM ip_devices WHERE ipkey = ? AND day = ?').get(ipkey, day);
    return row?.n ?? 0;
  }

  /** +1 к дневным запросам, возвращает новое значение. */
  bumpDailyRequests(day: string): number {
    const row = this.q<{ requests: number }>(
      `INSERT INTO usage_daily (day, requests) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET requests = requests + 1
       RETURNING requests`,
    ).get(day);
    return row?.requests ?? 0;
  }

  readDailyUsage(day: string): { requests: number; promptTokens: number; completionTokens: number } {
    const row = this.q<{ requests: number; prompt_tokens: number; completion_tokens: number }>(
      'SELECT requests, prompt_tokens, completion_tokens FROM usage_daily WHERE day = ?',
    ).get(day);
    if (!row) return { requests: 0, promptTokens: 0, completionTokens: 0 };
    return { requests: row.requests, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens };
  }

  addDailyTokens(day: string, prompt: number, completion: number): void {
    this.q(
      `INSERT INTO usage_daily (day, prompt_tokens, completion_tokens) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         prompt_tokens = prompt_tokens + ?,
         completion_tokens = completion_tokens + ?`,
    ).run(day, prompt, completion, prompt, completion);
  }

  bumpDailyContractFails(day: string): void {
    this.q(
      `INSERT INTO usage_daily (day, contract_fails) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET contract_fails = contract_fails + 1`,
    ).run(day);
  }

  /** Чистка: counters >2 суток, ip_devices >2 суток, devices без активности >90 суток, usage_daily >30 суток. */
  purgeExpired(nowMs: number): void {
    this.q('DELETE FROM counters WHERE window_start < ?').run(nowMs - COUNTERS_TTL_MS);
    this.q('DELETE FROM ip_devices WHERE day < ?').run(utcDayString(nowMs - IP_DEVICES_TTL_DAYS * DAY_MS));
    this.q('DELETE FROM devices WHERE last_seen < ?').run(nowMs - DEVICES_IDLE_TTL_MS);
    this.q('DELETE FROM usage_daily WHERE day < ?').run(utcDayString(nowMs - USAGE_TTL_DAYS * DAY_MS));
  }
}
