import { describe, expect, test } from 'bun:test';
import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { deriveIdentity } from '../identity/device.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDayString } from '../util/time.ts';
import { RuntimeState } from '../state.ts';
import { Limiter } from './limiter.ts';

const SECRET = 'test-hmac-secret';
/** 2026-10-04T12:00:00Z — фиксированная точка для детерминированных окон. */
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

const BASE_ENV: Record<string, string> = {
  APP_ENV: 'test',
  GLOBAL_MAX_INFLIGHT: '8',
  GLOBAL_DAILY_REQUEST_CAP: '1000000',
  GLOBAL_DAILY_TOKEN_CAP: '1000000000',
  LIMIT_IP_MINUTE: '1000',
  LIMIT_IP_HOUR: '1000',
  LIMIT_IP_DAY: '1000',
  LIMIT_SUBNET_DAY: '1000',
  LIMIT_IP_DISTINCT_DEVICES_DAY: '100',
  LIMIT_DEVICE_MINUTE: '1000',
  LIMIT_DEVICE_HOUR: '1000',
  LIMIT_DEVICE_DAY: '1000',
  LIMIT_FRESH_DEVICE_HOURS: '1',
  LIMIT_FRESH_DEVICE_DAY: '1000',
  LIMIT_CONTRACT_FAILS_PER_HOUR: '1000',
};

function makeLimiter(overrides: Record<string, string> = {}): {
  limiter: Limiter;
  db: Database;
  state: RuntimeState;
} {
  const db = openDb(':memory:');
  const config = loadConfig({ ...BASE_ENV, ...overrides });
  const state = new RuntimeState();
  return { limiter: new Limiter(db, config, state), db, state };
}

/** db.query с явной типизацией строки (bun-типы требуют два type-аргумента). */
function q<Row>(db: Database, sql: string): Statement<Row, SQLQueryBindings[]> {
  return db.query<Row, SQLQueryBindings[]>(sql);
}

function metric(state: RuntimeState, name: string): number {
  return state.snapshot()[name] ?? 0;
}

const dev1AtA = (): ReturnType<typeof deriveIdentity> => deriveIdentity(SECRET, 'device-1', '203.0.113.10');
const dev2AtA = (): ReturnType<typeof deriveIdentity> => deriveIdentity(SECRET, 'device-2', '203.0.113.10');
const dev3AtA = (): ReturnType<typeof deriveIdentity> => deriveIdentity(SECRET, 'device-3', '203.0.113.10');
const dev9AtB = (): ReturnType<typeof deriveIdentity> => deriveIdentity(SECRET, 'device-9', '198.51.100.5');

function tableCount(db: Database, sql: string): number {
  return q<{ n: number }>(db, sql).get()?.n ?? 0;
}

describe('Limiter.beginRequest', () => {
  test('first request is allowed with fresh-device verdict', () => {
    const { limiter, state } = makeLimiter();
    const v = limiter.beginRequest(dev1AtA(), T0);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBeUndefined();
    expect(v.retryAfterSeconds).toBeUndefined();
    expect(v.deviceDayLimit).toBe(1000);
    expect(v.deviceDayRemaining).toBe(999);
    expect(v.deviceDayResetSeconds).toBeGreaterThan(0);
    expect(metric(state, 'limit_allow')).toBe(1);
  });

  test('fresh device gets the lower day cap', () => {
    const { limiter, state } = makeLimiter({
      LIMIT_FRESH_DEVICE_HOURS: '24',
      LIMIT_FRESH_DEVICE_DAY: '1',
      LIMIT_DEVICE_DAY: '5',
    });
    const first = limiter.beginRequest(dev1AtA(), T0);
    expect(first.allowed).toBe(true);
    expect(first.deviceDayLimit).toBe(1);

    const second = limiter.beginRequest(dev1AtA(), T0 + 1000);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('device_day');
    expect(second.deviceDayLimit).toBe(1);
    expect(second.deviceDayRemaining).toBe(0);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(metric(state, 'rate_limited_device_day')).toBe(1);
  });

  test('aged device (backdated firstSeen) gets the normal day cap', () => {
    const { limiter } = makeLimiter({
      LIMIT_FRESH_DEVICE_HOURS: '24',
      LIMIT_FRESH_DEVICE_DAY: '1',
      LIMIT_DEVICE_DAY: '5',
    });
    // Первый визит фиксирует first_seen = T0; через 25 часов устройство уже не fresh.
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);

    const aged = limiter.beginRequest(dev1AtA(), T0 + 25 * HOUR_MS);
    expect(aged.allowed).toBe(true);
    expect(aged.deviceDayLimit).toBe(5);
    expect(aged.deviceDayRemaining).toBe(4);

    // Дожигаем дневной лимит уже взрослого устройства (всё ещё тот же UTC-день).
    const hours = [26, 27, 28, 29, 30];
    for (const [i, h] of hours.entries()) {
      const v = limiter.beginRequest(dev1AtA(), T0 + h * HOUR_MS);
      if (i < hours.length - 1) {
        expect(v.allowed).toBe(true);
      } else {
        expect(v.allowed).toBe(false);
        expect(v.reason).toBe('device_day');
      }
    }
  });

  test('device_minute denies and the window resets after the minute', () => {
    const { limiter, db } = makeLimiter({ LIMIT_DEVICE_MINUTE: '1' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);

    const denied = limiter.beginRequest(dev1AtA(), T0 + 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('device_minute');
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Счётчик инкрементирован и при отказе — нарушитель сжигает своё окно.
    expect(
      tableCount(
        db,
        `SELECT COUNT(*) AS n FROM counters WHERE scope='dev' AND period='minute' AND count=2`,
      ),
    ).toBe(1);

    expect(limiter.beginRequest(dev1AtA(), T0 + 61 * 1000).allowed).toBe(true);
  });

  test('devices are independent within one minute', () => {
    const { limiter } = makeLimiter({ LIMIT_DEVICE_MINUTE: '1' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    expect(limiter.beginRequest(dev2AtA(), T0).allowed).toBe(true);
    const again = limiter.beginRequest(dev1AtA(), T0 + 1000);
    expect(again.reason).toBe('device_minute');
  });

  test('ip_minute denies a second device behind the same ip', () => {
    const { limiter, state } = makeLimiter({ LIMIT_IP_MINUTE: '1' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    const denied = limiter.beginRequest(dev2AtA(), T0);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('ip_minute');
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(metric(state, 'rate_limited_ip_minute')).toBe(1);
  });

  test('ip_hour denies within the hour window', () => {
    const { limiter } = makeLimiter({ LIMIT_IP_HOUR: '1' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    const denied = limiter.beginRequest(dev2AtA(), T0 + MINUTE_MS);
    expect(denied.reason).toBe('ip_hour');
    expect(limiter.beginRequest(dev1AtA(), T0 + 61 * MINUTE_MS).allowed).toBe(true);
  });

  test('ip_day denies within the day window', () => {
    const { limiter } = makeLimiter({ LIMIT_IP_DAY: '1' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    const denied = limiter.beginRequest(dev2AtA(), T0 + MINUTE_MS);
    expect(denied.reason).toBe('ip_day');
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Новый UTC-день — новое окно.
    expect(limiter.beginRequest(dev1AtA(), T0 + 24 * HOUR_MS).allowed).toBe(true);
  });

  test('subnet_day denies across ips of one /24 but not other subnets', () => {
    const { limiter } = makeLimiter({ LIMIT_SUBNET_DAY: '1' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    const sameSubnet = limiter.beginRequest(deriveIdentity(SECRET, 'device-2', '203.0.113.11'), T0);
    expect(sameSubnet.allowed).toBe(false);
    expect(sameSubnet.reason).toBe('subnet_day');
    expect(limiter.beginRequest(dev9AtB(), T0).allowed).toBe(true);
  });

  test('ip_devices rotation cap denies a third id from one ip per day', () => {
    const { limiter } = makeLimiter({ LIMIT_IP_DISTINCT_DEVICES_DAY: '2' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    expect(limiter.beginRequest(dev2AtA(), T0).allowed).toBe(true);
    const rotated = limiter.beginRequest(dev3AtA(), T0);
    expect(rotated.allowed).toBe(false);
    expect(rotated.reason).toBe('ip_devices');
    expect(rotated.retryAfterSeconds).toBeGreaterThan(0);
    // Другой IP ничем не ограничен.
    expect(limiter.beginRequest(dev9AtB(), T0).allowed).toBe(true);
  });

  test('global request cap denies everyone', () => {
    const { limiter } = makeLimiter({ GLOBAL_DAILY_REQUEST_CAP: '1' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    const denied = limiter.beginRequest(dev9AtB(), T0);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('global_day');
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('global token cap denies after recordSuccess with big tokens', () => {
    const { limiter } = makeLimiter({ GLOBAL_DAILY_TOKEN_CAP: '100' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    limiter.recordSuccess(dev1AtA(), 90, 20, T0);
    const denied = limiter.beginRequest(dev9AtB(), T0 + 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('global_day');
  });

  test('contract fails block the device after threshold, check-only, per hour', () => {
    const { limiter, db, state } = makeLimiter({ LIMIT_CONTRACT_FAILS_PER_HOUR: '2' });
    expect(limiter.beginRequest(dev1AtA(), T0).allowed).toBe(true);
    limiter.recordContractFail(dev1AtA(), T0);
    limiter.recordContractFail(dev1AtA(), T0);

    const denied = limiter.beginRequest(dev1AtA(), T0 + 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('contract_fails');
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Проверка не инкрементирует cfail (осталось 2, не 3), и другие устройства не блокируются.
    expect(tableCount(db, `SELECT COUNT(*) AS n FROM counters WHERE scope='cfail' AND count=2`)).toBe(1);
    expect(limiter.beginRequest(dev2AtA(), T0 + 1000).allowed).toBe(true);
    // Новый час — блокировка снята.
    expect(limiter.beginRequest(dev1AtA(), T0 + 61 * MINUTE_MS).allowed).toBe(true);
  });

  test('recordSuccess accumulates tokens and touches last_seen', () => {
    const { limiter, db } = makeLimiter();
    limiter.beginRequest(dev1AtA(), T0);
    limiter.recordSuccess(dev1AtA(), 10, 5, T0);
    limiter.recordSuccess(dev1AtA(), 7, 3, T0 + MINUTE_MS);
    const usage = q<{ prompt_tokens: number; completion_tokens: number }>(
      db,
      'SELECT prompt_tokens, completion_tokens FROM usage_daily WHERE day = ?',
    ).get(utcDayString(T0));
    expect(usage?.prompt_tokens).toBe(17);
    expect(usage?.completion_tokens).toBe(8);
    const lastSeen = q<{ last_seen: number }>(db, 'SELECT last_seen FROM devices WHERE idkey = ?').get(dev1AtA().idkey);
    expect(lastSeen?.last_seen).toBe(T0 + MINUTE_MS);
  });

  test('purge removes expired rows and keeps fresh ones', () => {
    const { limiter, db } = makeLimiter();
    limiter.beginRequest(dev1AtA(), T0);
    limiter.recordSuccess(dev1AtA(), 10, 5, T0);
    limiter.recordContractFail(dev1AtA(), T0);

    const staleDay = utcDayString(T0 - 3 * DAY_MS);
    q(db, "INSERT INTO counters (scope, key, period, window_start, count) VALUES ('ip', 'stale-ip', 'day', ?, 1)").run(
      T0 - 3 * DAY_MS,
    );
    q(db, 'INSERT INTO ip_devices (ipkey, day, idkey) VALUES (?, ?, ?)').run('stale-ipkey', staleDay, 'stale-idkey');
    q(db, 'INSERT INTO devices (idkey, first_seen, last_seen) VALUES (?, ?, ?)').run(
      'stale-idkey',
      T0 - 91 * DAY_MS,
      T0 - 91 * DAY_MS,
    );
    q(db, 'INSERT INTO usage_daily (day, requests) VALUES (?, 1)').run(utcDayString(T0 - 31 * DAY_MS));

    limiter.purge(T0);

    // Свежие строки на месте: 7 счётчиков разрешённого запроса + 1 ip_device + 1 device + 1 usage_daily.
    expect(tableCount(db, 'SELECT COUNT(*) AS n FROM counters')).toBe(8);
    expect(tableCount(db, 'SELECT COUNT(*) AS n FROM ip_devices')).toBe(1);
    expect(tableCount(db, 'SELECT COUNT(*) AS n FROM devices')).toBe(1);
    expect(tableCount(db, 'SELECT COUNT(*) AS n FROM usage_daily')).toBe(1);
    expect(tableCount(db, `SELECT COUNT(*) AS n FROM devices WHERE idkey='stale-idkey'`)).toBe(0);
  });
});
