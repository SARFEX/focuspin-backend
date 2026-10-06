// scripts/load.ts — простой генератор нагрузки без зависимостей (Bun globals + performance.now).
// Запуск: bun run scripts/load.ts --url http://127.0.0.1:8080 --duration-sec 30 --rps 20 --devices 50

import { MAGIC_SYSTEM_PROMPT_BASE } from '../src/llm/prompt.ts';

interface LoadArgs {
  url: string;
  durationSec: number;
  rps: number;
  devices: number;
}

function parseArgs(argv: string[]): LoadArgs {
  const args: LoadArgs = { url: 'http://127.0.0.1:8080', durationSec: 30, rps: 20, devices: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || value === undefined) break;
    if (key === '--url') args.url = value;
    else if (key === '--duration-sec') args.durationSec = Number(value) || args.durationSec;
    else if (key === '--rps') args.rps = Number(value) || args.rps;
    else if (key === '--devices') args.devices = Math.max(1, Number(value) || args.devices);
    if (key.startsWith('--')) i += 1;
  }
  // Системный промпт можно переопределить целиком: --system-prompt "..."
  const promptIndex = argv.indexOf('--system-prompt');
  if (promptIndex !== -1 && argv[promptIndex + 1] !== undefined) {
    systemPromptOverride = argv[promptIndex + 1] as string;
  }
  return args;
}

let systemPromptOverride: string | undefined;

const DEVICE_PREFIX = 'a1b2'.repeat(8); // 32 hex-символа, суффикс _<индекс>

/** Device id из пула: a1b2…a1b2_<i>. */
function deviceId(index: number, pool: number): string {
  return `${DEVICE_PREFIX}_${index % pool}`;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1;
  return sorted[rank] ?? 0;
}

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  const systemPrompt = systemPromptOverride ?? MAGIC_SYSTEM_PROMPT_BASE;
  const targetUrl = `${args.url.replace(/\/+$/, '')}/v1/chat/completions`;

  const body = JSON.stringify({
    model: 'deepseek-flash',
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Текущая дата: 2026-10-04 (суббота), 14:05.\n\nТекущие задачи (id для команд бери только отсюда):\n[]\n\nЗапрос пользователя:\n«выпить воды»' },
    ],
  });
  const headers = { Authorization: `Bearer ${deviceId(0, args.devices)}`, 'Content-Type': 'application/json' };

  console.log('Нагрузка: сначала прогрев 1 c...');
  try {
    const probe = await fetch(targetUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(60_000) });
    await probe.arrayBuffer();
    console.log(`  прогрев: статус ${probe.status}`);
  } catch (err) {
    console.error(`Прогрев не удался — сервер недоступен: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  await Bun.sleep(1000);

  // Цикл запуска с фиксированным темпом; ответы собираем, не блокируя темп.
  const intervalMs = 1000 / args.rps;
  const latencies: number[] = [];
  const statuses = new Map<string, number>();
  const pending: Promise<void>[] = [];
  let sent = 0;
  let stopped = false;

  const onSignal = (): void => {
    stopped = true;
  };
  process.on('SIGINT', onSignal);

  const startedAt = performance.now();
  let nextSendAt = startedAt;

  const sendOne = async (index: number): Promise<void> => {
    const requestHeaders = { ...headers, Authorization: `Bearer ${deviceId(index, args.devices)}` };
    const t0 = performance.now();
    try {
      const res = await fetch(targetUrl, { method: 'POST', headers: requestHeaders, body, signal: AbortSignal.timeout(60_000) });
      latencies.push(performance.now() - t0);
      statuses.set(String(res.status), (statuses.get(String(res.status)) ?? 0) + 1);
      await res.arrayBuffer(); // осушить соединение
    } catch {
      statuses.set('ошибка', (statuses.get('ошибка') ?? 0) + 1);
    }
  };

  while (!stopped && performance.now() - startedAt < args.durationSec * 1000) {
    pending.push(sendOne(sent));
    sent += 1;
    nextSendAt += intervalMs;
    const now = performance.now();
    if (nextSendAt > now) await Bun.sleep(nextSendAt - now);
    else nextSendAt = now; // не догоняем пропущенный темп после паузы
  }
  process.off('SIGINT', onSignal);
  await Promise.allSettled(pending);

  const elapsedSec = (performance.now() - startedAt) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const histogram = [...statuses.entries()]
    .map(([status, count]) => `${status}=${count}`)
    .join('  ');

  console.log('\n┌─ Итог нагрузки ────────────────────────────────────────');
  console.log(`│ Цель:            ${targetUrl}`);
  console.log(`│ Отправлено:      ${sent} за ${elapsedSec.toFixed(1)} c`);
  console.log(`│ RPS (достигнуто): ${(sent / elapsedSec).toFixed(1)}  (цель ${args.rps})`);
  console.log(`│ Статусы:         ${histogram}`);
  console.log(`│ Задержка p50:    ${percentile(sorted, 0.5).toFixed(0)} мс`);
  console.log(`│ Задержка p95:    ${percentile(sorted, 0.95).toFixed(0)} мс`);
  console.log('└────────────────────────────────────────────────────────');
  console.log(stopped ? '(остановлено по SIGINT)' : '');
  return 0;
}

process.exit(await main());
