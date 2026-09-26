/**
 * Loads the platform constraint specs from supabase/seed-data into the database.
 *
 *   pnpm -F @suite/poster-service seed:constraints
 *
 * The specs are JSON, not TypeScript, for two reasons: a limit is data (rule 9),
 * and a number living in a .ts file would violate this session's own CI check.
 * Each file carries its own `sources`, so provenance is stored alongside the
 * value and served by the API.
 *
 * Seeding a spec also flips `platforms.enabled` (D-058): a platform with no spec
 * cannot be validated against, so being launched and having a spec are the same
 * condition rather than two that can disagree.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PlatformConstraintSpec,
  type PlatformConstraintSpec as Spec,
} from '@suite/poster-contract';
import { requireEnv } from '@suite/server-core';
import { createPool } from './db/pool.js';

export interface LoadedSpec {
  readonly platformId: string;
  readonly specVersion: number;
  readonly spec: Spec;
}

export function specDirectory(repoRoot: string): string {
  return join(repoRoot, 'supabase', 'seed-data', 'platform-constraints');
}

/** Reads and validates every spec file. Throws on the first malformed one. */
export function readSpecs(directory: string): LoadedSpec[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();

  return files.map((name) => {
    const raw = JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
      platform_id?: unknown;
      spec_version?: unknown;
      spec?: unknown;
    };
    if (typeof raw.platform_id !== 'string' || typeof raw.spec_version !== 'number') {
      throw new Error(`${name}: platform_id and spec_version are required`);
    }
    return {
      platformId: raw.platform_id,
      specVersion: raw.spec_version,
      spec: PlatformConstraintSpec.parse(raw.spec),
    };
  });
}

export async function loadConstraints(databaseUrl: string, specs: LoadedSpec[]): Promise<number> {
  const sql = createPool({ databaseUrl, max: 2 });
  try {
    for (const entry of specs) {
      const platform = await sql<{ id: string }[]>`
        select id from poster.platforms where id = ${entry.platformId}`;
      if (platform.length === 0) {
        throw new Error(
          `Unknown platform "${entry.platformId}". Add it to poster.platforms in a migration first.`,
        );
      }

      await sql`
        insert into poster.platform_constraints (platform_id, spec, spec_version)
        values (${entry.platformId}, ${sql.json(entry.spec as never)}, ${entry.specVersion})
        on conflict (platform_id) do update
           set spec         = excluded.spec,
               spec_version = excluded.spec_version`;

      await sql`update poster.platforms set enabled = true where id = ${entry.platformId}`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return specs.length;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return (
    entry?.endsWith('seed-constraints.js') === true ||
    entry?.endsWith('seed-constraints.ts') === true
  );
}

if (isDirectRun()) {
  const databaseUrl = requireEnv('DATABASE_URL');
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const specs = readSpecs(specDirectory(repoRoot));
  const count = await loadConstraints(databaseUrl, specs);

  console.log(`Loaded ${String(count)} platform constraint spec(s):\n`);
  for (const entry of specs) {
    const flag = entry.spec.provisional ? 'provisional' : 'confirmed';
    console.log(
      `  ${entry.platformId.padEnd(10)} v${String(entry.specVersion)}  ${flag}  ` +
        `${String(entry.spec.sources.length)} source(s)  -> enabled`,
    );
  }
  console.log(
    '\nProvisional specs come from platform docs, not the aggregator. S09 replaces them.',
  );
}
