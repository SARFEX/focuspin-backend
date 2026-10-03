import type { Config } from '../config.ts';
import type { Limiter, Identity } from '../limiter/limiter.ts';
import type { Logger } from '../log.ts';
import type { RuntimeState } from '../state.ts';

export interface UpstreamMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type UpstreamResult =
  | { ok: true; content: string; promptTokens: number; completionTokens: number }
  | { ok: false; kind: 'http' | 'timeout' | 'network'; status?: number; detail?: string };

/** Мост над upstream (DeepSeek, OpenAI-совместимый). Реализация — src/llm/deepseek.ts. */
export interface UpstreamClient {
  complete(messages: UpstreamMessage[], deadlineMs: number): Promise<UpstreamResult>;
}

export interface PipelineDeps {
  config: Config;
  upstream: UpstreamClient;
  limiter: Limiter;
  log: Logger;
  state: RuntimeState;
}

export interface MagicInput {
  /** Ровно два сообщения приложения: [0] system (промпт v4, пинится), [1] user (дата+контекст+запрос). */
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  identity: Identity;
  /** Что прислало приложение в поле model — игнорируется, логируется. */
  requestedModel: string;
}

export interface MagicOutput {
  /** Канонический JSON {"commands":[...]} — единственное, что уходит приложению. */
  canonicalContent: string;
  commandCount: number;
  promptTokens: number;
  completionTokens: number;
  correctiveRetryUsed: boolean;
}

/**
 * Пайплайн «магии»: пин системного промпта -> вызов upstream с бюджетом времени
 * -> строгая валидация команд (contract) -> каноническая пересборка.
 * Один повтор при сбое upstream (429/5xx/timeout) и один корректирующий повтор
 * при невалидном JSON модели. Сырой текст модели наружу не уходит никогда.
 */
export class MagicPipeline {
  constructor(private readonly deps: PipelineDeps) {
    void deps;
    throw new Error('MagicPipeline: not implemented');
  }

  async run(input: MagicInput): Promise<MagicOutput> {
    void input;
    throw new Error('MagicPipeline: not implemented');
  }
}
