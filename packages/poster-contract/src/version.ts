/**
 * The contract version this package implements, tracking
 * docs/social-poster-internal-api-contract.md (D-027).
 *
 * 1.2 (S03): error envelopes gained `request_id`; GET /v1/auth/context added.
 * 1.3 (S04): platform constraints published; POST /v1/posts/validate added.
 * 1.4 (S05): media upload, post submission, cancel, patch and read specified;
 *            `media_not_ready` constraint code added.
 * 1.5 (S08): webhook envelope and per-type payloads specified as schemas; `gr_`
 *            prefix registered for grants. Additive under §10.
 * 1.6 (S10): `user_id` declared as a query parameter on GET, PATCH and cancel for
 *            /v1/posts/{post_id}. Documents a parameter the service already
 *            accepted but the spec never declared, which left those three routes
 *            unreachable from the generated client in app mode (D-096). Additive:
 *            no runtime behaviour changed.
 */
export const CONTRACT_VERSION = '1.6' as const;
export type ContractVersion = typeof CONTRACT_VERSION;
