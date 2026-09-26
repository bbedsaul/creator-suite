/**
 * Registers the error and not-found handlers.
 *
 * Two rules this enforces that are easy to lose track of later:
 *   * every failure carries a request_id, so a report can be traced (D-044);
 *   * an unexpected throw becomes a generic internal_error and the cause is
 *     logged, never serialised — an error message must not leak a token, a
 *     connection string, or a platform response (rule 5).
 */
import type { FastifyInstance } from 'fastify';
import { ApiError, RateLimitedError, toErrorBody } from '../errors.js';

/** Fastify decorates its own errors with `statusCode`; anything else is a 500. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const error = ApiError.notFound(`No route for ${request.method} ${request.url}`);
    void reply.code(error.status).send(toErrorBody(error, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RateLimitedError) {
      request.log.info({ code: error.code }, 'request rate limited');
      void reply
        .code(error.status)
        .header('retry-after', String(error.retryAfterSeconds))
        .send(toErrorBody(error, request.id));
      return;
    }

    if (error instanceof ApiError) {
      // Client mistakes are not warnings; only 5xx deserves noise.
      const level = error.status >= 500 ? 'error' : 'info';
      request.log[level]({ code: error.code }, error.message);
      void reply.code(error.status).send(toErrorBody(error, request.id));
      return;
    }

    // Fastify's own body parse and schema failures arrive as 4xx with a code.
    const status = httpStatusOf(error) ?? 500;
    if (status >= 400 && status < 500) {
      const wrapped = ApiError.invalidRequest(
        error instanceof Error ? error.message : 'Malformed request',
      );
      request.log.info({ code: wrapped.code }, wrapped.message);
      void reply.code(wrapped.status).send(toErrorBody(wrapped, request.id));
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    const internal = new ApiError('internal_error', 'An unexpected error occurred');
    void reply.code(internal.status).send(toErrorBody(internal, request.id));
  });
}
