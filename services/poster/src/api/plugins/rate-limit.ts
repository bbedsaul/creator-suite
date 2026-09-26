/**
 * Per-app rate limiting (contract §2.1).
 *
 * Two different limits, because they defend different things:
 *   * authenticated routes are limited per app, using the app's own
 *     `rate_limit_per_min` column — platform limits are data, and so are ours;
 *   * the token endpoint is limited per client_id + IP, because it is the only
 *     unauthenticated route and therefore the brute-force surface for a
 *     client_secret (D-047).
 */
import type { FastifyRequest } from 'fastify';
import type { RateLimiter } from '@suite/server-core';
import { ApiError } from '../errors.js';

export function enforceAppLimit(
  limiter: RateLimiter,
  _request: FastifyRequest,
  app: { id: string; rateLimitPerMin: number },
): void {
  const verdict = limiter.consume(`app:${app.id}`, app.rateLimitPerMin);
  if (!verdict.allowed) throw ApiError.rateLimited(verdict.retryAfterSeconds);
}

export function enforceTokenEndpointLimit(
  limiter: RateLimiter,
  request: FastifyRequest,
  clientId: string,
  limitPerMin: number,
): void {
  // Both parts matter: the IP alone punishes a shared NAT, the client_id alone
  // lets an attacker rotate ids to get a fresh bucket each time.
  const key = `token:${clientId}:${request.ip}`;
  const verdict = limiter.consume(key, limitPerMin);
  if (!verdict.allowed) throw ApiError.rateLimited(verdict.retryAfterSeconds);
}
