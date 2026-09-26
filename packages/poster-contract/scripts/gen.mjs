#!/usr/bin/env node
/**
 * Generates the OpenAPI spec from the zod schemas in src/, then the typed
 * client in packages/poster-client (D-026).
 *
 * Not implemented in S01: S01 only bootstraps the workspace. The schemas this
 * reads do not exist until S03 (auth + error envelope), so this exits non-zero
 * rather than emitting an empty spec that later looks generated.
 */
console.error(
  '@suite/poster-contract gen: not implemented until S03.\n' +
    'S03 adds the auth and error schemas, this script emits openapi.json from them,\n' +
    'and packages/poster-client is generated from that spec. See docs/poster-m1-session-plan.md.',
);
process.exit(1);
