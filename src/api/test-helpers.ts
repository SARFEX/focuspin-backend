import type { Database } from 'bun:sqlite';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { DeepSeekClient } from '../llm/deepseek.ts';
import { MagicPipeline } from '../llm/pipeline.ts';
import { Limiter } from '../limiter/limiter.ts';
import { Logger } from '../log.ts';
import { createApp } from '../server.ts';
import { RuntimeState } from '../state.ts';
import type { AppDeps } from '../types.ts';

/** Общие помощники интеграционных тестов реферальных и админ-путей: живой сервер на свободном порту, :memory:-БД. */

export const SECRET = 'test-secret-0123456789abcdef';
export const DEVICE_A = 'a'.repeat(32) + '_1';
export const DEVICE_B = 'b'.repeat(32) + '_2';
export const DEVICE_C = 'c'.repeat(32);
export const ADMIN_TOKEN = 'admin-token-0123456789abcdef-0123456789';

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error('no free port assigned');
  return port;
}

const BASE_ENV: Record<string, string> = {
  APP_ENV: 'test',
  DATABASE_PATH: ':memory:',
  HMAC_SECRET: SECRET,
  DEEPSEEK_API_KEY: 'test',
  LOG_LEVEL: 'error',
  GLOBAL_MAX_INFLIGHT: '8',
  GLOBAL_DAILY_REQUEST_CAP: '1000000',
  GLOBAL_DAILY_TOKEN_CAP: '1000000000',
  LIMIT_IP_MINUTE: '1000',
  LIMIT_IP_HOUR: '1000',
  LIMIT_IP_DAY: '1000',
  LIMIT_SUBNET_DAY: '1000',
  LIMIT_IP_DISTINCT_DEVICES_DAY: '100',
  LIMIT_DEVICE_MINUTE: '1000',
  LIMIT_DEVICE_HOUR: '1000',
  LIMIT_DEVICE_DAY: '1000',
  LIMIT_FRESH_DEVICE_HOURS: '24',
  LIMIT_FRESH_DEVICE_DAY: '1000',
  LIMIT_CONTRACT_FAILS_PER_HOUR: '1000',
  LIMIT_REFERRAL_DEVICE_DAY: '1000',
  LIMIT_REFERRAL_IP_DAY: '1000',
  LIMIT_INSTALL_IP_DAY: '1000',
  IP_RETENTION_DAYS: '90',
  REFERRAL_THRESHOLD: '3',
};

export interface RefApp {
  base: string;
  db: Database;
  state: RuntimeState;
  stop(): void;
}

export function bootRefApp(overrides: Record<string, string> = {}): RefApp {
  const config = loadConfig({ ...BASE_ENV, PORT: String(freePort()), ...overrides });
  const state = new RuntimeState();
  const db = openDb(':memory:');
  const limiter = new Limiter(db, config, state);
  const log = new Logger('error');
  const pipeline = new MagicPipeline({ config, upstream: new DeepSeekClient(config), limiter, log, state });
  const deps: AppDeps = { config, db, limiter, pipeline, log, state };
  const app = createApp(deps);
  return { base: `http://127.0.0.1:${app.port}`, db, state, stop: () => app.stop(true) };
}

export async function withRefApp<T>(overrides: Record<string, string>, run: (app: RefApp) => Promise<T>): Promise<T> {
  const app = bootRefApp(overrides);
  try {
    return await run(app);
  } finally {
    app.stop();
  }
}

export function post(app: RefApp, path: string, body: unknown, device: string | null = DEVICE_A, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (device !== null) headers['authorization'] = `Bearer ${device}`;
  return fetch(`${app.base}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

