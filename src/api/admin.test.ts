import { describe, expect, test } from 'bun:test';
import { ADMIN_TOKEN, DEVICE_A, DEVICE_B, DEVICE_C, post, withRefApp, type RefApp } from './test-helpers.ts';

const ENV = { ADMIN_TOKEN };

function admin(app: RefApp, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = init.token === undefined ? ADMIN_TOKEN : init.token;
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  return fetch(`${app.base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
}

const INSTALL = { source: 'play_organic', build: 'play', app_version: '1.0.0', os_version: '14', locale: 'ru' };

const ADMIN_PATHS: Array<[string, string]> = [
  ['GET', '/admin/referrals'],
  ['GET', '/admin/installs/stats'],
];

describe('админка: авторизация', () => {
  test('ADMIN_TOKEN не задан → все /admin/* — 404, даже с «токеном»', async () => {
    await withRefApp({}, async (app) => {
      for (const [method, path] of ADMIN_PATHS) {
        for (const token of [null, ADMIN_TOKEN, '']) {
          const res = await admin(app, path, { method, token, body: method === 'POST' ? { action: 'approve' } : undefined });
          expect(res.status).toBe(404);
        }
      }
    });
  });

  test('без токена, с чужим токеном, с токеном-префиксом, с deviceId, не Bearer → 401', async () => {
    await withRefApp(ENV, async (app) => {
      const bad: Array<string | null> = [null, 'wrong', ADMIN_TOKEN.slice(0, -1), ADMIN_TOKEN + 'x', DEVICE_A, ''];
      for (const [method, path] of ADMIN_PATHS) {
        for (const token of bad) {
          const res = await admin(app, path, { method, token });
          expect(res.status).toBe(401);
        }
        const basic = await fetch(`${app.base}${path}`, { method, headers: { authorization: `Basic ${ADMIN_TOKEN}` } });
        expect(basic.status).toBe(401);
      }
      expect(app.state.snapshot()['admin_auth_fail']).toBeGreaterThan(0);
    });
  });

  test('верный токен, неверный метод → 405; неизвестный /admin/x → 404', async () => {
    await withRefApp(ENV, async (app) => {
      expect((await admin(app, '/admin/referrals', { method: 'POST', body: {} })).status).toBe(405);
      expect((await admin(app, '/admin/nope')).status).toBe(404);
    });
  });

  test('deviceId-Bearer публичных путей не открывает админку, а админ-токен не годится как deviceId', async () => {
    await withRefApp(ENV, async (app) => {
      expect((await post(app, '/v1/install', INSTALL, ADMIN_TOKEN)).status).toBe(401);
    });
  });
});

/** Валидный deviceId (32 hex) с номером — для сценариев с несколькими устройствами. */
const dev = (n: number): string => n.toString(16).padStart(32, '0');

interface ReferralsBody {
  threshold: number;
  referrals: Array<{
    code: string;
    email: string;
    counted_installs: number;
    total_installs: number;
    qualified: boolean;
    installs: Array<{ device_id: string; ip: string | null; created_at: string; source: string; build: string; counted: boolean }>;
  }>;
}

async function newCode(app: RefApp, email: string): Promise<string> {
  return ((await (await post(app, '/v1/referral/code', { email })).json()) as { code: string }).code;
}

async function installs(app: RefApp, code: string, count: number, from: number, extra: Record<string, string> = {}): Promise<void> {
  for (let n = from; n < from + count; n += 1) {
    expect((await post(app, '/v1/install', { ...INSTALL, ref_code: code, source: 'play', ...extra }, dev(n))).status).toBe(204);
  }
}

describe('GET /admin/referrals', () => {
  test('по коду: email, counted/total, qualified, device_id + ip + время', async () => {
    await withRefApp(ENV, async (app) => {
      const code = await newCode(app, 'Ref@Example.com');
      await post(app, '/v1/referral/code', { email: 'lonely@example.com' }, DEVICE_C);
      await post(app, '/v1/install', { ...INSTALL, ref_code: code, source: 'play' }, DEVICE_A);
      await post(app, '/v1/install', { ...INSTALL, ref_code: code, source: 'play_referral' }, DEVICE_B); // не play-источник
      await post(app, '/v1/install', INSTALL, DEVICE_C); // без кода — в рефералы не попадает

      const res = await admin(app, '/admin/referrals');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as ReferralsBody;
      expect(body.threshold).toBe(3);
      expect(body.referrals).toHaveLength(2);
      const top = body.referrals[0];
      expect(top?.code).toBe(code);
      expect(top?.email).toBe('ref@example.com');
      expect(top?.counted_installs).toBe(1);
      expect(top?.total_installs).toBe(2);
      expect(top?.qualified).toBe(false);
      expect(top?.installs).toHaveLength(2);
      expect(top?.installs.map((i) => [i.source, i.counted])).toEqual([
        ['play', true],
        ['play_referral', false],
      ]);
      for (const install of top?.installs ?? []) {
        expect(install.device_id).toMatch(/^[0-9a-f]{64}$/);
        expect(install.ip).toBe('::ffff:127.0.0.1');
        expect(install.build).toBe('play');
        expect(Number.isNaN(Date.parse(install.created_at))).toBe(false);
      }
      expect(body.referrals[1]?.counted_installs).toBe(0);
      expect(body.referrals[1]?.total_installs).toBe(0);
    });
  });

  test('qualified = counted_installs >= REFERRAL_THRESHOLD (порог из env, включительно)', async () => {
    await withRefApp({ ...ENV, REFERRAL_THRESHOLD: '3' }, async (app) => {
      const two = await newCode(app, 'two@example.com');
      const three = await newCode(app, 'three@example.com');
      await installs(app, two, 2, 1);
      await installs(app, three, 3, 10);
      const body = (await (await admin(app, '/admin/referrals')).json()) as ReferralsBody;
      expect(body.referrals.map((r) => [r.code, r.counted_installs, r.qualified])).toEqual([
        [three, 3, true],
        [two, 2, false],
      ]);
    });
    await withRefApp({ ...ENV, REFERRAL_THRESHOLD: '2' }, async (app) => {
      const two = await newCode(app, 'two@example.com');
      await installs(app, two, 2, 1);
      const body = (await (await admin(app, '/admin/referrals')).json()) as ReferralsBody;
      expect(body.threshold).toBe(2);
      expect(body.referrals[0]?.qualified).toBe(true);
    });
  });

  test('не засчитываются: build=full, чужой source, установка без кода, повтор того же устройства', async () => {
    await withRefApp(ENV, async (app) => {
      const code = await newCode(app, 'a@example.com');
      await installs(app, code, 1, 1); // засчитана
      await installs(app, code, 1, 1); // то же устройство — повтор игнорируется
      await installs(app, code, 1, 2, { build: 'full' });
      await installs(app, code, 1, 3, { source: 'manual' });
      await post(app, '/v1/install', { ...INSTALL, source: 'play' }, dev(4)); // без кода
      const row = ((await (await admin(app, '/admin/referrals')).json()) as ReferralsBody).referrals[0];
      expect(row?.counted_installs).toBe(1);
      expect(row?.total_installs).toBe(3);
      expect(row?.qualified).toBe(false);
    });
  });

  test('?qualified=1 — только достигшие порога; пусто, если таких нет; прочие значения → 400', async () => {
    await withRefApp(ENV, async (app) => {
      const low = await newCode(app, 'low@example.com');
      const high = await newCode(app, 'high@example.com');
      await installs(app, low, 2, 1);
      let body = (await (await admin(app, '/admin/referrals?qualified=1')).json()) as ReferralsBody;
      expect(body.referrals).toEqual([]);
      await installs(app, high, 4, 10);
      body = (await (await admin(app, '/admin/referrals?qualified=1')).json()) as ReferralsBody;
      expect(body.referrals.map((r) => [r.code, r.qualified])).toEqual([[high, true]]);
      // фильтр применяется до limit
      body = (await (await admin(app, '/admin/referrals?qualified=1&limit=1')).json()) as ReferralsBody;
      expect(body.referrals).toHaveLength(1);
      expect(((await (await admin(app, '/admin/referrals')).json()) as ReferralsBody).referrals).toHaveLength(2);
      for (const bad of ['0', 'true', '', 'yes']) {
        expect((await admin(app, `/admin/referrals?qualified=${bad}`)).status).toBe(400);
      }
    });
  });

  test('limit валидируется', async () => {
    await withRefApp(ENV, async (app) => {
      expect((await admin(app, '/admin/referrals?limit=1')).status).toBe(200);
      for (const bad of ['0', '-1', 'x', '1.5', '999999']) {
        expect((await admin(app, `/admin/referrals?limit=${bad}`)).status).toBe(400);
      }
    });
  });
});

describe('GET /admin/installs/stats', () => {
  test('по дням, источникам и сборкам', async () => {
    await withRefApp(ENV, async (app) => {
      await post(app, '/v1/install', INSTALL, DEVICE_A);
      await post(app, '/v1/install', { ...INSTALL, source: 'play_referral' }, DEVICE_B);
      await post(app, '/v1/install', { ...INSTALL, build: 'full', source: 'direct' }, DEVICE_C);
      const body = (await (await admin(app, '/admin/installs/stats')).json()) as Record<string, unknown>;
      const today = new Date().toISOString().slice(0, 10);
      expect(body['total']).toBe(3);
      expect(body['with_ref_code']).toBe(0);
      expect(body['by_day']).toEqual([{ day: today, count: 3 }]);
      expect(body['by_source']).toEqual([
        { source: 'direct', count: 1 },
        { source: 'play_organic', count: 1 },
        { source: 'play_referral', count: 1 },
      ]);
      expect(body['by_build']).toEqual([
        { build: 'play', count: 2 },
        { build: 'full', count: 1 },
      ]);
    });
  });

  test('пустая БД → нули и пустые списки', async () => {
    await withRefApp(ENV, async (app) => {
      const body = await (await admin(app, '/admin/installs/stats')).json();
      expect(body).toEqual({ total: 0, with_ref_code: 0, by_day: [], by_source: [], by_build: [] });
    });
  });
});
