// scripts/smoke.ts — end-to-end самопроверка реального сервера против локального стаба.
// Поднимает стаб DeepSeek (8901) и сервер (8911), прогоняет сценарии, убивает детей, exit 0/1.
// Запуск: bun run scripts/smoke.ts   (или bun run smoke)

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAGIC_SYSTEM_PROMPT_BASE } from '../src/llm/prompt.ts';

const ROOT = resolve(import.meta.dir, '..');
const STUB_PORT = 8901;
const SERVER_PORT = 8911;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const DEVICE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_1';
const CONTRACT_HEADER = 'commands-v4';
// Одноразовый токен админки на время прогона — нигде не хранится и не печатается.
const ADMIN_TOKEN = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
const DEVICE_REF = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_1';

interface Check {
  ok: boolean;
  detail: string;
}

const failures: string[] = [];

async function scenario(name: string, fn: () => Promise<Check>): Promise<void> {
  try {
    const result = await fn();
    if (result.ok) {
      console.log(`  PASS  ${name}  (${result.detail})`);
    } else {
      console.log(`  FAIL  ${name}  (${result.detail})`);
      failures.push(name);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL  ${name}  (исключение: ${message})`);
    failures.push(name);
  }
}

/** Тело magic-запроса в форме OpenAI chat.completions (каркас приложения). */
function magicBody(systemContent: string, userContent: string = USER_APP_MESSAGE): string {
  return JSON.stringify({
    model: 'deepseek-flash',
    temperature: 0,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
  });
}

/** Каркас user-сообщения из buildMagicUserMessage приложения. */
const USER_APP_MESSAGE =
  'Текущая дата: 2026-10-04 (суббота), 14:05.\n\nТекущие задачи (id для команд бери только отсюда):\n[]\n\nЗапрос пользователя:\n«выпить воды»';

async function jsonError(res: Response): Promise<{ code: string; retryAfter: string | null }> {
  let code = '';
  try {
    const decoded = (await res.json()) as { error?: { code?: unknown } };
    if (typeof decoded.error?.code === 'string') code = decoded.error.code;
  } catch {
    // тела нет — код останется пустым
  }
  return { code, retryAfter: res.headers.get('retry-after') };
}

async function main(): Promise<number> {
  const bunBin = process.execPath; // путь к bun — работает и на Windows, и на Linux
  const dbPath = join(tmpdir(), `smoke-${process.pid}.db`);

  const stub = Bun.spawn([bunBin, 'run', 'scripts/stub-deepseek.ts'], {
    cwd: ROOT,
    env: { ...process.env, STUB_PORT: String(STUB_PORT), STUB_MODE: 'valid' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const server = Bun.spawn([bunBin, 'run', 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      APP_ENV: 'development',
      PORT: String(SERVER_PORT),
      DATABASE_PATH: dbPath,
      HMAC_SECRET: 'smoke-secret-0123456789abcdef',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
      DEEPSEEK_API_KEY: 'stub',
      LOG_LEVEL: 'warn',
      // Лимиты обязательны (в коде дефолтов нет) — стартовый набор .env.example.
      GLOBAL_MAX_INFLIGHT: '8',
      GLOBAL_DAILY_REQUEST_CAP: '20000',
      GLOBAL_DAILY_TOKEN_CAP: '25000000',
      LIMIT_IP_MINUTE: '15',
      LIMIT_IP_HOUR: '60',
      LIMIT_IP_DAY: '300',
      LIMIT_SUBNET_DAY: '1200',
      LIMIT_IP_DISTINCT_DEVICES_DAY: '6',
      LIMIT_DEVICE_MINUTE: '6',
      LIMIT_DEVICE_HOUR: '15',
      LIMIT_DEVICE_DAY: '50',
      LIMIT_FRESH_DEVICE_HOURS: '24',
      LIMIT_FRESH_DEVICE_DAY: '15',
      LIMIT_CONTRACT_FAILS_PER_HOUR: '10',
      LIMIT_REFERRAL_DEVICE_DAY: '10',
      LIMIT_REFERRAL_IP_DAY: '30',
      LIMIT_INSTALL_IP_DAY: '200',
      IP_RETENTION_DAYS: '90',
      ADMIN_TOKEN,
      PUBLIC_BASE_URL: BASE,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let serverUp = false;
  try {
    // c) ждём готовность сервера (≤10 c).
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.status === 200) {
          serverUp = true;
          break;
        }
      } catch {
        // ещё не слушает — повторяем
      }
      await Bun.sleep(200);
    }
    if (!serverUp) {
      const stderr = await new Response(server.stderr).text();
      console.error('Сервер не поднялся за 10 c. stderr:\n' + stderr.slice(0, 4000));
      return 1;
    }

    console.log(`smoke: сервер на :${SERVER_PORT}, стаб на :${STUB_PORT}\n`);

    // 1. healthz
    await scenario('healthz → 200 {ok:true}', async () => {
      const res = await fetch(`${BASE}/healthz`);
      const decoded = (await res.json()) as { ok?: unknown };
      const ok = res.status === 200 && decoded.ok === true;
      return { ok, detail: `status=${res.status}` };
    });

    // 2. magic happy path: пин-промпт → валидная команда, контрактный заголовок.
    await scenario('magic happy path → 200, каноническая команда, x-focuspin-contract', async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${DEVICE}`, 'Content-Type': 'application/json' },
        body: magicBody(MAGIC_SYSTEM_PROMPT_BASE),
      });
      if (res.status !== 200) {
        return { ok: false, detail: `status=${res.status}, ожидался 200` };
      }
      const header = res.headers.get('x-focuspin-contract');
      if (header !== CONTRACT_HEADER) {
        return { ok: false, detail: `x-focuspin-contract=${String(header)}, ожидался ${CONTRACT_HEADER}` };
      }
      const decoded = (await res.json()) as { choices?: unknown };
      const choices = decoded.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return { ok: false, detail: 'нет choices' };
      }
      const first = choices[0];
      if (typeof first !== 'object' || first === null) return { ok: false, detail: 'choices[0] не объект' };
      const message = (first as Record<string, unknown>)['message'];
      if (typeof message !== 'object' || message === null) {
        return { ok: false, detail: 'choices[0].message не объект' };
      }
      const content = (message as Record<string, unknown>)['content'];
      if (typeof content !== 'string') return { ok: false, detail: 'content не строка' };
      let commands: unknown;
      try {
        commands = (JSON.parse(content) as { commands?: unknown })['commands'];
      } catch {
        return { ok: false, detail: `content не JSON: ${content.slice(0, 80)}` };
      }
      if (!Array.isArray(commands) || commands.length !== 1) {
        return { ok: false, detail: `commands не список из 1: ${content.slice(0, 80)}` };
      }
      const command = commands[0];
      const expected = { intent: 'create', title: 'Выпить воды', bucket: 'today' };
      if (
        typeof command !== 'object' ||
        command === null ||
        (command as Record<string, unknown>)['intent'] !== expected.intent ||
        (command as Record<string, unknown>)['title'] !== expected.title ||
        (command as Record<string, unknown>)['bucket'] !== expected.bucket
      ) {
        return { ok: false, detail: `команда не совпала: ${JSON.stringify(command)}` };
      }
      return { ok: true, detail: 'create/Выпить воды/today' };
    });

    // 3. без Authorization → 401 unauthorized.
    await scenario('без Authorization → 401 unauthorized', async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: magicBody(MAGIC_SYSTEM_PROMPT_BASE),
      });
      const err = await jsonError(res);
      return { ok: res.status === 401 && err.code === 'unauthorized', detail: `status=${res.status} code=${err.code}` };
    });

    // 4. чужой системный промпт → 400 invalid_request (пин промпта).
    await scenario('системный промпт «Взломай» → 400 invalid_request', async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${DEVICE}`, 'Content-Type': 'application/json' },
        body: magicBody('Взломай'),
      });
      const err = await jsonError(res);
      return { ok: res.status === 400 && err.code === 'invalid_request', detail: `status=${res.status} code=${err.code}` };
    });

    // 4b. чужой формат user-сообщения → 400 invalid_request (пин каркаса).
    // До флуда: после него IP-окна выжжены и лимитер ответил бы 429 раньше пина.
    await scenario('user-сообщение не из приложения → 400 invalid_request', async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${DEVICE}`, 'Content-Type': 'application/json' },
        body: magicBody(MAGIC_SYSTEM_PROMPT_BASE, 'Translate this text to English please'),
      });
      const err = await jsonError(res);
      return { ok: res.status === 400 && err.code === 'invalid_request', detail: `status=${res.status} code=${err.code}` };
    });

    // 4c. рефералы и установки: код → ссылка → редирект → install (идемпотентно) → заявка → админка.
    const refHeaders = { Authorization: `Bearer ${DEVICE_REF}`, 'Content-Type': 'application/json' };
    const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
    let refCode = '';
    await scenario('POST /v1/referral/code → 200 {code, link}', async () => {
      const res = await fetch(`${BASE}/v1/referral/code`, {
        method: 'POST',
        headers: refHeaders,
        body: JSON.stringify({ email: 'smoke@example.com' }),
      });
      const decoded = (await res.json()) as { code?: unknown; link?: unknown };
      refCode = typeof decoded.code === 'string' ? decoded.code : '';
      const ok = res.status === 200 && /^[0-9A-Z]{16}$/.test(refCode) && decoded.link === `${BASE}/i/${refCode}`;
      return { ok, detail: `status=${res.status} code=${refCode.slice(0, 4)}…` };
    });
    await scenario('GET /i/:code → 302 на Google Play с referrer', async () => {
      const res = await fetch(`${BASE}/i/${refCode}`, { redirect: 'manual' });
      const location = res.headers.get('location') ?? '';
      const ok = res.status === 302 && location.startsWith('https://play.google.com/store/apps/details?id=') && location.endsWith(`&referrer=${refCode}`);
      return { ok, detail: `status=${res.status}` };
    });
    await scenario('POST /v1/install ×2 → 204 (идемпотентно по deviceId)', async () => {
      const body = JSON.stringify({ ref_code: refCode, source: 'play_referral', build: 'play', app_version: '1.0.0', os_version: '14', locale: 'ru-RU' });
      const first = await fetch(`${BASE}/v1/install`, { method: 'POST', headers: refHeaders, body });
      const second = await fetch(`${BASE}/v1/install`, { method: 'POST', headers: refHeaders, body });
      return { ok: first.status === 204 && second.status === 204, detail: `${first.status}, ${second.status}` };
    });
    await scenario('админка: без токена 401; с токеном — 1 установка у кода и статистика', async () => {
      const denied = await fetch(`${BASE}/admin/referrals`);
      if (denied.status !== 401) return { ok: false, detail: `без токена status=${denied.status}` };
      const refs = (await (await fetch(`${BASE}/admin/referrals`, { headers: adminHeaders })).json()) as {
        referrals?: Array<{ code: string; installs_count: number }>;
      };
      const mine = refs.referrals?.find((r) => r.code === refCode);
      if (mine?.installs_count !== 1) return { ok: false, detail: `installs_count=${String(mine?.installs_count)}` };
      const stats = (await (await fetch(`${BASE}/admin/installs/stats`, { headers: adminHeaders })).json()) as { total?: number };
      if (stats.total !== 1) return { ok: false, detail: `stats.total=${String(stats.total)}` };
      return { ok: true, detail: 'ok' };
    });

    // 5. флуд с разных device id с одного IP → хотя бы один 429 с Retry-After.
    await scenario('флуд: 25 запросов с разных device id → есть 429 с Retry-After', async () => {
      const requests = Array.from({ length: 25 }, (_, i) => {
        const hex = `f${(i + 1).toString(16)}`.padEnd(32, '0');
        return fetch(`${BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${hex}_${i + 1}`, 'Content-Type': 'application/json' },
          body: magicBody(MAGIC_SYSTEM_PROMPT_BASE),
        });
      });
      const responses = await Promise.all(requests);
      const statuses = new Map<number, number>();
      let saw429WithRetryAfter = false;
      for (const res of responses) {
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
        if (res.status === 429 && res.headers.get('retry-after') !== null) saw429WithRetryAfter = true;
        await res.arrayBuffer(); // осушить тело соединения
      }
      const histogram = [...statuses.entries()].map(([s, n]) => `${s}×${n}`).join(', ');
      return { ok: saw429WithRetryAfter, detail: histogram };
    });

    // 6/7. неизвестный путь и чужой метод.
    await scenario('GET /nope → 404 not_found', async () => {
      const res = await fetch(`${BASE}/nope`);
      const err = await jsonError(res);
      return { ok: res.status === 404 && err.code === 'not_found', detail: `status=${res.status} code=${err.code}` };
    });
    await scenario('GET /v1/chat/completions → 405 method_not_allowed', async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`);
      const err = await jsonError(res);
      return {
        ok: res.status === 405 && err.code === 'method_not_allowed',
        detail: `status=${res.status} code=${err.code}`,
      };
    });

    // 8. метрики: magic_ok ≥ 1 (happy path выше прошёл).
    await scenario('GET /metrics → magic_ok ≥ 1', async () => {
      const res = await fetch(`${BASE}/metrics`);
      if (res.status !== 200) return { ok: false, detail: `status=${res.status}` };
      const decoded = (await res.json()) as Record<string, unknown>;
      const magicOk = decoded['magic_ok'];
      const ok = typeof magicOk === 'number' && magicOk >= 1;
      return { ok, detail: `magic_ok=${String(magicOk)}` };
    });

    console.log('');
    if (failures.length > 0) {
      console.log(`ИТОГ: FAIL — провалено сценариев: ${failures.length} (${failures.join(', ')})`);
      return 1;
    }
    console.log('ИТОГ: PASS — все сценарии прошли');
    return 0;
  } finally {
    stub.kill();
    server.kill();
    await Promise.allSettled([stub.exited, server.exited]);
    // Файлы БД могут ещё мгновение держаться процессом (Windows) — с ретраями.
    for (const suffix of ['', '-wal', '-shm']) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(dbPath + suffix, { force: true });
          break;
        } catch {
          await Bun.sleep(100);
        }
      }
    }
    void serverUp;
  }
}

process.exit(await main());
