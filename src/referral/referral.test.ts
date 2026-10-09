import { describe, expect, test } from 'bun:test';
import { openDb } from '../db.ts';
import { HttpError } from '../errors.ts';
import { DAY_MS } from '../util/time.ts';
import { generateReferralCode, normalizeReferralCode } from './codes.ts';
import { runIpRetention, startIpRetention } from './retention.ts';
import { ReferralStore, type InstallRow } from './store.ts';
import { parseEmail, parseInstall } from './validate.ts';

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

function install(overrides: Partial<InstallRow> = {}): InstallRow {
  return {
    deviceId: 'd'.repeat(64),
    refCode: null,
    source: 'play_organic',
    build: 'play',
    appVersion: '1.2.3',
    osVersion: 'Android 14',
    locale: 'ru-RU',
    ip: '203.0.113.7',
    ...overrides,
  };
}

function invalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    return;
  }
  throw new Error('ожидалась HttpError 400');
}

describe('коды', () => {
  test('16 символов алфавита без неоднозначных (I, L, O, U), уникальны', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
  });

  test('80 бит: все биты входа попадают в код (детерминированный источник)', () => {
    expect(generateReferralCode((b) => b.fill(0))).toBe('0000000000000000');
    expect(generateReferralCode((b) => b.fill(255))).toBe('ZZZZZZZZZZZZZZZZ');
  });

  test('normalize: регистр, пробелы и Crockford-замены; мусор → null', () => {
    expect(normalizeReferralCode(' 0abcdefghjkmnpqr ')).toBe('0ABCDEFGHJKMNPQR');
    expect(normalizeReferralCode('OIL0OIL0OIL0OIL0')).toBe('0110011001100110');
    expect(normalizeReferralCode('short')).toBeNull();
    expect(normalizeReferralCode('U'.repeat(16))).toBeNull();
    expect(normalizeReferralCode('0'.repeat(17))).toBeNull();
  });
});

describe('валидация', () => {
  test('email: нормализация и отказы', () => {
    expect(parseEmail('  User@Example.COM ')).toBe('user@example.com');
    for (const bad of ['', 'nope', 'a@b', '@x.com', 'a b@x.com', 'a@x..com', 'a@@x.com', '<a>@x.com', 42, null, {}]) {
      invalid(() => parseEmail(bad));
    }
    invalid(() => parseEmail(`${'a'.repeat(250)}@x.com`));
    invalid(() => parseEmail(`${'a'.repeat(65)}@x.com`));
  });

  test('install: валидное тело и граничные ошибки', () => {
    const ok = parseInstall({
      ref_code: 'whatever',
      source: 'play_referral',
      build: 'play',
      app_version: '1.0.0+5',
      os_version: 'Android 14 (SDK 34)',
      locale: 'ru_RU',
    });
    expect(ok.refCodeRaw).toBe('whatever');
    expect(ok.build).toBe('play');

    const base = { source: 's', build: 'full', app_version: '1', os_version: '14', locale: 'en' };
    expect(parseInstall(base).refCodeRaw).toBeNull();
    expect(parseInstall({ ...base, ref_code: null }).refCodeRaw).toBeNull();
    // слишком длинный ref_code не ошибка — просто не наш код
    expect(parseInstall({ ...base, ref_code: 'x'.repeat(300) }).refCodeRaw).toBeNull();

    invalid(() => parseInstall({ ...base, ref_code: 5 }));
    invalid(() => parseInstall({ ...base, build: 'beta' }));
    invalid(() => parseInstall({ ...base, source: 'Bad Source!' }));
    invalid(() => parseInstall({ ...base, source: 'x'.repeat(33) }));
    invalid(() => parseInstall({ ...base, app_version: '' }));
    invalid(() => parseInstall({ ...base, app_version: '1'.repeat(33) }));
    invalid(() => parseInstall({ ...base, os_version: 'a'.repeat(65) }));
    invalid(() => parseInstall({ ...base, os_version: 'x\n<script>' }));
    invalid(() => parseInstall({ ...base, locale: 'not a locale' }));
    invalid(() => parseInstall({ ...base, locale: undefined }));
  });
});

describe('ReferralStore', () => {
  test('getOrCreateCode: один email — один код; разные email — разные коды', () => {
    const store = new ReferralStore(openDb(':memory:'));
    const a = store.getOrCreateCode('a@x.com', T0);
    expect(store.getOrCreateCode('a@x.com', T0 + 1000)).toBe(a);
    expect(store.getOrCreateCode('b@x.com', T0)).not.toBe(a);
    expect(store.codeExists(a)).toBe(true);
    expect(store.codeExists('0'.repeat(16))).toBe(false);
  });

  test('insertInstall: первая запись по device_id побеждает', () => {
    const store = new ReferralStore(openDb(':memory:'));
    expect(store.insertInstall(install({ source: 'first' }), T0)).toBe(true);
    expect(store.insertInstall(install({ source: 'second', refCode: 'X' }), T0 + 5)).toBe(false);
    expect(store.installStats().bySource).toEqual([{ source: 'first', count: 1 }]);
  });

  test('ретеншн IP: обнуляет только старше срока, остальные поля и свежие IP целы', () => {
    const db = openDb(':memory:');
    const store = new ReferralStore(db);
    const code = store.getOrCreateCode('a@x.com', T0);
    store.insertInstall(install({ deviceId: 'old'.padEnd(64, '0'), refCode: code, ip: '198.51.100.1' }), T0);
    store.insertInstall(install({ deviceId: 'edge'.padEnd(64, '0'), ip: '198.51.100.2' }), T0 + 10 * DAY_MS);
    store.insertInstall(install({ deviceId: 'new'.padEnd(64, '0'), ip: '198.51.100.3' }), T0 + 95 * DAY_MS);
    store.insertInstall(install({ deviceId: 'noip'.padEnd(64, '0'), ip: null }), T0);

    const now = T0 + 100 * DAY_MS;
    // old (100 сут.) и edge (90 сут. ровно — граница не включается), срок 90.
    expect(store.nullOldIps(now, 90)).toBe(1);
    const rows = db
      .query<{ device_id: string; ip: string | null; ref_code: string | null }, []>(
        'SELECT device_id, ip, ref_code FROM install_events ORDER BY id',
      )
      .all();
    expect(rows.map((r) => r.ip)).toEqual([null, '198.51.100.2', '198.51.100.3', null]);
    expect(rows[0]?.ref_code).toBe(code); // связь с кодом сохранена
    // повторный прогон ничего не меняет
    expect(store.nullOldIps(now, 90)).toBe(0);
    // позже созреет и edge
    expect(store.nullOldIps(now + 1 * DAY_MS, 90)).toBe(1);
  });

  test('adminReferrals и installStats: счётчики по коду, день/источник/сборка', () => {
    const store = new ReferralStore(openDb(':memory:'));
    const a = store.getOrCreateCode('a@x.com', T0);
    const b = store.getOrCreateCode('b@x.com', T0);
    store.insertInstall(install({ deviceId: '1'.repeat(64), refCode: a, source: 'play' }), T0);
    store.insertInstall(install({ deviceId: '2'.repeat(64), refCode: a, source: 'play_referral' }), T0 + 1000);
    store.insertInstall(install({ deviceId: '3'.repeat(64), build: 'full', source: 'direct' }), T0 + DAY_MS);
    const rows = store.adminReferrals({ limit: 100 });
    expect(rows.map((r) => [r.code, r.countedInstalls, r.totalInstalls])).toEqual([
      [a, 1, 2],
      [b, 0, 0],
    ]);
    expect(rows[0]?.installs.map((i) => i.deviceId)).toEqual(['1'.repeat(64), '2'.repeat(64)]);
    const stats = store.installStats();
    expect(stats.total).toBe(3);
    expect(stats.withRefCode).toBe(2);
    expect(stats.byDay).toEqual([
      { day: '2026-10-04', count: 2 },
      { day: '2026-10-05', count: 1 },
    ]);
    expect(stats.bySource).toEqual([
      { source: 'direct', count: 1 },
      { source: 'play', count: 1 },
      { source: 'play_referral', count: 1 },
    ]);
    expect(stats.byBuild).toEqual([
      { build: 'play', count: 2 },
      { build: 'full', count: 1 },
    ]);
  });
});

describe('засчитанные друзья (counted)', () => {
  const dev = (n: number) => String(n).padStart(64, '0');

  test('считаются только source=play и build=play с ref_code; full, прочие источники и без кода — нет', () => {
    const store = new ReferralStore(openDb(':memory:'));
    const a = store.getOrCreateCode('a@x.com', T0);
    store.insertInstall(install({ deviceId: dev(1), refCode: a, source: 'play', build: 'play' }), T0);
    store.insertInstall(install({ deviceId: dev(2), refCode: a, source: 'play', build: 'full' }), T0 + 1);
    store.insertInstall(install({ deviceId: dev(3), refCode: a, source: 'manual', build: 'play' }), T0 + 2);
    store.insertInstall(install({ deviceId: dev(4), refCode: a, source: 'play_referral', build: 'play' }), T0 + 3);
    store.insertInstall(install({ deviceId: dev(5), refCode: null, source: 'play', build: 'play' }), T0 + 4);
    const [row] = store.adminReferrals({ limit: 10 });
    expect(row?.countedInstalls).toBe(1);
    expect(row?.totalInstalls).toBe(4);
    expect(row?.installs.map((i) => i.counted)).toEqual([true, false, false, false]);
  });

  test('одно устройство — один зачёт: повторный install (и под другим кодом) не прибавляет', () => {
    const store = new ReferralStore(openDb(':memory:'));
    const a = store.getOrCreateCode('a@x.com', T0);
    const b = store.getOrCreateCode('b@x.com', T0);
    expect(store.insertInstall(install({ deviceId: dev(1), refCode: a, source: 'play' }), T0)).toBe(true);
    expect(store.insertInstall(install({ deviceId: dev(1), refCode: a, source: 'play' }), T0 + 1)).toBe(false);
    expect(store.insertInstall(install({ deviceId: dev(1), refCode: b, source: 'play' }), T0 + 2)).toBe(false);
    const rows = store.adminReferrals({ limit: 10 });
    expect(rows.find((r) => r.code === a)?.countedInstalls).toBe(1);
    expect(rows.find((r) => r.code === b)?.countedInstalls).toBe(0);
  });

  test('minCounted: порог включительно, фильтр до limit; сортировка по засчитанным', () => {
    const store = new ReferralStore(openDb(':memory:'));
    const codes = ['a', 'b', 'c'].map((n) => store.getOrCreateCode(`${n}@x.com`, T0));
    let n = 0;
    const add = (code: string, count: number, source = 'play') => {
      for (let k = 0; k < count; k += 1) {
        n += 1;
        store.insertInstall(install({ deviceId: dev(n), refCode: code, source }), T0 + n);
      }
    };
    add(codes[0] as string, 2);
    add(codes[1] as string, 3);
    add(codes[2] as string, 5, 'direct'); // много установок, но ни одной засчитанной
    expect(store.adminReferrals({ limit: 10 }).map((r) => [r.countedInstalls, r.totalInstalls])).toEqual([
      [3, 3],
      [2, 2],
      [0, 5],
    ]);
    expect(store.adminReferrals({ limit: 10, minCounted: 3 }).map((r) => r.code)).toEqual([codes[1] as string]);
    expect(store.adminReferrals({ limit: 10, minCounted: 2 })).toHaveLength(2);
    expect(store.adminReferrals({ limit: 1, minCounted: 2 })).toHaveLength(1);
    expect(store.adminReferrals({ limit: 10, minCounted: 4 })).toHaveLength(0);
  });
});

describe('runIpRetention', () => {
  const silent = { info: () => {}, warn: () => {} };

  test('обнуляет просроченные IP и возвращает их число; логирует без значений IP', () => {
    const db = openDb(':memory:');
    const store = new ReferralStore(db);
    store.insertInstall(install({ deviceId: '1'.repeat(64), ip: '198.51.100.1' }), T0);
    store.insertInstall(install({ deviceId: '2'.repeat(64), ip: '198.51.100.2' }), T0 + 80 * DAY_MS);
    const lines: string[] = [];
    const log = { info: (m: string, f?: object) => lines.push(m + JSON.stringify(f)), warn: () => {} };
    expect(runIpRetention(db, 30, log, T0 + 100 * DAY_MS)).toBe(1);
    expect(lines.join('')).not.toContain('198.51');
    const ips = db.query<{ ip: string | null }, []>('SELECT ip FROM install_events ORDER BY id').all();
    expect(ips.map((r) => r.ip)).toEqual([null, '198.51.100.2']);
  });

  test('сбой БД не бросает: 0 и warn', () => {
    const db = openDb(':memory:');
    db.close();
    const warns: string[] = [];
    expect(runIpRetention(db, 30, { info: () => {}, warn: (m: string) => warns.push(m) })).toBe(0);
    expect(warns).toEqual(['ip retention failed']);
  });

  test('startIpRetention чистит сразу на старте; таймер можно остановить', () => {
    const db = openDb(':memory:');
    new ReferralStore(db).insertInstall(install({ ip: '198.51.100.1' }), Date.now() - 200 * DAY_MS);
    const timer = startIpRetention(db, 90, silent);
    clearInterval(timer);
    expect(db.query<{ ip: string | null }, []>('SELECT ip FROM install_events').get()?.ip).toBeNull();
  });
});
