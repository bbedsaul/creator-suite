/**
 * @suite/poster-contract — the wire contract as code (D-026, CLAUDE.md rule 13).
 *
 * Every API change starts here: zod schemas in this package generate the
 * OpenAPI spec, which generates @suite/poster-client. The schemas themselves
 * (auth, errors, media, posts, constraints, webhooks) land in S03 and after;
 * S01 only establishes the package and its `gen` entrypoint.
 *
 * The version tracks docs/social-poster-internal-api-contract.md (D-027).
 */
export const CONTRACT_VERSION = '1.1' as const;

export type ContractVersion = typeof CONTRACT_VERSION;
