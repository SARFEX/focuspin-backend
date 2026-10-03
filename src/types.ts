import type { Database } from 'bun:sqlite';
import type { Config } from './config.ts';
import type { Limiter } from './limiter/limiter.ts';
import type { MagicPipeline } from './llm/pipeline.ts';
import type { Logger } from './log.ts';
import type { RuntimeState } from './state.ts';

export interface AppDeps {
  config: Config;
  db: Database;
  limiter: Limiter;
  pipeline: MagicPipeline;
  log: Logger;
  state: RuntimeState;
}

export interface RequestContext {
  requestId: string;
  /** Сокетный адрес клиента (server.requestIP). Пустая строка, если не удалось определить. */
  clientIp: string;
}
