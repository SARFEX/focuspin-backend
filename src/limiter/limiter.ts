import type { Database } from 'bun:sqlite';
import type { Config } from '../config.ts';
import type { RuntimeState } from '../state.ts';

export type RateLimitReason =
  | 'global_day'
  | 'ip_minute'
  | 'ip_hour'
  | 'ip_day'
  | 'subnet_day'
  | 'device_minute'
  | 'device_hour'
  | 'device_day'
  | 'ip_devices'
  | 'contract_fails';

export interface Identity {
  /** hmac(secret, deviceId) — ключ квот устройства. */
  idkey: string;
  /** hmac(secret, ip) — ключ квот IP. */
  ipkey: string;
  /** hmac(secret, subnet) — /24 для IPv4, /64 для IPv6. */
  subnetkey: string;
  /** Устройство младше limits.freshDeviceHours — пониженный дневной лимит (цена ротации id). */
  fresh: boolean;
  firstSeenMs: number;
}

export interface RateVerdict {
  allowed: boolean;
  reason?: RateLimitReason;
  /** Секунды до конца окна + джиттер — в Retry-After при отказе. */
  retryAfterSeconds?: number;
  deviceDayRemaining: number;
  deviceDayLimit: number;
  deviceDayResetSeconds: number;
}

/**
 * Ярусный рейт-лимитер поверх bun:sqlite. Все ключи — уже хешированные Identity.
 * Порядок проверки в beginRequest (первое нарушение — отказ, счётчики при этом всё равно
 * инкрементируются: нарушитель сжигает собственные окна):
 *   global_day (запросы и токены) -> ip_minute -> ip_hour -> ip_day -> subnet_day
 *   -> device_minute -> device_hour -> device_day (fresh-устройства — пониженный лимит)
 *   -> ip_devices (ротация id с одного IP) -> contract_fails (антиабьюз битых ответов).
 */
export class Limiter {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly state: RuntimeState,
  ) {
    void db;
    void config;
    void state;
    throw new Error('Limiter: not implemented');
  }

  beginRequest(id: Identity, nowMs: number = Date.now()): RateVerdict {
    void id;
    void nowMs;
    throw new Error('Limiter: not implemented');
  }

  /** Успешный ответ: токены upstream в usage_daily + last_seen устройства. */
  recordSuccess(id: Identity, promptTokens: number, completionTokens: number, nowMs: number = Date.now()): void {
    void id;
    void promptTokens;
    void completionTokens;
    void nowMs;
    throw new Error('Limiter: not implemented');
  }

  /** Невалидный ответ модели по контракту — антиабьюз-счётчик устройства за час. */
  recordContractFail(id: Identity, nowMs: number = Date.now()): void {
    void id;
    void nowMs;
    throw new Error('Limiter: not implemented');
  }

  /** Чистка устаревших строк: counters >2 суток, ip_devices >2 суток, devices без активности >90 суток, usage_daily >30 суток. */
  purge(nowMs: number = Date.now()): void {
    void nowMs;
    throw new Error('Limiter: not implemented');
  }
}
