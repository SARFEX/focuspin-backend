import { timingSafeEqual } from 'node:crypto';
import { BEARER_PREFIX } from './common.ts';
import { HttpError } from '../errors.ts';
import { ReferralStore, type ClaimStatus, type PostClaimRow } from '../referral/store.ts';
import type { AppDeps } from '../types.ts';
import { hmacHex } from '../util/hmac.ts';

/**
 * Админ-эндпоинты (ручной разбор рефералов и заявок «Premium за пост»), все под
 * `Authorization: Bearer <ADMIN_TOKEN>`:
 *   GET  /admin/referrals           — по коду: email, число установок, список (device_id, ip, время)
 *   GET  /admin/installs/stats      — установки по дням, источникам и сборкам
 *   GET  /admin/post-claims         — заявки (?status=new|approved|rejected|revoked&limit=)
 *   POST /admin/post-claims/:id     — {action: approve|reject, premium_months?} (решение один раз, из new)
 * ADMIN_TOKEN не задан — админка выключена: все /admin/* отвечают как неизвестный путь (404).
 * Токен сравнивается в постоянное время (HMAC обеих сторон + timingSafeEqual) и нигде не логируется.
 */

const REFERRALS_PATH = '/admin/referrals';
const STATS_PATH = '/admin/installs/stats';
const CLAIMS_PATH = '/admin/post-claims';
const CLAIM_ID_RE = /^\/admin\/post-claims\/([0-9]{1,15})$/;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
/** Срок Premium за пост по решению владельца — 6 месяцев; admin может указать другой. */
const DEFAULT_PREMIUM_MONTHS = 6;
const MAX_PREMIUM_MONTHS = 36;
const CLAIM_STATUSES: readonly ClaimStatus[] = ['new', 'approved', 'rejected', 'revoked'];
const MAX_ADMIN_BODY_BYTES = 1024;

export async function handleAdminRequest(request: Request, url: URL, deps: AppDeps): Promise<Response | undefined> {
  const path = url.pathname;
  if (!path.startsWith('/admin/') || deps.config.referral.adminToken === '') return undefined;
  const claimMatch = CLAIM_ID_RE.exec(path);
  const route =
    path === REFERRALS_PATH || path === STATS_PATH || path === CLAIMS_PATH ? path : claimMatch ? CLAIMS_PATH + '/:id' : null;
  if (route === null) return undefined;

  try {
    requireAdmin(request, deps);
    const wantsPost = route === CLAIMS_PATH + '/:id';
    if (request.method !== (wantsPost ? 'POST' : 'GET')) {
      throw new HttpError('method_not_allowed', 'Метод не поддерживается.');
    }
    const store = new ReferralStore(deps.db);
    let response: Response;
    if (route === REFERRALS_PATH) {
      response = referrals(store, url);
    } else if (route === STATS_PATH) {
      response = stats(store);
    } else if (route === CLAIMS_PATH) {
      response = claims(store, url);
    } else {
      response = await decideClaim(request, store, Number(claimMatch?.[1]));
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

function claimJson(c: PostClaimRow): Record<string, unknown> {
  return {
    id: c.id,
    email: c.email,
    url: c.url,
    status: c.status,
    created_at: iso(c.createdAt),
    checked_at: iso(c.checkedAt),
    premium_until: iso(c.premiumUntil),
  };
}

function claims(store: ReferralStore, url: URL): Response {
  const statusRaw = url.searchParams.get('status');
  if (statusRaw !== null && !(CLAIM_STATUSES as readonly string[]).includes(statusRaw)) {
    throw new HttpError('invalid_request', `status: ${CLAIM_STATUSES.join('|')}.`);
  }
  const rows = store.listPostClaims(statusRaw as ClaimStatus | null, parseLimit(url));
  return Response.json({ post_claims: rows.map(claimJson) });
}

async function decideClaim(request: Request, store: ReferralStore, id: number): Promise<Response> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw new HttpError('invalid_request', 'Не удалось прочитать тело запроса.');
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_ADMIN_BODY_BYTES) {
    throw new HttpError('payload_too_large', 'Тело запроса слишком большое.');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError('invalid_request', 'Тело запроса должно быть JSON-объектом.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError('invalid_request', 'Тело запроса должно быть JSON-объектом.');
  }
  const { action, premium_months: monthsRaw } = body as Record<string, unknown>;
  if (action !== 'approve' && action !== 'reject') {
    throw new HttpError('invalid_request', 'action: approve или reject.');
  }
  if (action === 'reject' && monthsRaw !== undefined) {
    throw new HttpError('invalid_request', 'premium_months задаётся только при approve.');
  }
  let months = DEFAULT_PREMIUM_MONTHS;
  if (monthsRaw !== undefined) {
    if (typeof monthsRaw !== 'number' || !Number.isInteger(monthsRaw) || monthsRaw < 1 || monthsRaw > MAX_PREMIUM_MONTHS) {
      throw new HttpError('invalid_request', `premium_months: целое от 1 до ${MAX_PREMIUM_MONTHS}.`);
    }
    months = monthsRaw;
  }

  const existing = store.getPostClaim(id);
  if (existing === null) throw new HttpError('not_found', 'Заявка не найдена.');
  const nowMs = Date.now();
  const applied = store.decidePostClaim(
    id,
    action === 'approve' ? 'approved' : 'rejected',
    nowMs,
    action === 'approve' ? addMonthsUtc(nowMs, months) : null,
  );
  if (!applied) throw new HttpError('conflict', `Заявка уже обработана (статус ${existing.status}).`);
  const updated = store.getPostClaim(id);
  return Response.json({ post_claim: updated === null ? null : claimJson(updated) });
}

/** +N календарных месяцев (UTC); 31 янв + 1 мес. = конец февраля, а не март. */
export function addMonthsUtc(fromMs: number, months: number): number {
  const date = new Date(fromMs);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}
