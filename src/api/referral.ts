import { HttpError } from '../errors.ts';
import { deriveIdentity } from '../identity/device.ts';
import { LimiterStore } from '../limiter/store.ts';
import { normalizeReferralCode } from '../referral/codes.ts';
import { ReferralStore } from '../referral/store.ts';
import { parseEmail, parseInstall, readJsonObject } from '../referral/validate.ts';
import type { AppDeps, RequestContext } from '../types.ts';
import { secondsUntilWindowEnd, windowStartMs } from '../util/time.ts';
import { authenticate, resolveClientIp } from './common.ts';

/**
 * Публичные пути рефералов и статистики установок:
 *   POST /v1/referral/code  {email}                      -> 200 {code, link}
 *   POST /v1/install        {ref_code?, source, ...}     -> 204 (идемпотентно по deviceId)
 *   GET  /i/:code                                         -> 302 на Google Play с referrer
 * Первые два — Bearer deviceId, как /v1/chat/completions; лимиты — дневные счётчики
 * в той же таблице counters по HMAC-ключам (device/ip/email). Апстрим не вызывают,
 * поэтому в глобальный inflight не входят. Содержимое тел (email) в логи не пишется.
 */

const REFERRAL_CODE_PATH = '/v1/referral/code';
const INSTALL_PATH = '/v1/install';
const REDIRECT_PREFIX = '/i/';
/** Потолок значения referrer в ссылке Google Play. */
const MAX_REFERRER_LEN = 512;

const RATE_LIMITED_MESSAGE = 'Слишком много запросов — попробуйте позже.';

/** Скоупы таблицы counters (окно — сутки UTC). */
const SCOPE = {
  codeDevice: 'rc_dev',
  codeIp: 'rc_ip',
  installIp: 'in_ip',
} as const;

export async function handleReferralRequest(
  request: Request,
  url: URL,
  deps: AppDeps,
  ctx: RequestContext,
): Promise<Response | undefined> {
  const path = url.pathname;
  const isRedirect = path.startsWith(REDIRECT_PREFIX);
  if (path !== REFERRAL_CODE_PATH && path !== INSTALL_PATH && !isRedirect) {
    return undefined;
  }
  try {
    const response = isRedirect ? handleRedirect(request, url, deps) : await handlePost(request, url, deps, ctx);
    deps.state.inc(`http_${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof HttpError) deps.state.inc(`http_${error.status}`);
    throw error;
  }
}

async function handlePost(request: Request, url: URL, deps: AppDeps, ctx: RequestContext): Promise<Response> {
  if (request.method !== 'POST') {
    throw new HttpError('method_not_allowed', 'Метод не поддерживается.');
  }
  const deviceId = authenticate(request, deps);
  const ip = resolveClientIp(deps.config.trustProxy, request.headers.get('x-forwarded-for'), ctx.clientIp);
  const identity = deriveIdentity(deps.config.hmacSecret, deviceId, ip);
  const limits = deps.config.limits;
  const nowMs = Date.now();
  const counters = new LimiterStore(deps.db);
  const store = new ReferralStore(deps.db);

  switch (url.pathname) {
    case REFERRAL_CODE_PATH: {
      // Лимит до разбора тела: мусорные запросы тоже сжигают квоту нарушителя.
      enforce(counters, SCOPE.codeDevice, identity.idkey, limits.referralDeviceDay, nowMs);
      enforce(counters, SCOPE.codeIp, identity.ipkey, limits.referralIpDay, nowMs);
      const body = await readJsonObject(request);
      const email = parseEmail(body['email']);
      const code = store.getOrCreateCode(email, nowMs);
      deps.state.inc('referral_code_ok');
      return Response.json({ code, link: `${publicBase(deps, url)}/i/${code}` });
    }
    default: {
      enforce(counters, SCOPE.installIp, identity.ipkey, limits.installIpDay, nowMs);
      const body = await readJsonObject(request);
      const payload = parseInstall(body);
      // Неизвестный/кривой код — не ошибка клиента: ставим NULL и считаем метрикой.
      let refCode: string | null = null;
      if (payload.refCodeRaw !== null) {
        const normalized = normalizeReferralCode(payload.refCodeRaw);
        if (normalized !== null && store.codeExists(normalized)) {
          refCode = normalized;
        } else {
          deps.state.inc('install_unknown_ref');
        }
      }
      const inserted = store.insertInstall(
        {
          deviceId: identity.idkey,
          refCode,
          source: payload.source,
          build: payload.build,
          appVersion: payload.appVersion,
          osVersion: payload.osVersion,
          locale: payload.locale,
          ip: ip === 'unknown' ? null : ip,
        },
        nowMs,
      );
      deps.state.inc(inserted ? 'install_ok' : 'install_dup');
      return new Response(null, { status: 204 });
    }
  }
}

/** GET /i/:code → 302 на Google Play. Неизвестный код — тот же редирект, но без referrer. */
function handleRedirect(request: Request, url: URL, deps: AppDeps): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError('method_not_allowed', 'Метод не поддерживается.');
  }
  const rawCode = url.pathname.slice(REDIRECT_PREFIX.length);
  const code = rawCode.includes('/') ? null : normalizeReferralCode(safeDecode(rawCode));
  const known = code !== null && new ReferralStore(deps.db).codeExists(code);
  const base = `https://play.google.com/store/apps/details?id=${encodeURIComponent(deps.config.referral.playPackageId)}`;
  const referrer = known ? encodeURIComponent(code) : '';
  const location = known && referrer.length <= MAX_REFERRER_LEN ? `${base}&referrer=${referrer}` : base;
  deps.state.inc(known ? 'referral_redirect' : 'referral_redirect_unknown');
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/** PUBLIC_BASE_URL (обязателен в production); в dev/test — origin самого запроса. */
function publicBase(deps: AppDeps, url: URL): string {
  return deps.config.referral.publicBaseUrl !== '' ? deps.config.referral.publicBaseUrl : url.origin;
}

/** +1 к дневному счётчику; сверх лимита — 429 rate_limited с Retry-After (до конца суток UTC + джиттер). */
function enforce(counters: LimiterStore, scope: string, key: string, limit: number, nowMs: number): void {
  const count = counters.bumpCounter(scope, key, 'day', windowStartMs(nowMs, 'day'));
  if (count > limit) {
    const jitter = 1 + Math.floor(Math.random() * 10);
    throw new HttpError('rate_limited', RATE_LIMITED_MESSAGE, {
      retryAfterSeconds: secondsUntilWindowEnd(nowMs, 'day') + jitter,
    });
  }
}
