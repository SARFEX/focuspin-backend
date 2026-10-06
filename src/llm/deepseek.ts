import type { Config } from '../config.ts';
import type { UpstreamClient, UpstreamMessage, UpstreamResult } from './pipeline.ts';

/**
 * Нормализация base URL до URI chat/completions — та же логика суффикса,
 * что и в клиенте приложения (lib/magic_input/llm_chat_client.dart):
 * trim, срез хвостовых «/», затем /chat/completions | /v1/chat/completions.
 */
export function resolveChatCompletionsUri(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('/chat/completions')) return trimmed;
  if (lower.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

interface ChatCompletionsResponse {
  choices?: unknown;
  usage?: unknown;
}

/** Извлечение choices[0].message.content — null при любой деформации формы. */
function extractContent(decoded: unknown): string | null {
  if (typeof decoded !== 'object' || decoded === null) return null;
  const choices = (decoded as ChatCompletionsResponse)['choices'];
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : null;
}

/** usage.prompt_tokens / completion_tokens — 0 по умолчанию, как в клиенте приложения. */
function extractUsage(decoded: unknown): { promptTokens: number; completionTokens: number } {
  if (typeof decoded !== 'object' || decoded === null) return { promptTokens: 0, completionTokens: 0 };
  const usage = (decoded as ChatCompletionsResponse)['usage'];
  if (typeof usage !== 'object' || usage === null) return { promptTokens: 0, completionTokens: 0 };
  const record = usage as Record<string, unknown>;
  const prompt = record['prompt_tokens'];
  const completion = record['completion_tokens'];
  return {
    promptTokens: typeof prompt === 'number' && Number.isFinite(prompt) ? prompt : 0,
    completionTokens: typeof completion === 'number' && Number.isFinite(completion) ? completion : 0,
  };
}

/**
 * HTTP-клиент DeepSeek (OpenAI-совместимый chat/completions). Без ретраев —
 * политика повторов живёт в пайплайне. Никогда не бросает: любая ошибка
 * превращается в UpstreamResult { ok: false }.
 */
export class DeepSeekClient implements UpstreamClient {
  constructor(private readonly config: Config) {}

  async complete(messages: UpstreamMessage[], deadlineMs: number): Promise<UpstreamResult> {
    const remainingMs = deadlineMs - Date.now();
    const timeoutMs = Math.min(this.config.upstreamTimeoutMs, remainingMs);
    if (timeoutMs <= 0) return { ok: false, kind: 'timeout' };

    try {
      const response = await fetch(resolveChatCompletionsUri(this.config.upstreamBaseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.upstreamApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.upstreamModel,
          messages,
          temperature: 0,
          // Потолок генерации: цена запроса детерминирована, «простыня» за счёт ключа невозможна.
          max_tokens: this.config.maxCompletionTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status !== 200) {
        const body = await response.text();
        return { ok: false, kind: 'http', status: response.status, detail: body.slice(0, 200) };
      }

      let decoded: unknown;
      try {
        decoded = await response.json();
      } catch {
        return { ok: false, kind: 'http', status: 200, detail: 'bad response shape' };
      }
      const content = extractContent(decoded);
      if (content === null) return { ok: false, kind: 'http', status: 200, detail: 'bad response shape' };
      const usage = extractUsage(decoded);
      return { ok: true, content, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') return { ok: false, kind: 'timeout' };
      return { ok: false, kind: 'network' };
    }
  }
}
