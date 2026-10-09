import { HttpError } from '../errors.ts';

/** Ручная валидация входных данных публичных реферальных путей (zero-dep: без zod). */

export const MAX_EMAIL_LEN = 254;
export const MAX_URL_LEN = 512;
/** Тела этих путей — несколько коротких полей; больше 4 КБ не бывает. */
export const MAX_REFERRAL_BODY_BYTES = 4096;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const SOURCE_RE = /^[a-z0-9_]{1,32}$/;
const APP_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const OS_VERSION_RE = /^[\p{L}\p{N} ._+\-()/]{1,64}$/u;
const LOCALE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/;
export const BUILDS = ['play', 'full'] as const;
export type Build = (typeof BUILDS)[number];

function bad(message: string): never {
  throw new HttpError('invalid_request', message);
}

/** Тело запроса: ограничение размера, JSON-объект. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return bad('Не удалось прочитать тело запроса.');
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_REFERRAL_BODY_BYTES) {
    throw new HttpError('payload_too_large', 'Тело запроса слишком большое.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return bad('Тело запроса должно быть JSON-объектом.');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return bad('Тело запроса должно быть JSON-объектом.');
  }
  return decoded as Record<string, unknown>;
}

/** Email: формат user@host.tld, ≤254 символов, приводится к нижнему регистру. Без подтверждения владения. */
export function parseEmail(value: unknown): string {
  if (typeof value !== 'string') return bad('Поле email должно быть строкой.');
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (email.length === 0 || email.length > MAX_EMAIL_LEN || at < 1 || at > 64 || !EMAIL_RE.test(email)) {
    return bad('Некорректный email.');
  }
  return email;
}

/** Ссылка на пост: только https, без логина/пароля, ≤512 символов, нормализуется без фрагмента. */
export function parsePostUrl(value: unknown): string {
  if (typeof value !== 'string') return bad('Поле url должно быть строкой.');
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LEN) return bad('Некорректный url.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return bad('Некорректный url.');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || !parsed.hostname.includes('.')) {
    return bad('Нужна https-ссылка на пост.');
  }
  parsed.hash = '';
  const normalized = parsed.toString();
  if (normalized.length > MAX_URL_LEN) return bad('Некорректный url.');
  return normalized;
}

export interface InstallPayload {
  /** Сырое значение ref_code из тела (null — не прислан). Валидность проверяет вызывающий: неизвестный код не ошибка. */
  refCodeRaw: string | null;
  source: string;
  build: Build;
  appVersion: string;
  osVersion: string;
  locale: string;
}

function strictString(body: Record<string, unknown>, name: string, re: RegExp): string {
  const value = body[name];
  if (typeof value !== 'string') return bad(`Поле ${name} обязательно и должно быть строкой.`);
  const trimmed = value.trim();
  if (!re.test(trimmed)) return bad(`Поле ${name} имеет недопустимый формат.`);
  return trimmed;
}

/** POST /v1/install: все поля, кроме ref_code, обязательны и ограничены по длине/формату. */
export function parseInstall(body: Record<string, unknown>): InstallPayload {
  const refRaw = body['ref_code'];
  if (refRaw !== undefined && refRaw !== null && typeof refRaw !== 'string') {
    return bad('Поле ref_code должно быть строкой.');
  }
  const build = strictString(body, 'build', /^[a-z]{1,8}$/);
  if (!(BUILDS as readonly string[]).includes(build)) return bad('Поле build: play или full.');
  return {
    // Слишком длинное значение — заведомо не наш код, но клиента не ругаем: отбрасываем.
    refCodeRaw: typeof refRaw === 'string' && refRaw.length <= 256 ? refRaw : null,
    source: strictString(body, 'source', SOURCE_RE),
    build: build as Build,
    appVersion: strictString(body, 'app_version', APP_VERSION_RE),
    osVersion: strictString(body, 'os_version', OS_VERSION_RE),
    locale: strictString(body, 'locale', LOCALE_RE),
  };
}
