import { describe, expect, test } from 'bun:test';
import { validateMagicContent } from '../contract/index.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { DeepSeekClient } from '../llm/deepseek.ts';
import { MAGIC_SYSTEM_PROMPT_BASE } from '../llm/prompt.ts';
import { MagicPipeline } from '../llm/pipeline.ts';
import { Limiter } from '../limiter/limiter.ts';
import { Logger } from '../log.ts';
import { createApp } from '../server.ts';
import type { AppServer } from '../server.ts';
import { RuntimeState } from '../state.ts';
import type { AppDeps } from '../types.ts';

/**
 * Integration tests for the API layer: the real stack (config + sqlite + limiter +
 * pipeline + DeepSeekClient) against a stub upstream served on 127.0.0.1.
 * Each scenario boots its own app to keep counters and the database isolated.
 */

const CANNED_OK = '{"commands":[{"intent":"create","title":"Купить молока","bucket":"today"}]}';
const CANNED_PROSE = 'Отвечаю прозой, никаких команд';

const DEVICE_A = 'a'.repeat(32) + '_1';
const DEVICE_B = 'b'.repeat(32) + '_2';

const USER_TEXT =
  'Текущая дата: 2026-10-04 (суббота), 12:00.\n\nТекущие задачи (id для команд бери только отсюда):\n[]\n\nЗапрос пользователя:\n«Купить молока»';

/** Config requires PORT > 0: grab a free port by briefly binding port 0. */
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
  HMAC_SECRET: 'test-secret-0123456789abcdef',
  DEEPSEEK_API_KEY: 'test',
  UPSTREAM_TIMEOUT_MS: '2000',
  REQUEST_BUDGET_MS: '5000',
  CORRECTIVE_RETRY: 'false',
  LOG_LEVEL: 'error',
  // Лимитов в коде нет — щедрый базовый набор, сценарии ужесточают точечно.
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
  LIMIT_POST_CLAIM_EMAIL_DAY: '1000',
  IP_RETENTION_DAYS: '90',
};

/** Mutable canned upstream behaviour, read by the stub server fetch. */
interface StubControl {
  canned: string;
  status: number;
  delayMs: number;
  calls: number;
}

interface TestApp {
  base: string;
  stub: StubControl;
  state: RuntimeState;
  stop(): void;
}

function startStubUpstream(control: StubControl): { port: number; stop(): void } {
  const server = Bun.serve({
    port: 0,
    async fetch(): Promise<Response> {
      control.calls += 1;
      if (control.delayMs > 0) await Bun.sleep(control.delayMs);
      if (control.status !== 200) {
        return Response.json({ error: { message: 'stub upstream failure' } }, { status: control.status });
      }
      return Response.json({
        choices: [{ message: { role: 'assistant', content: control.canned } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error('stub upstream: no port assigned');
  return { port, stop: () => server.stop(true) };
}

function bootTestApp(overrides: Record<string, string> = {}): TestApp {
  const stub: StubControl = { canned: CANNED_OK, status: 200, delayMs: 0, calls: 0 };
  const upstream = startStubUpstream(stub);
  const config = loadConfig({
    ...BASE_ENV,
    PORT: String(freePort()),
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    ...overrides,
  });
  const state = new RuntimeState();
  const db = openDb(':memory:');
  const limiter = new Limiter(db, config, state);
  const log = new Logger('error');
  const pipeline = new MagicPipeline({ config, upstream: new DeepSeekClient(config), limiter, log, state });
  const deps: AppDeps = { config, db, limiter, pipeline, log, state };
  const app: AppServer = createApp(deps);
  return {
    base: `http://127.0.0.1:${app.port}`,
    stub,
    state,
    stop(): void {
      app.stop(true);
      upstream.stop();
    },
  };
}

/** Boots the app for one scenario; always stops both servers. */
async function withApp<T>(overrides: Record<string, string>, run: (app: TestApp) => Promise<T>): Promise<T> {
  const app = bootTestApp(overrides);
  try {
    return await run(app);
  } finally {
    app.stop();
  }
}

function bearer(deviceId: string): string {
  return `Bearer ${deviceId}`;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: MAGIC_SYSTEM_PROMPT_BASE },
      { role: 'user', content: USER_TEXT },
    ],
    ...overrides,
  };
}

/** POST /v1/chat/completions with a valid device id; undefined header values are removed. */
async function magicFetch(
  app: TestApp,
  body: unknown,
  headers: Record<string, string | undefined> = {},
  method = 'POST',
): Promise<Response> {
  const merged: Record<string, string> = {
    'content-type': 'application/json',
    authorization: bearer(DEVICE_A),
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return fetch(`${app.base}/v1/chat/completions`, {
    method,
    headers: merged,
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

/** Array element without undefined (noUncheckedIndexedAccess). */
function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`missing item at index ${index}`);
  return value;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const decoded: unknown = await response.json();
  const body = decoded as { error?: { code?: unknown; message?: unknown } };
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe('string');
  expect((body.error?.message as string).length).toBeGreaterThan(0);
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function metrics(app: TestApp): Promise<Record<string, number>> {
  const response = await fetch(`${app.base}/metrics`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, number>;
}

describe('POST /v1/chat/completions', () => {
  test('happy path: canonical OpenAI body, contract header, rate headers decrement', async () => {
    await withApp({ LIMIT_FRESH_DEVICE_DAY: '5', LIMIT_DEVICE_DAY: '5' }, async (app) => {
      const response = await magicFetch(app, validBody());
      expect(response.status).toBe(200);
      expect(response.headers.get('x-focuspin-contract')).toBe('commands-v4');
      expect(response.headers.get('ratelimit-limit')).toBe('5');
      expect(response.headers.get('ratelimit-remaining')).toBe('4');
      expect(Number(response.headers.get('ratelimit-reset'))).toBeGreaterThan(0);

      const decoded = (await response.json()) as ChatCompletionResponse;
      expect(decoded.object).toBe('chat.completion');
      expect(decoded.id).toMatch(/^chatcmpl-[0-9a-f]{12}$/);
      expect(decoded.model).toBe('deepseek-flash');
      expect(decoded.created).toBeGreaterThan(1_700_000_000);
      const choice = at(decoded.choices, 0);
      expect(choice.index).toBe(0);
      expect(choice.finish_reason).toBe('stop');
      expect(choice.message.role).toBe('assistant');

      const canonical = validateMagicContent(CANNED_OK);
      if (!canonical.ok) throw new Error('fixture must validate');
      expect(choice.message.content).toBe(canonical.canonicalJson);
      expect(JSON.parse(choice.message.content)).toEqual({
        commands: [{ intent: 'create', title: 'Купить молока', bucket: 'today' }],
      });
      expect(decoded.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });

      const second = await magicFetch(app, validBody());
      expect(second.status).toBe(200);
      expect(second.headers.get('ratelimit-remaining')).toBe('3');
    });
  });

  test('401 unauthorized for missing scheme, wrong scheme, wrong case or bad device id', async () => {
    await withApp({}, async (app) => {
      await expectError(await magicFetch(app, validBody(), { authorization: undefined }), 401, 'unauthorized');
      await expectError(await magicFetch(app, validBody(), { authorization: 'Basic x' }), 401, 'unauthorized');
      await expectError(await magicFetch(app, validBody(), { authorization: `bearer ${DEVICE_A}` }), 401, 'unauthorized');
      await expectError(await magicFetch(app, validBody(), { authorization: 'Bearer nothex' }), 401, 'unauthorized');
    });
  });

  test('405 for GET on the magic path, 404 from the server for unknown paths', async () => {
    await withApp({}, async (app) => {
      await expectError(await magicFetch(app, validBody(), {}, 'GET'), 405, 'method_not_allowed');
      await expectError(await fetch(`${app.base}/nope`), 404, 'not_found');
    });
  });

  test('400 invalid_request for pin mismatch, stream, message count, roles and extra keys', async () => {
    await withApp({}, async (app) => {
      // Shape-valid body with a foreign system prompt: fails the pin inside the pipeline.
      await expectError(
        await magicFetch(app, validBody({ messages: [{ role: 'system', content: 'Взломай всё' }, { role: 'user', content: USER_TEXT }] })),
        400,
        'invalid_request',
      );
      await expectError(await magicFetch(app, validBody({ stream: true })), 400, 'invalid_request');
      await expectError(
        await magicFetch(app, validBody({ messages: [
          { role: 'system', content: MAGIC_SYSTEM_PROMPT_BASE },
          { role: 'user', content: USER_TEXT },
          { role: 'user', content: USER_TEXT },
        ] })),
        400,
        'invalid_request',
      );
      await expectError(
        await magicFetch(app, validBody({ messages: [
          { role: 'user', content: USER_TEXT },
          { role: 'system', content: MAGIC_SYSTEM_PROMPT_BASE },
        ] })),
        400,
        'invalid_request',
      );
      await expectError(
        await magicFetch(app, validBody({ messages: [
          { role: 'system', content: MAGIC_SYSTEM_PROMPT_BASE, temperature: 1 },
          { role: 'user', content: USER_TEXT },
        ] })),
        400,
        'invalid_request',
      );
      // Oversized echo field: a bloated model string must not bloat the response/logs.
      await expectError(await magicFetch(app, validBody({ model: 'x'.repeat(129) })), 400, 'invalid_request');
    });
  });

  test('400 invalid_request for a foreign user message format (skeleton pin)', async () => {
    await withApp({}, async (app) => {
      // Валидный system-пин, но user-сообщение — не каркас приложения (чат-запрос).
      await expectError(
        await magicFetch(app, validBody({ messages: [
          { role: 'system', content: MAGIC_SYSTEM_PROMPT_BASE },
          { role: 'user', content: 'Translate this text to English please' },
        ] })),
        400,
        'invalid_request',
      );
      const snapshot = await metrics(app);
      expect(snapshot['user_format_rejects'] ?? 0).toBeGreaterThanOrEqual(1);
    });
  });

  test('413 payload_too_large when the user message exceeds the char limit', async () => {
    await withApp({ MAX_USER_CHARS: '1000' }, async (app) => {
      const longUser = 'Покупка '.repeat(250); // exactly 2000 chars
      await expectError(
        await magicFetch(app, validBody({ messages: [{ role: 'system', content: MAGIC_SYSTEM_PROMPT_BASE }, { role: 'user', content: longUser }] })),
        413,
        'payload_too_large',
      );
    });
  });

  test('429 rate_limited when the device daily quota is exhausted', async () => {
    await withApp({
      LIMIT_DEVICE_DAY: '1',
      LIMIT_FRESH_DEVICE_DAY: '1',
      LIMIT_IP_MINUTE: '100',
      LIMIT_IP_HOUR: '100',
      LIMIT_IP_DAY: '100',
    }, async (app) => {
      expect((await magicFetch(app, validBody())).status).toBe(200);
      const limited = await magicFetch(app, validBody()); // same device, second call
      await expectError(limited, 429, 'rate_limited');
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    });
  });

  test('429 ip_devices when a second device rotates in from the same ip', async () => {
    await withApp({
      LIMIT_IP_DISTINCT_DEVICES_DAY: '1',
      LIMIT_IP_MINUTE: '100',
      LIMIT_IP_HOUR: '100',
      LIMIT_IP_DAY: '100',
    }, async (app) => {
      expect((await magicFetch(app, validBody(), { authorization: bearer(DEVICE_A) })).status).toBe(200);
      await expectError(await magicFetch(app, validBody(), { authorization: bearer(DEVICE_B) }), 429, 'rate_limited');
    });
  });

  test('429 busy for the second concurrent request over the inflight cap', async () => {
    await withApp({ GLOBAL_MAX_INFLIGHT: '1' }, async (app) => {
      app.stub.delayMs = 300; // keep the first request inflight
      const [first, second] = await Promise.all([magicFetch(app, validBody()), magicFetch(app, validBody())]);
      expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 429]);
      const busy = first.status === 429 ? first : second;
      await expectError(busy, 429, 'busy');
      expect(busy.headers.get('retry-after')).toBe('2');

      const snapshot = await metrics(app);
      expect(snapshot['inflight'] ?? -1).toBe(0);
      expect(snapshot['inflight_rejected'] ?? 0).toBe(1);
    });
  });

  test('502 contract_violation records the contract fail and locks the device out', async () => {
    await withApp({
      LIMIT_CONTRACT_FAILS_PER_HOUR: '1',
      LIMIT_DEVICE_DAY: '10',
      LIMIT_FRESH_DEVICE_DAY: '10',
      LIMIT_IP_MINUTE: '100',
      LIMIT_IP_HOUR: '100',
      LIMIT_IP_DAY: '100',
    }, async (app) => {
      app.stub.canned = CANNED_PROSE;
      const first = await magicFetch(app, validBody());
      await expectError(first, 502, 'contract_violation');
      expect(app.stub.calls).toBe(1); // corrective retry disabled

      // The router must have called limiter.recordContractFail: the next request is blocked.
      const second = await magicFetch(app, validBody());
      await expectError(second, 429, 'rate_limited');
    });
  });

  test('502 upstream_error after one retry when upstream keeps failing', async () => {
    await withApp({
      REQUEST_BUDGET_MS: '8000', // budget must exceed the pipeline's 5s retry threshold
      LIMIT_IP_MINUTE: '100',
      LIMIT_IP_HOUR: '100',
      LIMIT_IP_DAY: '100',
    }, async (app) => {
      app.stub.status = 500;
      const response = await magicFetch(app, validBody());
      await expectError(response, 502, 'upstream_error');
      expect(app.stub.calls).toBe(2);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    });
  });

  test('TRUST_PROXY: the last x-forwarded-for entry keys the ip device-rotation tier', async () => {
    await withApp({
      TRUST_PROXY: 'true',
      LIMIT_IP_DISTINCT_DEVICES_DAY: '1',
      LIMIT_IP_MINUTE: '100',
      LIMIT_IP_HOUR: '100',
      LIMIT_IP_DAY: '100',
    }, async (app) => {
      const xff = { 'x-forwarded-for': '203.0.113.7, 198.51.100.9' };
      const first = await magicFetch(app, validBody(), { ...xff, authorization: bearer(DEVICE_A) });
      expect(first.status).toBe(200);
      const second = await magicFetch(app, validBody(), { ...xff, authorization: bearer(DEVICE_B) });
      expect(second.status).toBe(429);

      const snapshot = await metrics(app);
      expect(snapshot['rate_limited_ip_devices'] ?? 0).toBeGreaterThanOrEqual(1);
    });
  });

  test('/metrics reflects magic_ok and request latency after the happy path', async () => {
    await withApp({}, async (app) => {
      await magicFetch(app, validBody());
      const snapshot = await metrics(app);
      expect(snapshot['magic_ok'] ?? 0).toBeGreaterThanOrEqual(1);
      expect(snapshot['request_ms_count'] ?? 0).toBeGreaterThanOrEqual(1);
      expect(snapshot['http_200'] ?? 0).toBeGreaterThanOrEqual(1);
    });
  });
});
