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
  `);
}
