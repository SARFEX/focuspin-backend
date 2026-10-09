import { describe, expect, test } from 'bun:test';
import { hmacHex } from '../util/hmac.ts';
import { DEVICE_A, DEVICE_B, DEVICE_C, SECRET, post, withRefApp, type RefApp } from './test-helpers.ts';

/**
 * Интеграционные тесты публичных реферальных путей на живом стеке (config + sqlite +
 * реальный сервер на свободном порту). Upstream не нужен — эти пути его не вызывают.
 */

const INSTALL_BODY = {
  source: 'play_organic',
  build: 'play',
  app_version: '1.2.3',
  os_version: 'Android 14',
  locale: 'ru-RU',
};

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('POST /v1/referral/code', () => {
  test('выдаёт код и ссылку; тот же email (в любом регистре) → тот же код', async () => {
    await withRefApp({}, async (app) => {
      const res = await post(app, '/v1/referral/code', { email: 'User@Example.com' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code: string; link: string };
      expect(body.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/);
      expect(body.link).toBe(`${app.base}/i/${body.code}`);

      const again = (await (await post(app, '/v1/referral/code', { email: ' user@example.COM ' }, DEVICE_B)).json()) as {
        code: string;
      };
      expect(again.code).toBe(body.code);
      const other = (await (await post(app, '/v1/referral/code', { email: 'other@example.com' })).json()) as {
        code: string;
      };
      expect(other.code).not.toBe(body.code);
      const count = app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM referral_codes').get();
      expect(count?.n).toBe(2);
    });
  });

  test('PUBLIC_BASE_URL задаёт домен ссылки', async () => {
    await withRefApp({ PUBLIC_BASE_URL: 'https://api.example.com/' }, async (app) => {
      const body = (await (await post(app, '/v1/referral/code', { email: 'a@b.co' })).json()) as {
        code: string;
        link: string;
      };
      expect(body.link).toBe(`https://api.example.com/i/${body.code}`);
    });
  });

  test('без/с битым Bearer → 401; GET → 405', async () => {
    await withRefApp({}, async (app) => {
      expect((await post(app, '/v1/referral/code', { email: 'a@b.co' }, null)).status).toBe(401);
      expect((await post(app, '/v1/referral/code', { email: 'a@b.co' }, 'not-a-device')).status).toBe(401);
      const get = await fetch(`${app.base}/v1/referral/code`, { headers: { authorization: `Bearer ${DEVICE_A}` } });
      expect(get.status).toBe(405);
    });
  });

  test('плохой ввод → 400 invalid_request; слишком большое тело → 413', async () => {
    await withRefApp({}, async (app) => {
      for (const body of [{}, { email: 5 }, { email: 'nope' }, { email: 'a@b' }, '{not json', '[]', 'null']) {
        const res = await post(app, '/v1/referral/code', body);
        expect(res.status).toBe(400);
        expect(await errorCode(res)).toBe('invalid_request');
      }
      const big = await post(app, '/v1/referral/code', { email: 'a@b.co', pad: 'x'.repeat(5000) });
      expect(big.status).toBe(413);
      const count = app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM referral_codes').get();
      expect(count?.n).toBe(0);
    });
  });

  test('лимит на устройство: сверх — 429 rate_limited с Retry-After; другое устройство не задето', async () => {
    await withRefApp({ LIMIT_REFERRAL_DEVICE_DAY: '2' }, async (app) => {
      expect((await post(app, '/v1/referral/code', { email: 'a@b.co' })).status).toBe(200);
      expect((await post(app, '/v1/referral/code', { email: 'a@b.co' })).status).toBe(200);
      const limited = await post(app, '/v1/referral/code', { email: 'a@b.co' });
      expect(limited.status).toBe(429);
      expect(await errorCode(limited)).toBe('rate_limited');
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await post(app, '/v1/referral/code', { email: 'a@b.co' }, DEVICE_B)).status).toBe(200);
    });
  });

  test('лимит на IP: ротация устройств с одного IP упирается в LIMIT_REFERRAL_IP_DAY', async () => {
    await withRefApp({ LIMIT_REFERRAL_IP_DAY: '2' }, async (app) => {
      expect((await post(app, '/v1/referral/code', { email: 'a@b.co' }, DEVICE_A)).status).toBe(200);
      expect((await post(app, '/v1/referral/code', { email: 'b@b.co' }, DEVICE_B)).status).toBe(200);
      expect((await post(app, '/v1/referral/code', { email: 'c@b.co' }, DEVICE_C)).status).toBe(429);
    });
  });
});

describe('POST /v1/install', () => {
  test('204; в БД device_id — HMAC-хеш (не сырой id), IP клиента, поля как присланы', async () => {
    await withRefApp({}, async (app) => {
      const res = await post(app, '/v1/install', INSTALL_BODY);
      expect(res.status).toBe(204);
      const row = app.db
        .query<Record<string, unknown>, []>('SELECT * FROM install_events')
        .get();
      expect(row?.['device_id']).toBe(hmacHex(SECRET, DEVICE_A));
      expect(row?.['device_id']).not.toBe(DEVICE_A);
      expect(row?.['ip']).toBe('::ffff:127.0.0.1'); // сокетный адрес как его видит лимитер
      expect(row?.['ref_code']).toBeNull();
      expect(row?.['source']).toBe('play_organic');
      expect(row?.['build']).toBe('play');
      expect(row?.['app_version']).toBe('1.2.3');
      expect(row?.['os_version']).toBe('Android 14');
      expect(row?.['locale']).toBe('ru-RU');
    });
  });

  test('идемпотентно по deviceId: повтор → 204, первая запись остаётся', async () => {
    await withRefApp({}, async (app) => {
      expect((await post(app, '/v1/install', { ...INSTALL_BODY, source: 'first' })).status).toBe(204);
      expect((await post(app, '/v1/install', { ...INSTALL_BODY, source: 'second', app_version: '9.9.9' })).status).toBe(204);
      const rows = app.db.query<{ source: string; app_version: string }, []>('SELECT source, app_version FROM install_events').all();
      expect(rows).toEqual([{ source: 'first', app_version: '1.2.3' }]);
      expect(app.state.snapshot()['install_dup']).toBe(1);
      // другое устройство — отдельная запись
      expect((await post(app, '/v1/install', INSTALL_BODY, DEVICE_B)).status).toBe(204);
      expect(app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM install_events').get()?.n).toBe(2);
    });
  });

  test('известный ref_code (в любом регистре) сохраняется канонически', async () => {
    await withRefApp({}, async (app) => {
      const { code } = (await (await post(app, '/v1/referral/code', { email: 'a@b.co' })).json()) as { code: string };
      expect((await post(app, '/v1/install', { ...INSTALL_BODY, ref_code: code.toLowerCase() })).status).toBe(204);
      const row = app.db.query<{ ref_code: string | null }, []>('SELECT ref_code FROM install_events').get();
      expect(row?.ref_code).toBe(code);
    });
  });

  test('неизвестный/кривой/слишком длинный ref_code — 204, хранится NULL, клиент не видит ошибки', async () => {
    await withRefApp({}, async (app) => {
      const refs = ['0'.repeat(16), 'garbage', '', 'x'.repeat(1000), "'; DROP TABLE install_events;--"];
      let i = 0;
      for (const ref of refs) {
        const device = `${String(i).padStart(2, '0')}`.repeat(16);
        i += 1;
        expect((await post(app, '/v1/install', { ...INSTALL_BODY, ref_code: ref }, device)).status).toBe(204);
      }
      const rows = app.db.query<{ ref_code: string | null }, []>('SELECT ref_code FROM install_events').all();
      expect(rows).toHaveLength(refs.length);
      expect(rows.every((r) => r.ref_code === null)).toBe(true);
      // слишком длинное значение (>256) отбрасывается ещё при разборе тела и в метрику не попадает
      expect(app.state.snapshot()['install_unknown_ref']).toBe(refs.length - 1);
    });
  });

  test('плохие поля → 400; без Bearer → 401; GET → 405; запись не создаётся', async () => {
    await withRefApp({}, async (app) => {
      const bads: Array<Record<string, unknown>> = [
        { ...INSTALL_BODY, build: 'beta' },
        { ...INSTALL_BODY, source: '' },
        { ...INSTALL_BODY, source: 'x'.repeat(100) },
        { ...INSTALL_BODY, app_version: 'v'.repeat(100) },
        { ...INSTALL_BODY, os_version: 'o'.repeat(100) },
        { ...INSTALL_BODY, locale: 'x'.repeat(100) },
        { ...INSTALL_BODY, ref_code: 12345 },
        { source: 'play_organic' },
      ];
      for (const body of bads) {
        const res = await post(app, '/v1/install', body);
        expect(res.status).toBe(400);
      }
      expect((await post(app, '/v1/install', '{oops')).status).toBe(400);
      expect((await post(app, '/v1/install', INSTALL_BODY, null)).status).toBe(401);
      expect((await fetch(`${app.base}/v1/install`)).status).toBe(405);
      expect(app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM install_events').get()?.n).toBe(0);
    });
  });

  test('лимит на IP: сверх LIMIT_INSTALL_IP_DAY — 429', async () => {
    await withRefApp({ LIMIT_INSTALL_IP_DAY: '2' }, async (app) => {
      expect((await post(app, '/v1/install', INSTALL_BODY, DEVICE_A)).status).toBe(204);
      expect((await post(app, '/v1/install', INSTALL_BODY, DEVICE_B)).status).toBe(204);
      const limited = await post(app, '/v1/install', INSTALL_BODY, DEVICE_C);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).not.toBeNull();
    });
  });

  test('IP как у лимитера: TRUST_PROXY=true → последний элемент X-Forwarded-For; без — сокетный', async () => {
    await withRefApp({ TRUST_PROXY: 'true' }, async (app) => {
      await post(app, '/v1/install', INSTALL_BODY, DEVICE_A, { 'x-forwarded-for': '6.6.6.6, 198.51.100.9' });
      expect(app.db.query<{ ip: string }, []>('SELECT ip FROM install_events').get()?.ip).toBe('198.51.100.9');
    });
    await withRefApp({}, async (app) => {
      await post(app, '/v1/install', INSTALL_BODY, DEVICE_A, { 'x-forwarded-for': '6.6.6.6' });
      expect(app.db.query<{ ip: string }, []>('SELECT ip FROM install_events').get()?.ip).toBe('::ffff:127.0.0.1');
    });
  });
});

describe('POST /v1/post-claim', () => {
  const CLAIM = { email: 'User@Example.com', url: 'https://www.reddit.com/r/test/comments/abc/post/' };

  test('202; заявка в статусе new, email нормализован', async () => {
    await withRefApp({}, async (app) => {
      const res = await post(app, '/v1/post-claim', CLAIM);
      expect(res.status).toBe(202);
      const row = app.db
        .query<{ email: string; url: string; status: string; checked_at: number | null; premium_until: number | null }, []>(
          'SELECT email, url, status, checked_at, premium_until FROM post_claims',
        )
        .get();
      expect(row).toEqual({
        email: 'user@example.com',
        url: CLAIM.url,
        status: 'new',
        checked_at: null,
        premium_until: null,
      });
    });
  });

  test('повтор той же ссылки → 202, но заявка одна', async () => {
    await withRefApp({}, async (app) => {
      expect((await post(app, '/v1/post-claim', CLAIM)).status).toBe(202);
      expect((await post(app, '/v1/post-claim', CLAIM, DEVICE_B)).status).toBe(202);
      expect((await post(app, '/v1/post-claim', { ...CLAIM, email: 'x@y.co' }, DEVICE_C)).status).toBe(202);
      expect(app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM post_claims').get()?.n).toBe(1);
    });
  });

  test('плохой url/email → 400 (http, javascript:, длинный, без схемы)', async () => {
    await withRefApp({}, async (app) => {
      const urls = [
        'http://reddit.com/x',
        'javascript:alert(1)',
        'reddit.com/r/x',
        `https://reddit.com/${'a'.repeat(600)}`,
        'https://u:p@reddit.com/x',
        '',
        42,
      ];
      for (const url of urls) {
        expect((await post(app, '/v1/post-claim', { email: 'a@b.co', url })).status).toBe(400);
      }
      expect((await post(app, '/v1/post-claim', { email: 'bad', url: CLAIM.url })).status).toBe(400);
      expect((await post(app, '/v1/post-claim', { url: CLAIM.url })).status).toBe(400);
      expect((await post(app, '/v1/post-claim', CLAIM, null)).status).toBe(401);
      expect(app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM post_claims').get()?.n).toBe(0);
    });
  });

  test('лимит на email: сверх LIMIT_POST_CLAIM_EMAIL_DAY — 429 (с другого устройства тоже)', async () => {
    await withRefApp({ LIMIT_POST_CLAIM_EMAIL_DAY: '2' }, async (app) => {
      const claim = (n: number) => ({ email: 'a@b.co', url: `https://reddit.com/r/x/${n}` });
      expect((await post(app, '/v1/post-claim', claim(1), DEVICE_A)).status).toBe(202);
      expect((await post(app, '/v1/post-claim', claim(2), DEVICE_B)).status).toBe(202);
      const limited = await post(app, '/v1/post-claim', claim(3), DEVICE_C);
      expect(limited.status).toBe(429);
      expect(await errorCode(limited)).toBe('rate_limited');
      expect(app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM post_claims').get()?.n).toBe(2);
    });
  });

  test('лимит на устройство и на IP', async () => {
    await withRefApp({ LIMIT_REFERRAL_DEVICE_DAY: '1' }, async (app) => {
      expect((await post(app, '/v1/post-claim', { email: 'a@b.co', url: 'https://r.com/a/1' })).status).toBe(202);
      expect((await post(app, '/v1/post-claim', { email: 'b@b.co', url: 'https://r.com/a/2' })).status).toBe(429);
    });
    await withRefApp({ LIMIT_REFERRAL_IP_DAY: '1' }, async (app) => {
      expect((await post(app, '/v1/post-claim', { email: 'a@b.co', url: 'https://r.com/a/1' }, DEVICE_A)).status).toBe(202);
      expect((await post(app, '/v1/post-claim', { email: 'b@b.co', url: 'https://r.com/a/2' }, DEVICE_B)).status).toBe(429);
    });
  });

  test('пути рефералов и post-claim считают лимиты независимо', async () => {
    await withRefApp({ LIMIT_REFERRAL_DEVICE_DAY: '1' }, async (app) => {
      expect((await post(app, '/v1/referral/code', { email: 'a@b.co' })).status).toBe(200);
      expect((await post(app, '/v1/post-claim', { email: 'a@b.co', url: 'https://r.com/a/1' })).status).toBe(202);
    });
  });
});

describe('GET /i/:code', () => {
  const PLAY = 'https://play.google.com/store/apps/details?id=dev.sarfex.focuspin';

  async function get(app: RefApp, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${app.base}${path}`, { redirect: 'manual', ...init });
  }

  test('известный код → 302 на Google Play с referrer; без авторизации; регистр не важен', async () => {
    await withRefApp({}, async (app) => {
      const { code } = (await (await post(app, '/v1/referral/code', { email: 'a@b.co' })).json()) as { code: string };
      for (const variant of [code, code.toLowerCase()]) {
        const res = await get(app, `/i/${variant}`);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(`${PLAY}&referrer=${code}`);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
      expect((await get(app, `/i/${code}`, { method: 'HEAD' })).status).toBe(302);
    });
  });

  test('неизвестный/кривой код → всё равно 302, без referrer', async () => {
    await withRefApp({}, async (app) => {
      for (const path of [`/i/${'0'.repeat(16)}`, '/i/garbage', `/i/${'x'.repeat(2000)}`, '/i/%E0%A4%A', '/i/', '/i/a/b']) {
        const res = await get(app, path);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(PLAY);
      }
    });
  });

  test('PLAY_PACKAGE_ID переопределяет пакет; referrer урлкодируется и ≤ 512', async () => {
    await withRefApp({ PLAY_PACKAGE_ID: 'com.example.app' }, async (app) => {
      const { code } = (await (await post(app, '/v1/referral/code', { email: 'a@b.co' })).json()) as { code: string };
      const location = (await get(app, `/i/${code}`)).headers.get('location') ?? '';
      expect(location).toBe(`https://play.google.com/store/apps/details?id=com.example.app&referrer=${code}`);
      const referrer = new URL(location).searchParams.get('referrer') ?? '';
      expect(referrer).toBe(code);
      expect(referrer.length).toBeLessThanOrEqual(512);
    });
  });

  test('POST → 405', async () => {
    await withRefApp({}, async (app) => {
      expect((await get(app, '/i/abc', { method: 'POST' })).status).toBe(405);
    });
  });
});
