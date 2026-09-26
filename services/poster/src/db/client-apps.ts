/**
 * Client app lookup and credential verification.
 *
 * `authenticate` verifies a secret *inside* this module: the argon2 hash is
 * selected, compared, and discarded here, so no hash is ever returned to a
 * handler, logged, or serialised (CLAUDE.md rule 5 applies to anything
 * credential-shaped, not only vault rows).
 */
import type { Sql } from 'postgres';
import { hashSecret, needsRehash, verifySecret } from '@suite/server-core';

export interface ClientApp {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly firstParty: boolean;
  readonly rateLimitPerMin: number;
}

export interface ClientAppStore {
  /**
   * Returns the app when the secret matches and the app is enabled, otherwise
   * undefined. Callers cannot tell "unknown client" from "wrong secret", which
   * is deliberate (contract §8: both are 401 invalid_token).
   */
  authenticate(clientId: string, secret: string): Promise<ClientApp | undefined>;
  findById(appId: string): Promise<ClientApp | undefined>;
  findByClientId(clientId: string): Promise<ClientApp | undefined>;
}

interface AppRow {
  id: string;
  client_id: string;
  name: string;
  first_party: boolean;
  rate_limit_per_min: number;
  client_secret_hash: string;
  disabled_at: Date | null;
}

function toClientApp(row: AppRow): ClientApp {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    firstParty: row.first_party,
    rateLimitPerMin: row.rate_limit_per_min,
  };
}

export function createClientAppStore(sql: Sql): ClientAppStore {
  async function selectBy(column: 'id' | 'client_id', value: string): Promise<AppRow | undefined> {
    const rows =
      column === 'id'
        ? await sql<AppRow[]>`
            select id, client_id, name, first_party, rate_limit_per_min,
                   client_secret_hash, disabled_at
              from poster.client_apps where id = ${value}`
        : await sql<AppRow[]>`
            select id, client_id, name, first_party, rate_limit_per_min,
                   client_secret_hash, disabled_at
              from poster.client_apps where client_id = ${value}`;
    return rows[0];
  }

  return {
    async authenticate(clientId, secret) {
      const row = await selectBy('client_id', clientId);
      if (row === undefined) {
        // Hash anyway so an unknown client_id costs the same as a wrong secret;
        // otherwise response timing enumerates which clients exist.
        await verifySecret(
          '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3vJ0z1mJmVcJYkP0mQ0k1o9F3lW6x0h7Xq1cM8nR2yA',
          secret,
        );
        return undefined;
      }
      if (row.disabled_at !== null) return undefined;

      const ok = await verifySecret(row.client_secret_hash, secret);
      if (!ok) return undefined;

      // Transparent upgrade when the cost baseline has been raised (D-045).
      if (needsRehash(row.client_secret_hash)) {
        const upgraded = await hashSecret(secret);
        await sql`
          update poster.client_apps set client_secret_hash = ${upgraded} where id = ${row.id}`;
      }
      return toClientApp(row);
    },

    async findById(appId) {
      const row = await selectBy('id', appId);
      return row === undefined || row.disabled_at !== null ? undefined : toClientApp(row);
    },

    async findByClientId(clientId) {
      const row = await selectBy('client_id', clientId);
      return row === undefined || row.disabled_at !== null ? undefined : toClientApp(row);
    },
  };
}
