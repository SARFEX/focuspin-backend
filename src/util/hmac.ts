import { createHmac } from 'node:crypto';

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/** Короткий префикс хеша для логов — не обратим, но различает устройства/IP. */
export function shortKey(hmac: string, length = 8): string {
  return hmac.slice(0, length);
}
