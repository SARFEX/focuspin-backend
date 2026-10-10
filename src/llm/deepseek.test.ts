import { afterAll, describe, expect, test } from 'bun:test';
import { loadConfig } from '../config.ts';
import type { UpstreamMessage } from './pipeline.ts';
import { DeepSeekClient, resolveChatCompletionsUri } from './deepseek.ts';

const BASE_ENV: Record<string, string> = {
  APP_ENV: 'test',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_MODEL: 'test-model',
  UPSTREAM_TIMEOUT_MS: '5000',
  REQUEST_BUDGET_MS: '10000',
  // Клиент лимитов не касается, но loadConfig требует их явно (дефолтов нет).
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

function makeClient(overrides: Record<string, string> = {}): DeepSeekClient {
  return new DeepSeekClient(loadConfig({ ...BASE_ENV, ...overrides }));
}

const MESSAGES: UpstreamMessage[] = [
  { role: 'system', content: 'system-prompt' },
  { role: 'user', content: 'user-request' },
];

describe('resolveChatCompletionsUri', () => {
  test('bare host gets /v1/chat/completions', () => {
    expect(resolveChatCompletionsUri('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  test('trailing slash is stripped before suffixing', () => {
    expect(resolveChatCompletionsUri('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  test('/v1 gets only /chat/completions', () => {
    expect(resolveChatCompletionsUri('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  test('/v1/ gets only /chat/completions', () => {
    expect(resolveChatCompletionsUri('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  test('explicit /chat/completions stays as-is', () => {
    expect(resolveChatCompletionsUri('https://proxy.example.com/api/chat/completions')).toBe(
      'https://proxy.example.com/api/chat/completions',
    );
  });
});

describe('DeepSeekClient', () => {
  /** Подменяемый обработчик и захват последнего запроса. */
  let handler: (req: Request) => Response | Promise<Response> = () => Response.json({});
  let lastRequest: { path: string; auth: string; body: unknown } | null = null;

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      lastRequest = {
        path: new URL(req.url).pathname,
        auth: req.headers.get('authorization') ?? '',
        body: await req.json(),
      };
      return handler(req);
    },
  });
  const baseUrl = server.url.toString().replace(/\/$/, '');

  afterAll(() => server.stop(true));

  test('happy path maps content and usage, sends model/temperature/auth', async () => {
    handler = () =>
      Response.json({
        choices: [{ message: { content: '{"commands":[]}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.content).toBe('{"commands":[]}');
    expect(result.promptTokens).toBe(11);
    expect(result.completionTokens).toBe(7);

    const captured = lastRequest;
    if (captured === null) throw new Error('no request captured');
    expect(captured.path).toBe('/v1/chat/completions');
    expect(captured.auth).toBe('Bearer test-key');
    expect(captured.body).toEqual({ model: 'test-model', messages: MESSAGES, temperature: 0, max_tokens: 8000 });
  });

  test('max_tokens is configurable via MAX_COMPLETION_TOKENS', async () => {
    handler = () => Response.json({ choices: [{ message: { content: '{"commands":[]}' } }] });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl, MAX_COMPLETION_TOKENS: '1234' });
    await client.complete(MESSAGES, Date.now() + 5000);
    const captured = lastRequest;
    if (captured === null) throw new Error('no request captured');
    expect((captured.body as { max_tokens: number }).max_tokens).toBe(1234);
  });

  test('missing usage defaults tokens to 0', async () => {
    handler = () => Response.json({ choices: [{ message: { content: 'ok' } }] });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: true, content: 'ok', promptTokens: 0, completionTokens: 0 });
  });

  test('429 maps to kind http with status', async () => {
    handler = () => new Response('slow down', { status: 429 });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: false, kind: 'http', status: 429, detail: 'slow down' });
  });

  test('500 maps to kind http with status', async () => {
    handler = () => new Response('boom', { status: 500 });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: false, kind: 'http', status: 500, detail: 'boom' });
  });

  test('non-JSON 200 maps to bad response shape', async () => {
    handler = () => new Response('это не json', { headers: { 'content-type': 'text/plain' } });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: false, kind: 'http', status: 200, detail: 'bad response shape' });
  });

  test('200 with missing content maps to bad response shape', async () => {
    handler = () => Response.json({ choices: [{ message: {} }] });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: false, kind: 'http', status: 200, detail: 'bad response shape' });
  });

  test('empty choices maps to bad response shape', async () => {
    handler = () => Response.json({ choices: [] });
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: false, kind: 'http', status: 200, detail: 'bad response shape' });
  });

  test('slow upstream beyond upstreamTimeoutMs maps to kind timeout', async () => {
    handler = async () => {
      await Bun.sleep(400);
      return Response.json({ choices: [{ message: { content: 'too late' } }] });
    };
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl, UPSTREAM_TIMEOUT_MS: '60' });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: false, kind: 'timeout' });
  });

  test('expired deadline times out without a request', async () => {
    let requested = false;
    handler = () => {
      requested = true;
      return Response.json({});
    };
    const client = makeClient({ DEEPSEEK_BASE_URL: baseUrl });
    const result = await client.complete(MESSAGES, Date.now() - 1);
    expect(result).toEqual({ ok: false, kind: 'timeout' });
    expect(requested).toBe(false);
  });

  test('connection refused maps to kind network', async () => {
    const oneShot = Bun.serve({ port: 0, fetch: () => Response.json({}) });
    const deadUrl = oneShot.url.toString().replace(/\/$/, '');
    oneShot.stop(true);
    const client = makeClient({ DEEPSEEK_BASE_URL: deadUrl });
    const result = await client.complete(MESSAGES, Date.now() + 5000);
    expect(result).toEqual({ ok: false, kind: 'network' });
  });
});
