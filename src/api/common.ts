import { HttpError } from '../errors.ts';
import { validateFocuspinDeviceId } from '../identity/device.ts';
import type { AppDeps } from '../types.ts';

/** Общие для всех публичных путей API куски: Bearer-авторизация устройства и клиентский IP. */

export const BEARER_PREFIX = 'Bearer ';
const UNAUTHORIZED_MESSAGE = 'Требуется заголовок Authorization: Bearer с идентификатором устройства.';

/** Scheme "Bearer " is case-sensitive; the rest must be a valid focuspin device id. */
export function authenticate(request: Request, deps: AppDeps): string {
  const header = request.headers.get('authorization') ?? '';
  const deviceId = validateFocuspinDeviceId(header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '');
  if (deviceId === null) {
    deps.state.inc('auth_fail');
    throw new HttpError('unauthorized', UNAUTHORIZED_MESSAGE);
  }
  return deviceId;
}

/** Behind our own reverse proxy the client ip is the last XFF entry; otherwise the socket ip. */
export function resolveClientIp(trustProxy: boolean, forwardedFor: string | null, socketIp: string): string {
  if (trustProxy) {
    const header = forwardedFor?.trim() ?? '';
    if (header !== '') {
      const entries = header.split(',');
      const last = entries[entries.length - 1]?.trim() ?? '';
      if (last !== '') return last;
    }
  }
  return socketIp !== '' ? socketIp : 'unknown';
}
