import type { Logger } from './log.ts';

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'payload_too_large'
  | 'not_found'
  | 'method_not_allowed'
  | 'rate_limited'
  | 'busy'
  | 'upstream_error'
  | 'contract_violation'
  | 'unavailable'
  | 'internal';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  payload_too_large: 413,
  not_found: 404,
  method_not_allowed: 405,
  rate_limited: 429,
  busy: 429,
  upstream_error: 502,
  contract_violation: 502,
  unavailable: 503,
  internal: 500,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, options?: { retryAfterSeconds?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'HttpError';
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code] ?? 500;
  }
}

export function errorBody(code: ErrorCode, message: string): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } };
}

export function toErrorResponse(err: unknown, log: Logger): Response {
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (err.retryAfterSeconds !== undefined) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(err.retryAfterSeconds)));
    }
    return Response.json(errorBody(err.code, err.message), { status: err.status, headers });
  }
  log.error('unhandled error', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  return Response.json(errorBody('internal', 'Внутренняя ошибка сервера.'), { status: 500 });
}
