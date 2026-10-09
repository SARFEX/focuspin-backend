import { Database } from 'bun:sqlite';

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      period TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, key, period, window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_counters_window ON counters (window_start);

    CREATE TABLE IF NOT EXISTS devices (
      idkey TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen);

    CREATE TABLE IF NOT EXISTS ip_devices (
      ipkey TEXT NOT NULL,
      day TEXT NOT NULL,
      idkey TEXT NOT NULL,
      PRIMARY KEY (ipkey, day, idkey)
    );

    CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      contract_fails INTEGER NOT NULL DEFAULT 0
    );

    -- Рефералы и статистика установок. email и ip здесь — сырые (осознанное исключение
    -- из HMAC-only, см. AGENTS.md); device_id — по-прежнему HMAC-хеш.
    CREATE TABLE IF NOT EXISTS referral_codes (
      code TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      -- Когда владелец вручную выдал Premium за этого реферера (NULL — ещё нет).
      premium_granted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS install_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      ref_code TEXT,
      source TEXT NOT NULL,
      build TEXT NOT NULL,
      app_version TEXT NOT NULL,
      os_version TEXT NOT NULL,
      locale TEXT NOT NULL,
      ip TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_install_events_ref ON install_events (ref_code);
    CREATE INDEX IF NOT EXISTS idx_install_events_created ON install_events (created_at);

    -- Фича «Premium за пост» убрана (решение владельца): таблицу из первой версии ветки сносим.
    DROP TABLE IF EXISTS post_claims;
  `);
  addColumnIfMissing(db, 'referral_codes', 'premium_granted_at', 'INTEGER');
}

/** Миграция для БД, созданных первой версией ветки (до появления колонки). */
function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
