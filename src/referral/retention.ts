import type { Database } from 'bun:sqlite';
import type { Logger } from '../log.ts';
import { HOUR_MS } from '../util/time.ts';
import { ReferralStore } from './store.ts';

/** Как часто обнулять просроченные IP (плюс один прогон на старте). */
export const IP_RETENTION_INTERVAL_MS = HOUR_MS;

/**
 * Одна чистка IP: обнуляет install_events.ip старше retentionDays суток. Не бросает —
 * сбой чистки не должен ронять сервер, он только логируется (без значений IP).
 * Возвращает число обнулённых строк (0 при ошибке).
 */
export function runIpRetention(db: Database, retentionDays: number, log: Pick<Logger, 'info' | 'warn'>, nowMs: number = Date.now()): number {
  try {
    const nulled = new ReferralStore(db).nullOldIps(nowMs, retentionDays);
    if (nulled > 0) log.info('ip retention', { nulled, retentionDays });
    return nulled;
  } catch (err) {
    log.warn('ip retention failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/** Прогон на старте + периодический таймер (unref — не удерживает процесс). */
export function startIpRetention(db: Database, retentionDays: number, log: Pick<Logger, 'info' | 'warn'>): ReturnType<typeof setInterval> {
  runIpRetention(db, retentionDays, log);
  const timer = setInterval(() => runIpRetention(db, retentionDays, log), IP_RETENTION_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
