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

export interface ReferralAdminRow {
  code: string;
  email: string;
  createdAt: number;
  installsCount: number;
  installs: Array<{ deviceId: string; ip: string | null; createdAt: number }>;
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

  /** Коды с числом установок и списком установок (device, ip, время). Сначала самые результативные. */
  adminReferrals(limit: number): ReferralAdminRow[] {
    const codes = this.q<{ code: string; email: string; created_at: number; installs: number }>(
      `SELECT c.code, c.email, c.created_at, COUNT(i.id) AS installs
         FROM referral_codes c LEFT JOIN install_events i ON i.ref_code = c.code
        GROUP BY c.code ORDER BY installs DESC, c.created_at DESC LIMIT ?`,
    ).all(limit);
    const installs = this.q<{ ref_code: string; device_id: string; ip: string | null; created_at: number }>(
      'SELECT ref_code, device_id, ip, created_at FROM install_events WHERE ref_code = ? ORDER BY created_at ASC',
    );
    return codes.map((c) => ({
      code: c.code,
      email: c.email,
      createdAt: c.created_at,
      installsCount: c.installs,
      installs: installs
        .all(c.code)
        .map((i) => ({ deviceId: i.device_id, ip: i.ip, createdAt: i.created_at })),
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
