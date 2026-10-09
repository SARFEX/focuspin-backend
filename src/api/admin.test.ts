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

describe('GET /admin/referrals', () => {
  test('по коду: email, число установок, device_id + ip + время', async () => {
    await withRefApp(ENV, async (app) => {
      const { code } = (await (await post(app, '/v1/referral/code', { email: 'Ref@Example.com' })).json()) as { code: string };
      await post(app, '/v1/referral/code', { email: 'lonely@example.com' }, DEVICE_C);
      await post(app, '/v1/install', { ...INSTALL, ref_code: code, source: 'play_referral' }, DEVICE_A);
      await post(app, '/v1/install', { ...INSTALL, ref_code: code }, DEVICE_B);
      await post(app, '/v1/install', INSTALL, DEVICE_C); // без кода — в рефералы не попадает

      const res = await admin(app, '/admin/referrals');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as {
        referrals: Array<{
          code: string;
          email: string;
          installs_count: number;
          installs: Array<{ device_id: string; ip: string | null; created_at: string }>;
        }>;
      };
      expect(body.referrals).toHaveLength(2);
      const top = body.referrals[0];
      expect(top?.code).toBe(code);
      expect(top?.email).toBe('ref@example.com');
      expect(top?.installs_count).toBe(2);
      expect(top?.installs).toHaveLength(2);
      for (const install of top?.installs ?? []) {
        expect(install.device_id).toMatch(/^[0-9a-f]{64}$/);
        expect(install.ip).toBe('::ffff:127.0.0.1');
        expect(Number.isNaN(Date.parse(install.created_at))).toBe(false);
      }
      expect(body.referrals[1]?.installs_count).toBe(0);
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
