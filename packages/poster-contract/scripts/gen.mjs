#!/usr/bin/env node
/**
 * Generates the OpenAPI spec from the zod schemas, then regenerates the typed
 * client from that spec (D-026).
 *
 *   pnpm -F @suite/poster-contract gen
 *
 * Order matters and is the whole point of the contract-change workflow: schemas
 * -> spec -> client. Nothing downstream is hand-edited. Run it after any schema
 * change, and commit the spec and client output alongside the schema change.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(contractRoot, '..', '..');
const clientRoot = join(repoRoot, 'packages', 'poster-client');
const specPath = join(contractRoot, 'openapi.json');
// schema.ts, not schema.d.ts: tsc does not copy a hand-placed .d.ts from src
// into dist, so a declaration-only file would leave dist/index.d.ts importing a
// './schema.js' that does not exist and break every consumer of the built
// package. As a .ts file it emits an (empty) dist/schema.js plus its .d.ts.
const clientTypes = join(clientRoot, 'src', 'schema.ts');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed:`);
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  return result.stdout;
}

// The spec is built from compiled output so the generator uses exactly the code
// the service will import, not a separately transpiled copy.
run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], contractRoot);

const { buildOpenApiDocument } = await import(join(contractRoot, 'dist', 'openapi.js'));
const document = buildOpenApiDocument();

writeFileSync(specPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`wrote ${specPath.replace(`${repoRoot}/`, '')}`);

mkdirSync(dirname(clientTypes), { recursive: true });
const types = run('pnpm', ['exec', 'openapi-typescript', specPath, '--root-types'], contractRoot);

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: packages/poster-contract/src/*.ts (zod schemas)
 * Regenerate:     pnpm -F @suite/poster-contract gen
 *
 * Emitted by openapi-typescript from packages/poster-contract/openapi.json.
 */
`;
writeFileSync(clientTypes, `${HEADER}\n${types.trimStart()}`, 'utf8');
console.log(`wrote ${clientTypes.replace(`${repoRoot}/`, '')}`);

run('pnpm', ['exec', 'prettier', '--write', specPath, clientTypes], repoRoot);
console.log('formatted spec and client types');
