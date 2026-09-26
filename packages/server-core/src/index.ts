/**
 * @suite/server-core — backend-only shared code (D-022).
 *
 * Auth verification (S03), tenancy, and billing primitives land here as the
 * milestones reach them. Nothing in this package may import packages/ui or any
 * app; `pnpm lint:deps` enforces that.
 */
export { requireEnv, optionalEnv, intEnv } from './env.js';
