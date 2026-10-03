import { validateMagicContent } from '../contract/index.ts';
import type { Config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { Limiter, IdentityKeys } from '../limiter/limiter.ts';
import type { Logger } from '../log.ts';
import type { RuntimeState } from '../state.ts';
import { CircuitBreaker } from './breaker.ts';
import { assertFocuspinSystemPrompt } from './prompt.ts';

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
  identity: IdentityKeys;
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

/** Досылка при невалидном JSON — без него модель часто повторяет ту же ошибку. */
const CORRECTIVE_USER_TEXT =
  'Твой предыдущий ответ не соответствует формату. Ответь заново ровно одним JSON-объектом вида {"commands":[...]} и без какого-либо другого текста.';

const UPSTREAM_DOWN_MESSAGE = 'ИИ-сервер недоступен, попробуйте позже.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Пайплайн «магии»: пин системного промпта -> вызов upstream с бюджетом времени
 * -> строгая валидация команд (contract) -> каноническая пересборка.
 * Один повтор при сбое upstream (429/5xx/timeout) и один корректирующий повтор
 * при невалидном JSON модели. Сырой текст модели наружу не уходит никогда.
 */
export class MagicPipeline {
  private readonly breaker: CircuitBreaker;

  constructor(private readonly deps: PipelineDeps) {
    this.breaker = new CircuitBreaker();
  }

  async run(input: MagicInput): Promise<MagicOutput> {
    const { config, upstream, log, state } = this.deps;
    const startedMs = Date.now();
    state.inc('magic_requests');
    try {
      if (!this.breaker.allowRequest()) {
        throw new HttpError('unavailable', 'Сервис перегружен, попробуйте чуть позже.', { retryAfterSeconds: 15 });
      }
      // Сообщения приходят уже shape-проверенными из API-слоя (ровно 2: system, user).
      assertFocuspinSystemPrompt(input.messages[0]?.content ?? '');
      const deadlineMs = Date.now() + config.requestBudgetMs;

      let promptTokens = 0;
      let completionTokens = 0;

      // Попытка 1 + один повтор при транзиентном сбое upstream.
      let result = await upstream.complete(input.messages, deadlineMs);
      if (!result.ok) {
        this.breaker.recordFailure();
        log.debug('upstream_fail', { kind: result.kind, status: result.status });
        const retryable =
          result.kind === 'timeout' ||
          (result.kind === 'http' && (result.status === 429 || (result.status !== undefined && result.status >= 500)));
        if (retryable && deadlineMs - Date.now() > 5_000) {
          await sleep(500 + Math.floor(Math.random() * 201));
          const retry = await upstream.complete(input.messages, deadlineMs);
          if (retry.ok) {
            this.breaker.recordSuccess();
            result = retry;
          } else {
            this.breaker.recordFailure();
            log.warn('upstream_fail_after_retry', { kind: retry.kind, status: retry.status });
          }
        }
      } else {
        this.breaker.recordSuccess();
      }
      if (!result.ok) {
        throw new HttpError('upstream_error', UPSTREAM_DOWN_MESSAGE, { retryAfterSeconds: 10 });
      }
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;

      // Строгая валидация; при провале — один корректирующий повтор.
      let validated = validateMagicContent(result.content);
      let correctiveRetryUsed = false;
      if (!validated.ok && config.correctiveRetry && deadlineMs - Date.now() > 8_000) {
        // Глубокая копия: вход пайплайна не мутируем.
        const correctiveMessages: UpstreamMessage[] = [
          ...input.messages.map((message) => ({ ...message })),
          { role: 'user', content: CORRECTIVE_USER_TEXT },
        ];
        const corrective = await upstream.complete(correctiveMessages, deadlineMs);
        if (!corrective.ok) {
          // Сбой транспорта в корректирующей попытке — транзиентный сбой,
          // а не вина устройства: считаем как upstream_error, не как contract_fail.
          this.breaker.recordFailure();
          log.warn('upstream_fail_corrective', { kind: corrective.kind, status: corrective.status });
          throw new HttpError('upstream_error', UPSTREAM_DOWN_MESSAGE, { retryAfterSeconds: 10 });
        }
        this.breaker.recordSuccess();
        promptTokens += corrective.promptTokens;
        completionTokens += corrective.completionTokens;
        correctiveRetryUsed = true;
        validated = validateMagicContent(corrective.content);
      }
      if (!validated.ok) {
        state.inc('contract_fails');
        throw new HttpError('contract_violation', 'Модель ответила не по формату, попробуйте ещё раз.', {
          retryAfterSeconds: 5,
        });
      }

      // Компактный лог без содержимого сообщений и полных ключей.
      log.info('magic_request', {
        idkeyShort: input.identity.idkey.slice(0, 8),
        requestedModel: input.requestedModel,
        commands: validated.commands.length,
        promptTokens,
        completionTokens,
        correctiveRetryUsed,
        ms: Date.now() - startedMs,
      });

      return {
        canonicalContent: validated.canonicalJson,
        commandCount: validated.commands.length,
        promptTokens,
        completionTokens,
        correctiveRetryUsed,
      };
    } finally {
      state.observeLatency('magic_ms', Date.now() - startedMs);
    }
  }
}
