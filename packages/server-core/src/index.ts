/**
 * @suite/server-core — backend-only shared code (D-022).
 *
 * Product-agnostic on purpose: nothing here imports a product's contract, so the
 * Clipper and Trainer services can reuse the same auth, hashing, and limiting
 * primitives. Nothing in this package may import packages/ui or any app;
 * `pnpm lint:deps` enforces that.
 */
export { requireEnv, optionalEnv, intEnv } from './env.js';

export {
  ARGON2_PARAMS,
  hashSecret,
  verifySecret,
  needsRehash,
  type Argon2Params,
} from './secrets.js';

export {
  APP_TOKEN_TTL_SECONDS,
  TokenInvalidError,
  createAppTokenSigner,
  createUserTokenVerifier,
  type AppTokenClaims,
  type AppTokenSigner,
  type AppTokenSignerOptions,
  type UserTokenVerifier,
  type UserTokenVerifierOptions,
} from './jwt.js';

export {
  InMemoryRateLimiter,
  type RateLimiter,
  type RateLimitVerdict,
  type InMemoryRateLimiterOptions,
} from './rate-limit.js';
