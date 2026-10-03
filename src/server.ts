import { handleRequest } from './api/router.ts';
import { errorBody, toErrorResponse } from './errors.ts';
import type { AppDeps, RequestContext } from './types.ts';

export interface AppServer {
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

export function createApp(deps: AppDeps): AppServer {
  const server = Bun.serve({
    port: deps.config.port,
    idleTimeout: 30,
    maxRequestBodySize: deps.config.maxBodyBytes,
    async fetch(request, server): Promise<Response> {
      const startedAtMs = performance.now();
      const requestId = crypto.randomUUID().slice(0, 8);
      const url = new URL(request.url);
      const clientIp = server.requestIP(request)?.address ?? '';
      let status = 500;
      try {
        const response = await dispatch(request, url, deps, { requestId, clientIp });
        status = response.status;
        return response;
      } catch (err) {
        const response = toErrorResponse(err, deps.log);
        status = response.status;
        return response;
      } finally {
        const elapsedMs = performance.now() - startedAtMs;
        deps.state.observeLatency('request_ms', elapsedMs);
        deps.log.info('request', {
          requestId,
          method: request.method,
          path: url.pathname,
          status,
          ms: Math.round(elapsedMs),
        });
      }
    },
  });
  return {
    port: server.port ?? deps.config.port,
    stop(closeActiveConnections = false) {
      server.stop(closeActiveConnections);
    },
  };
}

async function dispatch(
  request: Request,
  url: URL,
  deps: AppDeps,
  ctx: RequestContext,
): Promise<Response> {
  if (url.pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
    return Response.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
  }
  if (url.pathname === '/metrics' && request.method === 'GET') {
    return Response.json(deps.state.snapshot());
  }
  return (await handleRequest(request, url, deps, ctx)) ?? notFoundResponse();
}

export function notFoundResponse(): Response {
  return Response.json(errorBody('not_found', 'Неизвестный путь.'), { status: 404 });
}
