/**
 * The contract version this package implements, tracking
 * docs/social-poster-internal-api-contract.md (D-027).
 *
 * Bumped to 1.2 in S03: the error envelope gained `request_id` and
 * GET /v1/auth/context was added. Both are additive under contract §10 (D-044).
 */
export const CONTRACT_VERSION = '1.2' as const;
export type ContractVersion = typeof CONTRACT_VERSION;
