import type { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { DAY_MS } from '../util/time.ts';
import { generateReferralCode } from './codes.ts';

export interface InstallRow {
  /** HMAC-хеш device id (сырой id в БД не пишем). */
  deviceId: string;
  refCode: string | null;
  source: string;
  build: string;
  appVersion: string;
  osVersion: string;
  locale: string;
  /** Клиентский IP для защиты от накрутки; обнуляется по IP_RETENTION_DAYS. */
  ip: string | null;
}

/** Засчитанный друг: установка по коду с source=play и build=play (не full/ручная/органика). */
export const COUNTED_SOURCE = 'play';
export const COUNTED_BUILD = 'play';

export interface ReferralAdminRow {
  code: string;
  email: string;
  createdAt: number;
  /** Все установки с этим кодом (любой источник и сборка). */
  totalInstalls: number;
  /** Засчитанные: уникальные устройства с source=play и build=play (device_id UNIQUE — одно устройство один раз). */
  countedInstalls: number;
  installs: Array<{
    deviceId: string;
    ip: string | null;
    createdAt: number;
    source: string;
    build: string;
    counted: boolean;
  }>;
}

export interface AdminReferralsQuery {
  limit: number;
  /** Если задан — только коды, у которых засчитанных установок не меньше порога (REFERRAL_THRESHOLD). */
  minCounted?: number;
}

export interface InstallStats {
  total: number;
  withRefCode: number;
  byDay: Array<{ day: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
  byBuild: Array<{ build: string; count: number }>;
}

const MAX_CODE_ATTEMPTS = 5;

/** Синхронные запросы к таблицам рефералов и установок. Всё — параметризованный SQL. */
export class ReferralStore {
  constructor(private readonly db: Database) {}

  private q<Row>(sql: string): Statement<Row, SQLQueryBindings[]> {
    return this.db.query<Row, SQLQueryBindings[]>(sql);
  }

  /** Один email — один код: повтор возвращает прежний. Коллизия кода (≈0) — ретрай с новым. */
  getOrCreateCode(email: string, nowMs: number): string {
    const existing = this.q<{ code: string }>('SELECT code FROM referral_codes WHERE email = ?').get(email);
    if (existing) return existing.code;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      this.q('INSERT OR IGNORE INTO referral_codes (code, email, created_at) VALUES (?, ?, ?)').run(
        generateReferralCode(),
        email,
        nowMs,
      );
      // Либо вставили мы, либо (гонка/коллизия) email уже занят — читаем итоговый код.
      const row = this.q<{ code: string }>('SELECT code FROM referral_codes WHERE email = ?').get(email);
      if (row) return row.code;
    }
    throw new Error('ReferralStore: не удалось выдать уникальный код');
  }

  codeExists(code: string): boolean {
    return this.q<{ one: number }>('SELECT 1 AS one FROM referral_codes WHERE code = ?').get(code) !== null;
  }

  /** Первая запись по device_id побеждает; повтор игнорируется. true — вставлено. */
  insertInstall(row: InstallRow, nowMs: number): boolean {
    const result = this.q(
      `INSERT OR IGNORE INTO install_events
         (device_id, ref_code, source, build, app_version, os_version, locale, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.deviceId, row.refCode, row.source, row.build, row.appVersion, row.osVersion, row.locale, row.ip, nowMs);
    return result.changes > 0;
  }

  /**
   * Ретеншн IP: обнуляет ip у установок старше retentionDays суток. Остальные поля
   * (статистика, связь с кодом) остаются. Возвращает число обнулённых строк.
   */
  nullOldIps(nowMs: number, retentionDays: number): number {
    const cutoff = nowMs - retentionDays * DAY_MS;
    return this.q('UPDATE install_events SET ip = NULL WHERE ip IS NOT NULL AND created_at < ?').run(cutoff).changes;
  }

  /**
   * Коды со счётчиками и списком установок (device, ip, время, источник, сборка). Сначала самые
   * результативные по засчитанным. minCounted отсекает коды ниже порога до применения limit.
   */
  adminReferrals(query: AdminReferralsQuery): ReferralAdminRow[] {
    const having = query.minCounted === undefined ? '' : 'HAVING counted >= ?';
    const params: SQLQueryBindings[] = [COUNTED_SOURCE, COUNTED_BUILD];
    if (query.minCounted !== undefined) params.push(query.minCounted);
    params.push(query.limit);
    const codes = this.q<{ code: string; email: string; created_at: number; installs: number; counted: number }>(
      `SELECT c.code, c.email, c.created_at, COUNT(i.id) AS installs,
              COALESCE(SUM(CASE WHEN i.source = ? AND i.build = ? THEN 1 ELSE 0 END), 0) AS counted
         FROM referral_codes c LEFT JOIN install_events i ON i.ref_code = c.code
        GROUP BY c.code ${having}
        ORDER BY counted DESC, installs DESC, c.created_at DESC, c.code LIMIT ?`,
    ).all(...params);
    const installs = this.q<{
      device_id: string;
      ip: string | null;
      created_at: number;
      source: string;
      build: string;
    }>('SELECT device_id, ip, created_at, source, build FROM install_events WHERE ref_code = ? ORDER BY created_at ASC, id ASC');
    return codes.map((c) => ({
      code: c.code,
      email: c.email,
      createdAt: c.created_at,
      totalInstalls: c.installs,
      countedInstalls: c.counted,
      installs: installs.all(c.code).map((i) => ({
        deviceId: i.device_id,
        ip: i.ip,
        createdAt: i.created_at,
        source: i.source,
        build: i.build,
        counted: i.source === COUNTED_SOURCE && i.build === COUNTED_BUILD,
      })),
    }));
  }

  installStats(): InstallStats {
    const totals = this.q<{ total: number; with_ref: number }>(
      'SELECT COUNT(*) AS total, COUNT(ref_code) AS with_ref FROM install_events',
    ).get();
    return {
      total: totals?.total ?? 0,
      withRefCode: totals?.with_ref ?? 0,
      byDay: this.q<{ day: string; count: number }>(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
           FROM install_events GROUP BY day ORDER BY day`,
      ).all(),
      bySource: this.q<{ source: string; count: number }>(
        'SELECT source, COUNT(*) AS count FROM install_events GROUP BY source ORDER BY count DESC, source',
      ).all(),
      byBuild: this.q<{ build: string; count: number }>(
        'SELECT build, COUNT(*) AS count FROM install_events GROUP BY build ORDER BY count DESC, build',
      ).all(),
    };
  }
}
