/**
 * Reads platform constraint specs from the database (CLAUDE.md rule 9).
 *
 * Only platforms that are both `enabled` and have a spec row are returned. A
 * platform with no spec is not "unconstrained" — it is unlaunchable, because
 * accepting content we cannot validate means dispatching posts the platform will
 * reject (D-058).
 */
import type { Sql } from 'postgres';
import {
  PlatformConstraintSpec,
  type PlatformConstraints,
  type PlatformConstraintSpec as Spec,
} from '@suite/poster-contract';

export interface PlatformConstraintStore {
  /** Everything GET /v1/platforms/constraints publishes. */
  listEnabled(): Promise<PlatformConstraints[]>;
  /** Specs by platform_id, for the validator. */
  specsByPlatform(): Promise<Map<string, Spec>>;
}

interface Row {
  platform_id: string;
  display_name: string;
  supports_threads: boolean;
  spec_version: number;
  updated_at: Date;
  spec: unknown;
}

export function createPlatformConstraintStore(sql: Sql): PlatformConstraintStore {
  async function rows(): Promise<PlatformConstraints[]> {
    const result = await sql<Row[]>`
      select p.id as platform_id, p.display_name, p.supports_threads,
             c.spec_version, c.updated_at, c.spec
        from poster.platforms p
        join poster.platform_constraints c on c.platform_id = p.id
       where p.enabled
       order by p.id`;

    return result.map((row) => ({
      platform_id: row.platform_id,
      display_name: row.display_name,
      supports_threads: row.supports_threads,
      spec_version: row.spec_version,
      updated_at: row.updated_at.toISOString(),
      // Parsed, not cast: a spec that has drifted from the schema must fail loudly
      // here rather than produce silently wrong validation downstream.
      spec: PlatformConstraintSpec.parse(row.spec),
    }));
  }

  return {
    listEnabled: rows,
    async specsByPlatform() {
      return new Map((await rows()).map((entry) => [entry.platform_id, entry.spec]));
    },
  };
}
