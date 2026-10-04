import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { Logger } from './log.ts';
import { RuntimeState } from './state.ts';
import { Limiter } from './limiter/limiter.ts';
import { DeepSeekClient } from './llm/deepseek.ts';
import { MagicPipeline } from './llm/pipeline.ts';
import { createApp } from './server.ts';

const config = loadConfig(process.env as Record<string, string | undefined>);
const log = new Logger(config.logLevel, { svc: 'focuspin-backend', env: config.env });

if (config.databasePath !== ':memory:') {
  mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });
}

const db = openDb(config.databasePath);
const state = new RuntimeState();
const limiter = new Limiter(db, config, state);
const upstream = new DeepSeekClient(config);
const pipeline = new MagicPipeline({ config, upstream, limiter, log, state });
const app = createApp({ config, db, limiter, pipeline, log, state });

const purgeTimer = setInterval(() => {
  try {
    limiter.purge();
    log.debug('purge done');
  } catch (err) {
    log.warn('purge failed', { error: err instanceof Error ? err.message : String(err) });
  }
}, 10 * 60_000);
purgeTimer.unref?.();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  app.stop(false);
  const exitTimer = setTimeout(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  }, 2_000);
  exitTimer.unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log.info('listening', { port: app.port, model: config.upstreamModel, inflight: config.globalMaxInflight });
