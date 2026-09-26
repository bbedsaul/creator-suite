/**
 * Puts a request id on every response.
 *
 * Fastify is configured to adopt an inbound `X-Request-Id` when a caller sends
 * one, so a client's own correlation id survives into our logs; otherwise it
 * generates one. Either way the value is echoed back in the header and in every
 * error envelope (D-044), so "quote the request id" is a complete instruction.
 */
import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    if (!reply.hasHeader(REQUEST_ID_HEADER)) {
      void reply.header(REQUEST_ID_HEADER, request.id);
    }
    done(null, payload);
  });
}
