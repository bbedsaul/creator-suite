/**
 * Which platforms this worker dispatches for, and with what budget.
 *
 * Only `enabled` platforms get a loop (OQ-2 launch control), and only those that
 * also have a constraint spec — a platform we cannot validate against is one we
 * must not post to (D-058). Per-platform overrides exist because rule 10 requires
 * each loop to have *its own* concurrency and poll interval, not a shared one:
 * TikTok being rate-limited must be tunable without touching YouTube.
 */
import type { Sql } from 'postgres';
import type { PlatformDispatchConfig } from './dispatch-loop.js';

export interface DispatchDefaults {
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly publishTimeoutMs: number;
}

export type DispatchOverrides = Record<string, Partial<DispatchDefaults>>;

export async function loadDispatchablePlatforms(
  sql: Sql,
  defaults: DispatchDefaults,
  overrides: DispatchOverrides = {},
): Promise<PlatformDispatchConfig[]> {
  const rows = await sql<{ id: string }[]>`
    select p.id
      from poster.platforms p
      join poster.platform_constraints c on c.platform_id = p.id
     where p.enabled
     order by p.id`;

  return rows.map((row) => ({
    platformId: row.id,
    ...defaults,
    ...overrides[row.id],
  }));
}

/** Parses DISPATCH_OVERRIDES, which is JSON keyed by platform id. */
export function parseOverrides(raw: string): DispatchOverrides {
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('DISPATCH_OVERRIDES must be JSON keyed by platform id', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('DISPATCH_OVERRIDES must be a JSON object');
  }
  return parsed as DispatchOverrides;
}
