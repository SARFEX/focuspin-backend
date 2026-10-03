import { hmacHex } from '../util/hmac.ts';

/** Хешированные идентификаторы запроса — единственная форма, в которой id хранятся в БД. */
export interface IdentityKeys {
  /** hmac(secret, deviceId) — ключ квот устройства. */
  idkey: string;
  /** hmac(secret, ip) — ключ квот IP. */
  ipkey: string;
  /** hmac(secret, subnet) — /24 для IPv4, /64 для IPv6. */
  subnetkey: string;
}

/** Формат device id приложения focuspin: 32 hex-символа, опционально "_" + счётчик ротации. */
const DEVICE_ID_RE = /^[0-9a-f]{32}(_[0-9]+)?$/;
const MAX_DEVICE_ID_LEN = 128;

/** Нормализация Bearer-токена (trim + lowercase) или null, если формат не focuspin-овский. */
export function validateFocuspinDeviceId(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > MAX_DEVICE_ID_LEN) return null;
  return DEVICE_ID_RE.test(value) ? value : null;
}

/** Подсеть для группового лимита: /24 у IPv4, первые 4 hextet у IPv6, всё прочее — 'unknown'. */
export function subnetOf(ip: string): string {
  const value = ip.trim();
  if (value.includes(':')) {
    const hextets = value.split(':').filter((part) => part !== '');
    if (hextets.length === 0) return 'unknown';
    return `v6/64:${hextets.slice(0, 4).join(':')}`;
  }
  const octets = value.split('.');
  if (octets.length !== 4) return 'unknown';
  for (const octet of octets) {
    if (!/^[0-9]{1,3}$/.test(octet) || Number(octet) > 255) return 'unknown';
  }
  return `v4/24:${octets.slice(0, 3).join('.')}`;
}

/** Все ключи квот — HMAC-SHA256: сырые device id и IP в БД не попадают никогда. */
export function deriveIdentity(hmacSecret: string, deviceId: string, ip: string): IdentityKeys {
  return {
    idkey: hmacHex(hmacSecret, deviceId),
    ipkey: hmacHex(hmacSecret, ip),
    subnetkey: hmacHex(hmacSecret, subnetOf(ip)),
  };
}
