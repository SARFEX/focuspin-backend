import { describe, expect, test } from 'bun:test';
import { addMonthsUtc } from './admin.ts';
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

async function seedClaim(app: RefApp, n = 1): Promise<number> {
  await post(app, '/v1/post-claim', { email: 'a@b.co', url: `https://reddit.com/r/x/${n}` });
  const row = app.db.query<{ id: number }, []>('SELECT MAX(id) AS id FROM post_claims').get();
  return row?.id ?? -1;
}

const ADMIN_PATHS: Array<[string, string]> = [
  ['GET', '/admin/referrals'],
  ['GET', '/admin/installs/stats'],
  ['GET', '/admin/post-claims'],
  ['POST', '/admin/post-claims/1'],
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
      expect((await admin(app, '/admin/post-claims/1')).status).toBe(405);
      expect((await admin(app, '/admin/nope')).status).toBe(404);
      expect((await admin(app, '/admin/post-claims/abc', { method: 'POST', body: {} })).status).toBe(404);
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

describe('/admin/post-claims', () => {
  test('список с фильтром по статусу; плохой статус → 400', async () => {
    await withRefApp(ENV, async (app) => {
      const first = await seedClaim(app, 1);
      await seedClaim(app, 2);
      await admin(app, `/admin/post-claims/${first}`, { method: 'POST', body: { action: 'reject' } });
      const all = (await (await admin(app, '/admin/post-claims')).json()) as { post_claims: Array<{ id: number; status: string }> };
      expect(all.post_claims.map((c) => c.status)).toEqual(['new', 'rejected']);
      const onlyNew = (await (await admin(app, '/admin/post-claims?status=new')).json()) as { post_claims: unknown[] };
      expect(onlyNew.post_claims).toHaveLength(1);
      expect((await admin(app, '/admin/post-claims?status=bogus')).status).toBe(400);
    });
  });

  test('approve: статус, checked_at и premium_until (по умолчанию +6 месяцев)', async () => {
    await withRefApp(ENV, async (app) => {
      const id = await seedClaim(app);
      const before = Date.now();
      const res = await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body: { action: 'approve' } });
      expect(res.status).toBe(200);
      const { post_claim: claim } = (await res.json()) as {
        post_claim: { status: string; checked_at: string; premium_until: string; email: string };
      };
      expect(claim.status).toBe('approved');
      expect(claim.email).toBe('a@b.co');
      expect(Date.parse(claim.checked_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(claim.premium_until)).toBe(addMonthsUtc(Date.parse(claim.checked_at), 6));
    });
  });

  test('approve с premium_months; недопустимые значения → 400', async () => {
    await withRefApp(ENV, async (app) => {
      const id = await seedClaim(app);
      for (const bad of [0, -1, 1.5, '6', 37, null]) {
        const res = await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body: { action: 'approve', premium_months: bad } });
        expect(res.status).toBe(400);
      }
      const ok = await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body: { action: 'approve', premium_months: 12 } });
      expect(ok.status).toBe(200);
      const { post_claim: claim } = (await ok.json()) as { post_claim: { checked_at: string; premium_until: string } };
      expect(Date.parse(claim.premium_until)).toBe(addMonthsUtc(Date.parse(claim.checked_at), 12));
    });
  });

  test('reject: premium_until пуст; premium_months при reject → 400', async () => {
    await withRefApp(ENV, async (app) => {
      const id = await seedClaim(app);
      expect((await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body: { action: 'reject', premium_months: 6 } })).status).toBe(400);
      const res = await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body: { action: 'reject' } });
      expect(res.status).toBe(200);
      const { post_claim: claim } = (await res.json()) as { post_claim: { status: string; premium_until: string | null } };
      expect(claim.status).toBe('rejected');
      expect(claim.premium_until).toBeNull();
    });
  });

  test('повторное решение → 409 conflict, статус не меняется; несуществующий id → 404; плохой action/тело → 400', async () => {
    await withRefApp(ENV, async (app) => {
      const id = await seedClaim(app);
      expect((await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body: { action: 'approve' } })).status).toBe(200);
      const again = await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body: { action: 'reject' } });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe('conflict');
      expect(app.db.query<{ status: string }, []>('SELECT status FROM post_claims').get()?.status).toBe('approved');

      expect((await admin(app, '/admin/post-claims/99999', { method: 'POST', body: { action: 'approve' } })).status).toBe(404);
      for (const body of [{ action: 'revoke' }, { action: 5 }, {}, '[]', '{bad', 'null']) {
        expect((await admin(app, `/admin/post-claims/${id}`, { method: 'POST', body })).status).toBe(400);
      }
    });
  });
});

describe('addMonthsUtc', () => {
  test('календарные месяцы с зажимом конца месяца', () => {
    expect(new Date(addMonthsUtc(Date.UTC(2026, 9, 10, 5, 0, 0), 6)).toISOString()).toBe('2027-04-10T05:00:00.000Z');
    expect(new Date(addMonthsUtc(Date.UTC(2026, 7, 31), 6)).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(new Date(addMonthsUtc(Date.UTC(2027, 7, 31), 6)).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(new Date(addMonthsUtc(Date.UTC(2026, 10, 30), 3)).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(new Date(addMonthsUtc(Date.UTC(2026, 11, 15), 1)).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});
