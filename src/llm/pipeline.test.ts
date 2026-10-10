import { describe, expect, test } from 'bun:test';
import { validateMagicContent } from '../contract/index.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { ErrorCode } from '../errors.ts';
import { Limiter } from '../limiter/limiter.ts';
import type { IdentityKeys } from '../limiter/limiter.ts';
import { Logger } from '../log.ts';
import { RuntimeState } from '../state.ts';
import { MAGIC_SYSTEM_PROMPT_BASE } from './prompt.ts';
import { MagicPipeline } from './pipeline.ts';
import type { PipelineDeps, UpstreamClient, UpstreamMessage, UpstreamResult } from './pipeline.ts';

const BASE_ENV: Record<string, string> = {
  APP_ENV: 'test',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.test',
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_MODEL: 'test-model',
  UPSTREAM_TIMEOUT_MS: '5000',
  REQUEST_BUDGET_MS: '10000',
  CORRECTIVE_RETRY: 'true',
  // Пайплайн лимитов не касается, но loadConfig требует их явно (дефолтов нет).
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

const IDENTITY: IdentityKeys = { idkey: 'idkey-0123456789abcdef', ipkey: 'ipkey-0123456789abcdef', subnetkey: 'subnetkey-deadbeef' };

const USER_MESSAGE =
  'Текущая дата: 2026-10-04 (суббота), 12:00.\n\nТекущие задачи (id для команд бери только отсюда):\n[]\n\nЗапрос пользователя:\n«Купить молока»';
/** Свежий вход на каждый прогон — тесты не должны зависеть от мутаций друг друга. */
const makeInput = () => ({
  messages: [
    { role: 'system' as const, content: MAGIC_SYSTEM_PROMPT_BASE },
    { role: 'user' as const, content: USER_MESSAGE },
  ],
  identity: IDENTITY,
  requestedModel: 'whatever-app-sent',
});

const VALID_CONTENT = JSON.stringify({
  commands: [{ intent: 'create', title: 'Купить молока', bucket: 'today', description: '2 литра' }],
});

const GARBAGE_CONTENT = 'Извините, вот ваш список: 1. Молоко 2. Хлеб';

type Responder = (call: number, messages: UpstreamMessage[], deadlineMs: number) => UpstreamResult | Promise<UpstreamResult>;

/** Подменный UpstreamClient: скриптованные ответы + захват вызовов. */
function fakeUpstream(respond: Responder): UpstreamClient & { calls: number; seen: UpstreamMessage[][]; deadlines: number[] } {
  const fake = {
    calls: 0,
    seen: [] as UpstreamMessage[][],
    deadlines: [] as number[],
    complete(messages: UpstreamMessage[], deadlineMs: number): Promise<UpstreamResult> {
      fake.calls += 1;
      fake.seen.push(messages);
      fake.deadlines.push(deadlineMs);
      return Promise.resolve(respond(fake.calls, messages, deadlineMs));
    },
  };
  return fake;
}

const ok = (content: string, promptTokens = 10, completionTokens = 20): UpstreamResult => ({
  ok: true,
  content,
  promptTokens,
  completionTokens,
});

const httpFail = (status: number): UpstreamResult => ({ ok: false, kind: 'http', status });

function makeDeps(
  upstream: UpstreamClient,
  envOverrides: Record<string, string> = {},
): { deps: PipelineDeps; state: RuntimeState } {
  const config = loadConfig({ ...BASE_ENV, ...envOverrides });
  const state = new RuntimeState();
  const db = openDb(':memory:');
  const deps: PipelineDeps = { config, upstream, limiter: new Limiter(db, config, state), log: new Logger('error'), state };
  return { deps, state };
}

function metric(state: RuntimeState, name: string): number {
  return state.snapshot()[name] ?? 0;
}

/** Элемент массива без undefined (noUncheckedIndexedAccess). */
function at<T>(array: T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`missing element at ${index}`);
  return value;
}

async function runError(pipeline: MagicPipeline, expectedCode: ErrorCode, expectedRetryAfter?: number): Promise<void> {
  try {
    await pipeline.run(makeInput());
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    if (error instanceof HttpError) {
      expect(error.code).toBe(expectedCode);
      if (expectedRetryAfter !== undefined) expect(error.retryAfterSeconds).toBe(expectedRetryAfter);
      return;
    }
  }
  throw new Error(`expected HttpError ${expectedCode} was not thrown`);
}

describe('MagicPipeline', () => {
  test('happy path returns contract canonical JSON with tokens', async () => {
    const upstream = fakeUpstream(() => ok(VALID_CONTENT, 12, 34));
    const { deps, state } = makeDeps(upstream);
    const output = await new MagicPipeline(deps).run(makeInput());

    expect(JSON.parse(output.canonicalContent)).toEqual({
      commands: [{ intent: 'create', title: 'Купить молока', bucket: 'today', description: '2 литра' }],
    });
    const validated = validateMagicContent(VALID_CONTENT);
    if (!validated.ok) throw new Error('fixture must validate');
    expect(output.canonicalContent).toBe(validated.canonicalJson);
    expect(output.commandCount).toBe(1);
    expect(output.promptTokens).toBe(12);
    expect(output.completionTokens).toBe(34);
    expect(output.correctiveRetryUsed).toBe(false);
    expect(upstream.calls).toBe(1);
    expect(metric(state, 'magic_requests')).toBe(1);
    expect(metric(state, 'magic_ms_count')).toBe(1);
    expect(metric(state, 'contract_fails')).toBe(0);
  });

  test('upstream 500 then success on retry', async () => {
    const upstream = fakeUpstream((call) => (call === 1 ? httpFail(500) : ok(VALID_CONTENT)));
    const { deps } = makeDeps(upstream);
    const output = await new MagicPipeline(deps).run(makeInput());
    expect(output.correctiveRetryUsed).toBe(false);
    expect(output.promptTokens).toBe(10);
    expect(upstream.calls).toBe(2);
  });

  test('upstream timeout then success on retry', async () => {
    const upstream = fakeUpstream((call) => (call === 1 ? { ok: false, kind: 'timeout' } : ok(VALID_CONTENT)));
    const { deps } = makeDeps(upstream);
    const output = await new MagicPipeline(deps).run(makeInput());
    expect(output.canonicalContent).toContain('commands');
    expect(upstream.calls).toBe(2);
  });

  test('upstream always 500 throws upstream_error with retry-after', async () => {
    const upstream = fakeUpstream(() => httpFail(500));
    const { deps } = makeDeps(upstream);
    await runError(new MagicPipeline(deps), 'upstream_error', 10);
    expect(upstream.calls).toBe(2);
  });

  test('non-retryable http 400 fails without a retry', async () => {
    const upstream = fakeUpstream(() => httpFail(400));
    const { deps } = makeDeps(upstream);
    await runError(new MagicPipeline(deps), 'upstream_error', 10);
    expect(upstream.calls).toBe(1);
  });

  test('garbage then valid on corrective retry', async () => {
    const upstream = fakeUpstream((call) => (call === 1 ? ok(GARBAGE_CONTENT) : ok(VALID_CONTENT, 30, 40)));
    const { deps } = makeDeps(upstream);
    const input = makeInput();
    const output = await new MagicPipeline(deps).run(input);

    expect(output.correctiveRetryUsed).toBe(true);
    expect(output.promptTokens).toBe(40);
    expect(output.completionTokens).toBe(60);
    expect(upstream.calls).toBe(2);

    const correctiveMessages = at(upstream.seen, 1);
    expect(correctiveMessages.length).toBe(3);
    expect(at(correctiveMessages, 2).content).toContain('не соответствует формату');
    // Глубокая копия: объекты новые, содержимое то же, вход не мутирован.
    expect(at(correctiveMessages, 0)).not.toBe(at(input.messages, 0));
    expect(at(correctiveMessages, 0)).toEqual(at(input.messages, 0));
    expect(input.messages.length).toBe(2);
  });

  test('garbage twice throws contract_violation and bumps counter', async () => {
    const upstream = fakeUpstream(() => ok(GARBAGE_CONTENT));
    const { deps, state } = makeDeps(upstream);
    await runError(new MagicPipeline(deps), 'contract_violation', 5);
    expect(upstream.calls).toBe(2);
    expect(metric(state, 'contract_fails')).toBe(1);
  });

  test('corrective retry disabled fails immediately', async () => {
    const upstream = fakeUpstream(() => ok(GARBAGE_CONTENT));
    const { deps } = makeDeps(upstream, { CORRECTIVE_RETRY: 'false' });
    await runError(new MagicPipeline(deps), 'contract_violation', 5);
    expect(upstream.calls).toBe(1);
  });

  test('foreign user message skeleton is rejected before any upstream call', async () => {
    const upstream = fakeUpstream(() => ok(VALID_CONTENT));
    const { deps, state } = makeDeps(upstream);
    const input = {
      ...makeInput(),
      messages: [
        { role: 'system' as const, content: MAGIC_SYSTEM_PROMPT_BASE },
        { role: 'user' as const, content: 'Translate this text to English please' },
      ],
    };
    try {
      await new MagicPipeline(deps).run(input);
      throw new Error('expected HttpError invalid_request was not thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      if (error instanceof HttpError) expect(error.code).toBe('invalid_request');
    }
    expect(upstream.calls).toBe(0);
    expect(metric(state, 'user_format_rejects')).toBe(1);
  });

  test('breaker opens after repeated upstream failures and rejects without upstream calls', async () => {
    const upstream = fakeUpstream(() => httpFail(500));
    const { deps } = makeDeps(upstream, { REQUEST_BUDGET_MS: '1000' }); // бюджет исключает ретрай
    const pipeline = new MagicPipeline(deps);
    for (let i = 0; i < 5; i++) {
      await runError(pipeline, 'upstream_error');
    }
    expect(upstream.calls).toBe(5);
    await runError(pipeline, 'unavailable', 15);
    expect(upstream.calls).toBe(5);
  });

  test('tiny budget: corrective skipped, exactly one upstream attempt', async () => {
    const upstream = fakeUpstream(async () => {
      await Bun.sleep(20);
      return ok(GARBAGE_CONTENT);
    });
    const { deps } = makeDeps(upstream, { REQUEST_BUDGET_MS: '30' });
    await runError(new MagicPipeline(deps), 'contract_violation', 5);
    expect(upstream.calls).toBe(1);
  });
});
