#!/usr/bin/env node
/**
 * Regenerates services/poster/src/db/database.types.ts from the LOCAL database.
 *
 *   pnpm -F @suite/poster-service gen:types
 *
 * Run it after every migration. The output is generated: never hand-edit it
 * (CLAUDE.md rule 13 applies to generated files generally). The Supabase CLI
 * emits unformatted TypeScript, so this formats it with the repo's Prettier
 * config — otherwise `pnpm format:check` fails the moment types are regenerated.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(serviceRoot, '..', '..');
const outFile = join(serviceRoot, 'src', 'db', 'database.types.ts');

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: supabase/migrations/*.sql
 * Regenerate:     pnpm -F @suite/poster-service gen:types
 *                 (requires a running local stack: pnpm exec supabase start)
 *
 * Only the \`poster\` schema is generated. The service reads and writes Postgres
 * directly as service_role through postgres.js (D-019), so these types exist to
 * keep query results honest — they are not a PostgREST client surface, and no
 * browser ever sees them (D-024).
 */
`;

const gen = spawnSync(
  'pnpm',
  ['exec', 'supabase', 'gen', 'types', 'typescript', '--local', '--schema', 'poster'],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

if (gen.status !== 0 || !gen.stdout.includes('export type Database')) {
  console.error('supabase gen types failed.');
  console.error(gen.stderr || gen.stdout);
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${HEADER}\n${gen.stdout.trimStart()}`, 'utf8');

const fmt = spawnSync('pnpm', ['exec', 'prettier', '--write', outFile], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (fmt.status !== 0) {
  console.error('prettier failed on the generated types.');
  console.error(fmt.stderr || fmt.stdout);
  process.exit(1);
}

console.log(`wrote ${outFile.replace(`${repoRoot}/`, '')}`);
