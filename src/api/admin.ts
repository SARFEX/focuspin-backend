import { timingSafeEqual } from 'node:crypto';
import { BEARER_PREFIX } from './common.ts';
import { HttpError } from '../errors.ts';
import { normalizeReferralCode } from '../referral/codes.ts';
import { ReferralStore, type ReferralAdminRow } from '../referral/store.ts';
import type { AppDeps } from '../types.ts';
import { hmacHex } from '../util/hmac.ts';

/**
 * Админ-эндпоинты (ручной разбор рефералов и статистика установок), все под
 * `Authorization: Bearer <ADMIN_TOKEN>`:
 *   GET  /admin/referrals[?qualified=1&limit=] — по коду: email, counted_installs (засчитанные: source=play, build=play),
 *                                   total_installs, qualified (counted ≥ REFERRAL_THRESHOLD), список (device_id, ip, время)
 *   POST /admin/referrals/:code/grant — владелец пометил: Premium выдан вручную (premium_granted_at); идемпотентно,
 *                                   повтор — 409 conflict, неизвестный код — 404
 *   GET  /admin/installs/stats      — установки по дням, источникам и сборкам
 * ADMIN_TOKEN не задан — админка выключена: все /admin/* отвечают как неизвестный путь (404).
 * Токен сравнивается в постоянное время (HMAC обеих сторон + timingSafeEqual) и нигде не логируется.
 */

const REFERRALS_PATH = '/admin/referrals';
const STATS_PATH = '/admin/installs/stats';
const GRANT_RE = /^\/admin\/referrals\/([^/]+)\/grant$/;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export async function handleAdminRequest(request: Request, url: URL, deps: AppDeps): Promise<Response | undefined> {
  const path = url.pathname;
  if (!path.startsWith('/admin/') || deps.config.referral.adminToken === '') return undefined;
  const grantMatch = GRANT_RE.exec(path);
  const route = path === REFERRALS_PATH || path === STATS_PATH ? path : grantMatch ? 'grant' : null;
  if (route === null) return undefined;

  try {
    requireAdmin(request, deps);
    if (request.method !== (route === 'grant' ? 'POST' : 'GET')) {
      throw new HttpError('method_not_allowed', 'Метод не поддерживается.');
    }
    const store = new ReferralStore(deps.db);
    let response: Response;
    if (route === REFERRALS_PATH) {
      response = referrals(store, url, deps.config.referral.threshold);
    } else if (route === 'grant') {
      response = grant(store, safeDecode(grantMatch?.[1] ?? ''), deps.config.referral.threshold);
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

/** ?qualified=1 — только коды, достигшие порога REFERRAL_THRESHOLD; другое значение — 400. */
function parseQualified(url: URL): boolean {
  const raw = url.searchParams.get('qualified');
  if (raw === null) return false;
  if (raw !== '1') throw new HttpError('invalid_request', 'qualified: только 1.');
  return true;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function referralJson(r: ReferralAdminRow, threshold: number): Record<string, unknown> {
  return {
    code: r.code,
    email: r.email,
    created_at: iso(r.createdAt),
    counted_installs: r.countedInstalls,
    total_installs: r.totalInstalls,
    qualified: r.countedInstalls >= threshold,
    premium_granted_at: iso(r.premiumGrantedAt),
    installs: r.installs.map((i) => ({
      device_id: i.deviceId,
      ip: i.ip,
      created_at: iso(i.createdAt),
      source: i.source,
      build: i.build,
      counted: i.counted,
    })),
  };
}

function referrals(store: ReferralStore, url: URL, threshold: number): Response {
  const limit = parseLimit(url);
  const qualifiedOnly = parseQualified(url);
  const rows = store.adminReferrals({ limit, minCounted: qualifiedOnly ? threshold : undefined });
  return Response.json({ threshold, referrals: rows.map((r) => referralJson(r, threshold)) });
}

/**
 * Владелец отмечает, что вручную выдал Premium за этот код. Квалификацию (порог) не навязываем —
 * решение за владельцем, `qualified` в ответе даёт контекст. Повтор → 409 и прежняя дата не меняется.
 */
function grant(store: ReferralStore, rawCode: string, threshold: number): Response {
  const code = normalizeReferralCode(rawCode);
  if (code === null) throw new HttpError('not_found', 'Реферальный код не найден.');
  const result = store.grantPremium(code, Date.now());
  if (result === 'not_found') throw new HttpError('not_found', 'Реферальный код не найден.');
  if (result === 'already') throw new HttpError('conflict', 'Premium по этому коду уже отмечен выданным.');
  const [row] = store.adminReferrals({ limit: 1, code });
  return Response.json({ referral: row === undefined ? null : referralJson(row, threshold) });
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
