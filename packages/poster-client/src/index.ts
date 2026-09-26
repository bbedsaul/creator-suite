/**
 * @suite/poster-client — the only way anything talks to the Poster API
 * (D-022, D-026): apps/*, services/clipper, services/trainer, and the M1 demo
 * script all go through this SDK.
 *
 * S01 placeholder. From S03 on, this file is emitted by
 * `pnpm -F @suite/poster-contract gen` from the OpenAPI spec and must not be
 * hand-edited (CLAUDE.md rule 13).
 */
export const CLIENT_GENERATED = false as const;

/** Contract version this client is generated against, once it is generated. */
export const TARGET_CONTRACT_VERSION = '1.1' as const;
