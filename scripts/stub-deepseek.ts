// scripts/stub-deepseek.ts — локальный стаб DeepSeek для разработки и smoke-проверок.
// Запуск: bun run scripts/stub-deepseek.ts  (STUB_PORT=8901, STUB_MODE=valid|garbage|slow)

const PORT = Number(process.env['STUB_PORT'] ?? '8901');
const MODE = (process.env['STUB_MODE'] ?? 'valid').trim().toLowerCase();

// Заготовки ответа: валидная команда и мусор вместо JSON.
const CANNED_VALID = '{"commands":[{"intent":"create","title":"Выпить воды","bucket":"today"}]}';
const CANNED_GARBAGE = 'Привет! Я не JSON.';

function cannedContent(): string {
  return MODE === 'garbage' ? CANNED_GARBAGE : CANNED_VALID;
}

const server = Bun.serve({
  port: PORT,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
      return Response.json({ ok: true });
    }

    // Эмулируем только продуктовый путь upstream; авторизацию игнорируем.
    const isChat =
      request.method === 'POST' &&
      (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions');
    if (!isChat) {
      return Response.json({ error: { code: 'not_found', message: 'unknown path' } }, { status: 404 });
    }

    let model = 'deepseek-flash';
    try {
      const body = (await request.json()) as { model?: unknown };
      if (typeof body['model'] === 'string' && body['model'] !== '') model = body['model'];
    } catch {
      // Битое тело — стаб всё равно отвечает (это не его забота).
    }

    if (MODE === 'slow') await Bun.sleep(5000);

    return Response.json({
      id: `chatcmpl-stub-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: cannedContent() }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    });
  },
});

console.log(`stub-deepseek: режим=${MODE} порт=${server.port} — готов`);
