import type { Config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { deriveIdentity } from '../identity/device.ts';
import type { MagicOutput } from '../llm/pipeline.ts';
import type { RateVerdict } from '../limiter/limiter.ts';
import type { AppDeps, RequestContext } from '../types.ts';
import { authenticate, resolveClientIp } from './common.ts';
import { handleAdminRequest } from './admin.ts';
import { handleReferralRequest } from './referral.ts';

/** The only production route; everything else returns undefined -> server's 404. */
const MAGIC_PATH = '/v1/chat/completions';
const CONTRACT_HEADER = 'commands-v4';

// User-facing strings (Russian).
const RATE_LIMITED_MESSAGE = 'Лимит бесплатного сервера исчерпан — попробуйте позже.';
const BUSY_MESSAGE = 'Сервер занят, попробуйте ещё раз через пару секунд.';
const BODY_NOT_OBJECT_MESSAGE = 'Тело запроса должно быть JSON-объектом.';
const TWO_MESSAGES_MESSAGE = 'Ровно два сообщения: system и user.';
const MESSAGE_SHAPE_MESSAGE = 'Каждое сообщение должно быть объектом с role и непустым content.';

/**
 * Роутер API. Реферальные пути (/v1/referral/code, /v1/install, /v1/post-claim, /i/:code —
 * см. api/referral.ts) и админку (/admin/*, api/admin.ts) отдаёт соответствующим модулям. Обрабатывает POST /v1/chat/completions;
 * всё остальное возвращает undefined — server.ts отдаст 404. Порядок magic-запроса: 405 -> global inflight ->
 * auth (Bearer deviceId) -> client ip -> парсинг и структурная валидация тела ->
 * limiter.beginRequest -> pipeline.run (при contract_violation роутер сам зовёт
 * limiter.recordContractFail) -> recordSuccess -> OpenAI-совместимый ответ с
 * каноническим content и RateLimit-заголовками.
 */
export async function handleRequest(
  request: Request,
  url: URL,
  deps: AppDeps,
  ctx: RequestContext,
): Promise<Response | undefined> {
  const referral = await handleReferralRequest(request, url, deps, ctx);
  if (referral !== undefined) return referral;
  const admin = await handleAdminRequest(request, url, deps);
  if (admin !== undefined) return admin;
  if (url.pathname !== MAGIC_PATH) return undefined;
  const startedAtMs = performance.now();

  if (request.method !== 'POST') {
    deps.state.inc('http_405');
    throw new HttpError('method_not_allowed', 'Метод не поддерживается.');
  }

  // Global inflight guard before any heavy work (body read, sqlite, upstream).
  if (deps.state.inflight >= deps.config.globalMaxInflight) {
    deps.state.inc('inflight_rejected');
    deps.state.inc('http_429');
    throw new HttpError('busy', BUSY_MESSAGE, { retryAfterSeconds: 2 });
  }
  deps.state.inflight += 1;
  try {
    const response = await handleMagic(request, deps, ctx);
    deps.state.inc('http_200');
    return response;
  } catch (error) {
    if (error instanceof HttpError) deps.state.inc(`http_${error.status}`);
    throw error;
  } finally {
    deps.state.inflight -= 1;
    deps.state.observeLatency('magic_api_ms', performance.now() - startedAtMs);
  }
}

async function handleMagic(request: Request, deps: AppDeps, ctx: RequestContext): Promise<Response> {
  const deviceId = authenticate(request, deps);
  const ip = resolveClientIp(deps.config.trustProxy, request.headers.get('x-forwarded-for'), ctx.clientIp);
  const identity = deriveIdentity(deps.config.hmacSecret, deviceId, ip);
  const body = await readAndValidateBody(request, deps.config);

  const verdict = deps.limiter.beginRequest(identity);
  if (!verdict.allowed) {
    throw new HttpError('rate_limited', RATE_LIMITED_MESSAGE, { retryAfterSeconds: verdict.retryAfterSeconds });
  }

  let output: MagicOutput;
  try {
    output = await deps.pipeline.run({
      messages: [
        { role: 'system', content: body.systemContent },
        { role: 'user', content: body.userContent },
      ],
      identity,
      requestedModel: body.requestedModel,
    });
  } catch (error) {
    // The pipeline does not know the limiter: the anti-abuse counter is recorded here.
    if (error instanceof HttpError && error.code === 'contract_violation') {
      deps.limiter.recordContractFail(identity);
    }
    throw error;
  }

  deps.limiter.recordSuccess(identity, output.promptTokens, output.completionTokens);
  deps.state.inc('magic_ok');
  return magicResponse(output, body.requestedModel, verdict, deps.config);
}

interface MagicBody {
  requestedModel: string;
  systemContent: string;
  userContent: string;
}

interface MessageParts {
  role: string;
  content: string;
}

async function readAndValidateBody(request: Request, config: Config): Promise<MagicBody> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw new HttpError('invalid_request', 'Не удалось прочитать тело запроса.');
  }
  if (new TextEncoder().encode(raw).byteLength > config.maxBodyBytes) {
    throw new HttpError('payload_too_large', 'Тело запроса слишком большое.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new HttpError('invalid_request', BODY_NOT_OBJECT_MESSAGE);
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new HttpError('invalid_request', BODY_NOT_OBJECT_MESSAGE);
  }
  const body = decoded as Record<string, unknown>;

  if (body['stream'] === true) {
    throw new HttpError('invalid_request', 'Потоковая передача не поддерживается.');
  }
  const modelValue = body['model'];
  if (modelValue !== undefined && typeof modelValue !== 'string') {
    throw new HttpError('invalid_request', 'Поле model должно быть строкой.');
  }
  const requestedModel = modelValue === undefined ? '' : modelValue;
  // Эхо-поле: ограничиваем, чтобы раздутый model не раздувал ответ и логи.
  if (requestedModel.length > 128) {
    throw new HttpError('invalid_request', 'Поле model слишком длинное.');
  }

  // Unknown top-level keys are allowed (OpenAI clients send extra fields) and ignored.
  const messages = body['messages'];
  if (!Array.isArray(messages) || messages.length !== 2) {
    throw new HttpError('invalid_request', TWO_MESSAGES_MESSAGE);
  }
  const system = asMessage(at(messages, 0));
  const user = asMessage(at(messages, 1));
  if (system === null || user === null || system.role !== 'system' || user.role !== 'user') {
    throw new HttpError('invalid_request', TWO_MESSAGES_MESSAGE);
  }
  if (system.content.length > config.maxSystemChars) {
    throw new HttpError('payload_too_large', 'Системное сообщение слишком большое.');
  }
  if (user.content.length > config.maxUserChars) {
    throw new HttpError('payload_too_large', 'Сообщение пользователя слишком большое.');
  }
  return { requestedModel, systemContent: system.content, userContent: user.content };
}

/** Only { role, content } message objects with a non-empty string content pass. */
function asMessage(value: unknown): MessageParts | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const role = record['role'];
  const content = record['content'];
  if (typeof role !== 'string' || typeof content !== 'string' || content.length === 0) return null;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('role') || !keys.includes('content')) return null;
  return { role, content };
}

/** Array element without undefined (noUncheckedIndexedAccess). */
function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`missing item at index ${index}`);
  return value;
}

/** OpenAI chat.completion shape with canonical contract content and device-day rate headers. */
function magicResponse(output: MagicOutput, requestedModel: string, verdict: RateVerdict, config: Config): Response {
  return Response.json(
    {
      id: `chatcmpl-${randomHex(12)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel !== '' ? requestedModel : config.upstreamModel,
      choices: [{ index: 0, message: { role: 'assistant', content: output.canonicalContent }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: output.promptTokens,
        completion_tokens: output.completionTokens,
        total_tokens: output.promptTokens + output.completionTokens,
      },
    },
    {
      headers: {
        'ratelimit-limit': String(verdict.deviceDayLimit),
        'ratelimit-remaining': String(verdict.deviceDayRemaining),
        'ratelimit-reset': String(verdict.deviceDayResetSeconds),
        'x-focuspin-contract': CONTRACT_HEADER,
      },
    },
  );
}

/** N random hex chars for the completion id. */
function randomHex(chars: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(chars / 2)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, chars);
}
