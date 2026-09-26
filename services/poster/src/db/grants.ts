/**
 * Grant checks (contract §3, §8 `grant_missing`).
 *
 * "App credentials alone never authorize publishing" (§2.1): an app acting for a
 * user must hold a live grant on each connection it targets. User mode is the
 * documented exception — the user implicitly holds full scopes on their own
 * connections through the first-party composer (§2.2) — so the caller decides
 * whether to consult this at all (D-064).
 */
import type { Sql } from 'postgres';

export interface GrantStore {
  /** Connection uuids from `connectionUuids` that this app does NOT hold a live grant for. */
  findUngranted(appId: string, connectionUuids: readonly string[]): Promise<string[]>;
}

export function createGrantStore(sql: Sql): GrantStore {
  return {
    async findUngranted(appId, connectionUuids) {
      if (connectionUuids.length === 0) return [];

      const granted = await sql<{ connection_id: string }[]>`
        select connection_id from poster.grants
         where app_id = ${appId}
           and revoked_at is null
           and connection_id = any(${sql.array(connectionUuids as string[])}::uuid[])`;

      const have = new Set(granted.map((row) => row.connection_id));
      return connectionUuids.filter((uuid) => !have.has(uuid));
    },
  };
}
