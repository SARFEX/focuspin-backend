import type { AppDeps, RequestContext } from '../types.ts';

/**
 * Роутер API. Обрабатывает POST /v1/chat/completions (единственный продуктовый путь);
 * всё остальное возвращает undefined — server.ts отдаст 404.
 * Порядок обработки magic-запроса: global inflight -> auth (Bearer deviceId) -> парсинг
 * и структурная валидация тела -> limiter.beginRequest -> pipeline.run -> recordSuccess ->
 * OpenAI-формат ответа с каноническим content и RateLimit-заголовками.
 */
export async function handleRequest(
  _request: Request,
  _url: URL,
  _deps: AppDeps,
  _ctx: RequestContext,
): Promise<Response | undefined> {
  return undefined;
}
