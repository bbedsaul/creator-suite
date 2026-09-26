#!/usr/bin/env node
/**
 * Fails when a committed generated file is not what its generator would produce.
 *
 *   node scripts/check-generated.mjs contract    # OpenAPI spec + client types
 *   node scripts/check-generated.mjs db-types    # poster database types (needs a live db)
 *
 * Deliberately a snapshot comparison rather than `git diff --exit-code`: that
 * would conflate "the generator disagrees with the file" — the thing we care
 * about — with "you have uncommitted work", which is none of its business and
 * makes the check useless to run locally.
 *
 * On failure the regenerated file is left in place, so the fix is to review and
 * commit it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = {
  contract: {
    description: 'OpenAPI spec and generated client types',
    command: ['pnpm', ['-F', '@suite/poster-contract', 'gen']],
    files: ['packages/poster-contract/openapi.json', 'packages/poster-client/src/schema.ts'],
    fix: 'pnpm -F @suite/poster-contract gen',
  },
  'db-types': {
    description: 'poster schema TypeScript types',
    command: ['pnpm', ['-F', '@suite/poster-service', 'gen:types']],
    files: ['services/poster/src/db/database.types.ts'],
    fix: 'pnpm -F @suite/poster-service gen:types (requires pnpm exec supabase start)',
  },
};

const name = process.argv[2];
const target = TARGETS[name];
if (target === undefined) {
  console.error(
    `Unknown target "${String(name)}". Expected one of: ${Object.keys(TARGETS).join(', ')}`,
  );
  process.exit(2);
}

function read(relative) {
  try {
    return readFileSync(join(repoRoot, relative), 'utf8');
  } catch {
    return undefined;
  }
}

const before = new Map(target.files.map((file) => [file, read(file)]));

const [command, args] = target.command;
const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
if (result.status !== 0) {
  console.error(`Generator failed for ${name}:`);
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

const stale = target.files.filter((file) => read(file) !== before.get(file));

if (stale.length > 0) {
  console.error(`${target.description}: out of date.\n`);
  for (const file of stale) console.error(`  stale: ${file}`);
  console.error(`\nThe files have been regenerated in place. Review and commit them.`);
  console.error(`Regenerate manually with: ${target.fix}`);
  process.exit(1);
}

console.log(`${target.description}: up to date (${target.files.length} file(s) checked)`);
