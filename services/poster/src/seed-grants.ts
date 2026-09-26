/**
 * Grants a development app publish access to a user's connections.
 *
 *   pnpm -F @suite/poster-service seed:grants -- --user <uuid> [--app trainer-dev]
 *
 * Real consent is the scope-request flow in M2 (contract §3). Until then an app
 * acting for a user needs a grant row to get past `403 grant_missing`, and there
 * is no UI to create one, so this is the development stand-in (D-067). It grants
 * every live connection the user currently has; run it again after connecting
 * another account.
 */
import { requireEnv } from '@suite/server-core';
import { createPool } from './db/pool.js';

export interface GrantSeedResult {
  readonly clientId: string;
  readonly userId: string;
  readonly granted: number;
  readonly alreadyGranted: number;
}

export async function seedGrants(
  databaseUrl: string,
  options: { userId: string; clientId: string; scopes?: readonly string[] },
): Promise<GrantSeedResult> {
  const sql = createPool({ databaseUrl, max: 2 });
  const scopes = options.scopes ?? ['publish'];

  try {
    const apps = await sql<{ id: string }[]>`
      select id from poster.client_apps where client_id = ${options.clientId}`;
    const appId = apps[0]?.id;
    if (appId === undefined) {
      throw new Error(`Unknown client_id "${options.clientId}". Run seed first.`);
    }

    const connections = await sql<{ id: string }[]>`
      select id from poster.connections
       where user_id = ${options.userId} and disconnected_at is null`;
    if (connections.length === 0) {
      throw new Error(`User ${options.userId} has no live connections to grant.`);
    }

    let granted = 0;
    for (const connection of connections) {
      // The partial unique index allows only one live grant per app+connection,
      // so re-running is a no-op rather than a duplicate.
      const rows = await sql<{ id: string }[]>`
        insert into poster.grants (app_id, user_id, connection_id, scopes)
        values (${appId}, ${options.userId}, ${connection.id}, ${sql.array(scopes as string[])})
        on conflict do nothing
        returning id`;
      if (rows.length > 0) granted += 1;
    }

    return {
      clientId: options.clientId,
      userId: options.userId,
      granted,
      alreadyGranted: connections.length - granted,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry?.endsWith('seed-grants.js') === true || entry?.endsWith('seed-grants.ts') === true;
}

if (isDirectRun()) {
  const userId = flag('user');
  if (userId === undefined) {
    console.error('Usage: seed:grants -- --user <uuid> [--app trainer-dev]');
    process.exit(2);
  }

  const result = await seedGrants(requireEnv('DATABASE_URL'), {
    userId,
    clientId: flag('app') ?? 'trainer-dev',
  });

  console.log(
    `Granted ${String(result.granted)} new and confirmed ${String(result.alreadyGranted)} existing ` +
      `connection grant(s) for ${result.clientId} on user ${result.userId}.`,
  );
  console.log('Real consent arrives with the scope-request flow in M2.');
}
