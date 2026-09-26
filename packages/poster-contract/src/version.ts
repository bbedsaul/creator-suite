/**
 * The contract version this package implements, tracking
 * docs/social-poster-internal-api-contract.md (D-027).
 *
 * 1.2 (S03): error envelopes gained `request_id`; GET /v1/auth/context added.
 * 1.3 (S04): platform constraints published; POST /v1/posts/validate added.
 * 1.4 (S05): media upload, post submission, cancel, patch and read specified;
 *            `media_not_ready` constraint code added. Additive under §10.
 */
export const CONTRACT_VERSION = '1.4' as const;
export type ContractVersion = typeof CONTRACT_VERSION;
