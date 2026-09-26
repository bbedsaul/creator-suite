/**
 * The contract version this package implements, tracking
 * docs/social-poster-internal-api-contract.md (D-027).
 *
 * 1.2 (S03): error envelopes gained `request_id`; GET /v1/auth/context added.
 * 1.3 (S04): GET /v1/platforms/constraints and POST /v1/posts/validate added,
 *            plus the `media_required` and `text_invalid_characters` constraint
 *            codes. All additive under contract §10 (D-056, D-057).
 */
export const CONTRACT_VERSION = '1.3' as const;
export type ContractVersion = typeof CONTRACT_VERSION;
