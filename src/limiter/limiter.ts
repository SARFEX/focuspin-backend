import type { Database } from 'bun:sqlite';
import type { Config } from '../config.ts';
import type { RuntimeState } from '../state.ts';
import {
  DAY_MS,
  HOUR_MS,
  secondsUntilWindowEnd,
  utcDayString,
  windowStartMs,
  type Period,
} from '../util/time.ts';
import { LimiterStore } from './store.ts';

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

export interface IdentityKeys {
  /** hmac(secret, deviceId) — ключ квот устройства. */
  idkey: string;
  /** hmac(secret, ip) — ключ квот IP. */
  ipkey: string;
  /** hmac(secret, subnet) — /24 для IPv4, /64 для IPv6. */
  subnetkey: string;
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

/** Скоупы таблицы counters. */
const CFAIL_SCOPE = 'cfail';
const IP_SCOPE = 'ip';
const SUBNET_SCOPE = 'subnet';
const DEV_SCOPE = 'dev';

/** Джиттер Retry-After: случайные 1..10 c поверх конца окна, чтобы волна ретраев не синхронизировалась. */
function jitterSeconds(): number {
  return 1 + Math.floor(Math.random() * 10);
}

/**
 * Ярусный рейт-лимитер поверх bun:sqlite. Все ключи — уже хешированные IdentityKeys
 * (fresh/firstSeen выводятся внутри beginRequest из таблицы devices).
 * Порядок проверки в beginRequest (первое нарушение — отказ, счётчики при этом всё равно
 * инкрементируются: нарушитель сжигает собственные окна):
 *   global_day (запросы и токены) -> ip_minute -> ip_hour -> ip_day -> subnet_day
 *   -> device_minute -> device_hour -> device_day (fresh-устройства — пониженный лимит)
 *   -> ip_devices (ротация id с одного IP) -> contract_fails (антиабьюз битых ответов).
 */
export class Limiter {
  private readonly store: LimiterStore;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly state: RuntimeState,
  ) {
    this.store = new LimiterStore(db);
  }

  beginRequest(keys: IdentityKeys, nowMs: number = Date.now()): RateVerdict {
    let verdict: RateVerdict | undefined;
    this.db.transaction(() => {
      verdict = this.checkOnce(keys, nowMs);
    })();
    if (verdict === undefined) throw new Error('Limiter: transaction produced no verdict');
    return verdict;
  }

  /** Успешный ответ: токены upstream в usage_daily + last_seen устройства. */
  recordSuccess(keys: IdentityKeys, promptTokens: number, completionTokens: number, nowMs: number = Date.now()): void {
    this.db.transaction(() => {
      this.store.addDailyTokens(utcDayString(nowMs), promptTokens, completionTokens);
      this.store.touchDeviceLastSeen(keys.idkey, nowMs);
    })();
  }

  /** Невалидный ответ модели по контракту — антиабьюз-счётчик устройства за час. */
  recordContractFail(keys: IdentityKeys, nowMs: number = Date.now()): void {
    this.db.transaction(() => {
      this.store.bumpCounter(CFAIL_SCOPE, keys.idkey, 'hour', windowStartMs(nowMs, 'hour'));
      this.store.bumpDailyContractFails(utcDayString(nowMs));
    })();
    this.state.inc('contract_fails');
  }

  /** Чистка устаревших строк: counters >2 суток, ip_devices >2 суток, devices без активности >90 суток, usage_daily >30 суток. */
  purge(nowMs: number = Date.now()): void {
    this.db.transaction(() => {
      this.store.purgeExpired(nowMs);
    })();
  }

  /** Одна транзакция: upsert first_seen, обход ярусов до первого нарушения, инкремент по пути. */
  private checkOnce(keys: IdentityKeys, nowMs: number): RateVerdict {
    const limits = this.config.limits;

    // a) Устройство: first_seen и «свежесть» (пониженный дневной лимит — цена ротации id).
    const firstSeenMs = this.store.upsertDeviceFirstSeen(keys.idkey, nowMs);
    const fresh = nowMs - firstSeenMs < limits.freshDeviceHours * HOUR_MS;
    const deviceDayLimit = fresh ? limits.freshDeviceDay : limits.deviceDay;

    const minuteStart = windowStartMs(nowMs, 'minute');
    const hourStart = windowStartMs(nowMs, 'hour');
    const dayStart = windowStartMs(nowMs, 'day');
    const today = utcDayString(nowMs);

    const verdict = (allowed: boolean, reason?: RateLimitReason, period?: Period): RateVerdict => {
      const deviceDayCount = this.store.readCounter(DEV_SCOPE, keys.idkey, 'day', dayStart);
      if (allowed) {
        this.state.inc('limit_allow');
      } else {
        this.state.inc(`rate_limited_${reason ?? 'unknown'}`);
      }
      return {
        allowed,
        reason,
        retryAfterSeconds:
          allowed || period === undefined ? undefined : secondsUntilWindowEnd(nowMs, period) + jitterSeconds(),
        deviceDayRemaining: Math.max(0, deviceDayLimit - deviceDayCount),
        deviceDayLimit,
        deviceDayResetSeconds: secondsUntilWindowEnd(nowMs, 'day'),
      };
    };

    // b) Глобальные дневные предохранители (весь сервер).
    const dailyRequests = this.store.bumpDailyRequests(today);
    if (dailyRequests > this.config.globalDailyRequestCap) return verdict(false, 'global_day', 'day');
    const usage = this.store.readDailyUsage(today);
    if (usage.promptTokens + usage.completionTokens >= this.config.globalDailyTokenCap) {
      return verdict(false, 'global_day', 'day');
    }

    // c) Блок за contract_fails — только проверка; счётчик инкрементирует recordContractFail.
    if (this.store.readCounter(CFAIL_SCOPE, keys.idkey, 'hour', hourStart) >= limits.contractFailsPerHour) {
      return verdict(false, 'contract_fails', 'hour');
    }

    // d) Ярус IP.
    if (this.store.bumpCounter(IP_SCOPE, keys.ipkey, 'minute', minuteStart) > limits.ipMinute) {
      return verdict(false, 'ip_minute', 'minute');
    }
    if (this.store.bumpCounter(IP_SCOPE, keys.ipkey, 'hour', hourStart) > limits.ipHour) {
      return verdict(false, 'ip_hour', 'hour');
    }
    if (this.store.bumpCounter(IP_SCOPE, keys.ipkey, 'day', dayStart) > limits.ipDay) {
      return verdict(false, 'ip_day', 'day');
    }

    // e) Ярус подсети — ботнет из одной /24 или /64.
    if (this.store.bumpCounter(SUBNET_SCOPE, keys.subnetkey, 'day', dayStart) > limits.subnetDay) {
      return verdict(false, 'subnet_day', 'day');
    }

    // f) Ярус устройства; fresh — пониженный дневной лимит.
    if (this.store.bumpCounter(DEV_SCOPE, keys.idkey, 'minute', minuteStart) > limits.deviceMinute) {
      return verdict(false, 'device_minute', 'minute');
    }
    if (this.store.bumpCounter(DEV_SCOPE, keys.idkey, 'hour', hourStart) > limits.deviceHour) {
      return verdict(false, 'device_hour', 'hour');
    }
    if (this.store.bumpCounter(DEV_SCOPE, keys.idkey, 'day', dayStart) > deviceDayLimit) {
      return verdict(false, 'device_day', 'day');
    }

    // g) Ротация device id с одного IP за день.
    this.store.addIpDevice(keys.ipkey, today, keys.idkey);
    if (this.store.countIpDevices(keys.ipkey, today) > limits.ipDistinctDevicesDay) {
      return verdict(false, 'ip_devices', 'day');
    }

    // h) Разрешено.
    return verdict(true);
  }
}
