import { timingSafeEqual } from 'node:crypto';
import { BEARER_PREFIX } from './common.ts';
import { HttpError } from '../errors.ts';
import { ReferralStore } from '../referral/store.ts';
import type { AppDeps } from '../types.ts';
import { hmacHex } from '../util/hmac.ts';

/**
 * Админ-эндпоинты (ручной разбор рефералов и статистика установок), все под
 * `Authorization: Bearer <ADMIN_TOKEN>`:
 *   GET  /admin/referrals           — по коду: email, число установок, список (device_id, ip, время)
 *   GET  /admin/installs/stats      — установки по дням, источникам и сборкам
 * ADMIN_TOKEN не задан — админка выключена: все /admin/* отвечают как неизвестный путь (404).
 * Токен сравнивается в постоянное время (HMAC обеих сторон + timingSafeEqual) и нигде не логируется.
 */

const REFERRALS_PATH = '/admin/referrals';
const STATS_PATH = '/admin/installs/stats';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export async function handleAdminRequest(request: Request, url: URL, deps: AppDeps): Promise<Response | undefined> {
  const path = url.pathname;
  if (!path.startsWith('/admin/') || deps.config.referral.adminToken === '') return undefined;
  const route = path === REFERRALS_PATH || path === STATS_PATH ? path : null;
  if (route === null) return undefined;

  try {
    requireAdmin(request, deps);
    if (request.method !== 'GET') {
      throw new HttpError('method_not_allowed', 'Метод не поддерживается.');
    }
    const store = new ReferralStore(deps.db);
    let response: Response;
    if (route === REFERRALS_PATH) {
      response = referrals(store, url);
    } else {
      response = stats(store);
    }
    response.headers.set('cache-control', 'no-store');
    deps.state.inc(`http_${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof HttpError) deps.state.inc(`http_${error.status}`);
    throw error;
  }
}

/** Bearer-токен, сравнение в постоянное время: хеши фиксированной длины, затем timingSafeEqual. */
function requireAdmin(request: Request, deps: AppDeps): void {
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
  const secret = deps.config.hmacSecret;
  const a = Buffer.from(hmacHex(secret, provided), 'hex');
  const b = Buffer.from(hmacHex(secret, deps.config.referral.adminToken), 'hex');
  if (provided === '' || !timingSafeEqual(a, b)) {
    deps.state.inc('admin_auth_fail');
    throw new HttpError('unauthorized', 'Требуется админ-токен.');
  }
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new HttpError('invalid_request', `limit: целое от 1 до ${MAX_LIMIT}.`);
  }
  return value;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function referrals(store: ReferralStore, url: URL): Response {
  const rows = store.adminReferrals(parseLimit(url));
  return Response.json({
    referrals: rows.map((r) => ({
      code: r.code,
      email: r.email,
      created_at: iso(r.createdAt),
      installs_count: r.installsCount,
      installs: r.installs.map((i) => ({ device_id: i.deviceId, ip: i.ip, created_at: iso(i.createdAt) })),
    })),
  });
}

function stats(store: ReferralStore): Response {
  const s = store.installStats();
  return Response.json({
    total: s.total,
    with_ref_code: s.withRefCode,
    by_day: s.byDay,
    by_source: s.bySource,
    by_build: s.byBuild,
  });
}
