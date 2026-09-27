/**
 * Sets up everything the M1 exit demo needs that the API cannot create itself.
 *
 *   pnpm -F @suite/poster-service seed:demo -- \
 *     --webhook-url http://127.0.0.1:4100/webhooks
 *
 * The demo (`tools/m1-demo`) talks only HTTP, through the generated client, as a
 * real integrator would. But M1 has no Connections API yet — connect/disconnect is
 * M2, contract §4 — so a user with two live connections cannot be produced over
 * the wire. This script is the operator-side stand-in (D-094), in the same spirit
 * as `seed:grants` (D-067):
 *
 *   - a demo user in `auth.users`
 *   - one `aggregator_profile` credential, encrypted through the vault
 *   - one connection per platform, sharing that credential, which is exactly the
 *     shape D-013 describes for an aggregator
 *   - a `publish` grant for the demo app on both connections
 *   - the demo app's `webhook_url` and `webhook_secret_ref`, so the outbox has
 *     somewhere to deliver to
 *
 * It prints the env lines the demo reads. Re-running is a no-op apart from the
 * webhook settings, so it is safe in a loop.
 */
import { randomUUID } from 'node:crypto';
import { encodeId } from '@suite/poster-contract';
import { requireEnv } from '@suite/server-core';
import { createLocalKeyManager } from '@suite/server-core';
import { createPool } from './db/pool.js';
import { createCredentialVault } from './vault/credentials.js';
import { M1_DEMO_CLIENT_ID } from './seed.js';

/** Stable so re-running finds the same user instead of piling up new ones. */
export const DEMO_USER_EMAIL = 'm1-demo@creator-suite.test';

/** Platforms the M1 exit criteria name. */
export const DEMO_PLATFORMS = ['tiktok', 'youtube'] as const;
export type DemoPlatform = (typeof DEMO_PLATFORMS)[number];

export interface DemoSeedOptions {
  readonly webhookUrl: string;
  /**
   * Secrets-manager reference, not the secret (contract §2.1, D-080). The worker
   * resolves it, so the named variable must be in the **worker's** environment.
   */
  readonly webhookSecretRef: string;
  /** Base64 32-byte key. Must match the worker's, or dispatch cannot decrypt. */
  readonly vaultMasterKey: string;
}

export interface DemoSeedResult {
  readonly userId: string;
  readonly credentialId: string;
  /** Internal uuids, as stored. */
  readonly connections: Readonly<Record<DemoPlatform, string>>;
  /**
   * The same connections as `cn_…` public ids — what the API actually accepts
   * (rule 7). Printed because a demo handed raw uuids gets `404 not_found`, which
   * is correct behaviour and a confusing thing to debug.
   */
  readonly publicConnections: Readonly<Record<DemoPlatform, string>>;
  readonly grantsCreated: number;
  readonly createdUser: boolean;
}

export async function seedDemo(
  databaseUrl: string,
  options: DemoSeedOptions,
): Promise<DemoSeedResult> {
  const sql = createPool({ databaseUrl, max: 2 });
  const keys = createLocalKeyManager({ masterKeyBase64: options.vaultMasterKey });
  const vault = createCredentialVault(sql, keys);

  try {
    const apps = await sql<{ id: string }[]>`
      select id from poster.client_apps where client_id = ${M1_DEMO_CLIENT_ID}`;
    const appId = apps[0]?.id;
    if (appId === undefined) {
      throw new Error(
        `No "${M1_DEMO_CLIENT_ID}" app. Run \`pnpm -F @suite/poster-service seed\` first.`,
      );
    }

    // Both columns or neither: `client_apps` has a check constraint saying so,
    // because a URL with no secret would mean sending unsigned events.
    await sql`
      update poster.client_apps
         set webhook_url = ${options.webhookUrl},
             webhook_secret_ref = ${options.webhookSecretRef}
       where id = ${appId}`;

    const existing = await sql<{ id: string }[]>`
      select id from auth.users where email = ${DEMO_USER_EMAIL}`;
    let userId = existing[0]?.id;
    const createdUser = userId === undefined;

    if (userId === undefined) {
      // `auth.users.id` has no default — Supabase's auth service supplies it — so
      // the id is generated here rather than by the database.
      const rows = await sql<{ id: string }[]>`
        insert into auth.users
          (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
        values (${randomUUID()}, '00000000-0000-0000-0000-000000000000',
                'authenticated', 'authenticated',
                ${DEMO_USER_EMAIL}, 'x', now(), now())
        returning id`;
      userId = rows[0]?.id;
      if (userId === undefined) throw new Error('could not create the demo user');
    }

    // One credential behind both connections (D-013). Reused across runs so the
    // vault_access_log tells a continuous story rather than one per invocation.
    const credentials = await sql<{ id: string }[]>`
      select id from poster.credentials
       where user_id = ${userId} and provider = 'fake' and kind = 'aggregator_profile'
       order by created_at limit 1`;
    const credentialId =
      credentials[0]?.id ??
      (await vault.store({
        userId,
        kind: 'aggregator_profile',
        provider: 'fake',
        secret: 'm1-demo-aggregator-profile-key',
      }));

    const connections: Record<string, string> = {};
    for (const platform of DEMO_PLATFORMS) {
      const found = await sql<{ id: string }[]>`
        select id from poster.connections
         where user_id = ${userId} and platform_id = ${platform} and disconnected_at is null
         limit 1`;
      const id =
        found[0]?.id ??
        (
          await sql<{ id: string }[]>`
          insert into poster.connections
            (user_id, platform_id, credential_id, external_account_id, handle, display_name)
          values (${userId}, ${platform}, ${credentialId},
                  ${`${platform}-m1-demo`}, ${`@m1demo`}, 'M1 Demo Account')
          returning id`
        )[0]?.id;
      if (id === undefined) throw new Error(`could not create the ${platform} connection`);
      connections[platform] = id;
    }

    let grantsCreated = 0;
    for (const connectionId of Object.values(connections)) {
      const rows = await sql<{ id: string }[]>`
        insert into poster.grants (app_id, user_id, connection_id, scopes)
        values (${appId}, ${userId}, ${connectionId}, ${sql.array(['publish'])})
        on conflict do nothing
        returning id`;
      if (rows.length > 0) grantsCreated += 1;
    }

    const publicConnections = Object.fromEntries(
      Object.entries(connections).map(([platform, id]) => [platform, encodeId('connection', id)]),
    );

    return {
      userId,
      credentialId,
      connections: connections as Record<DemoPlatform, string>,
      publicConnections: publicConnections as Record<DemoPlatform, string>,
      grantsCreated,
      createdUser,
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
  return entry?.endsWith('seed-demo.js') === true || entry?.endsWith('seed-demo.ts') === true;
}

if (isDirectRun()) {
  const databaseUrl = requireEnv('DATABASE_URL');
  const webhookUrl = flag('webhook-url') ?? 'http://127.0.0.1:4100/webhooks';
  const webhookSecretRef = flag('webhook-secret-ref') ?? 'env:M1_DEMO_WEBHOOK_SECRET';
  const vaultMasterKey = requireEnv('VAULT_MASTER_KEY');

  const result = await seedDemo(databaseUrl, { webhookUrl, webhookSecretRef, vaultMasterKey });

  console.log(`M1 demo fixtures (${result.createdUser ? 'created' : 'reused'} the demo user):\n`);
  console.log(`  user           ${result.userId}`);
  console.log(`  credential     ${result.credentialId}`);
  for (const [platform, id] of Object.entries(result.connections)) {
    console.log(
      `  ${platform.padEnd(14)} ${id}  ${result.publicConnections[platform as DemoPlatform] ?? ''}`,
    );
  }
  console.log(`  grants created ${String(result.grantsCreated)}`);
  console.log(`  webhook_url    ${webhookUrl}`);
  console.log(`  secret ref     ${webhookSecretRef}\n`);
  console.log('Environment for the demo:\n');
  console.log(`DEMO_USER_ID=${result.userId}`);
  for (const [platform, id] of Object.entries(result.publicConnections)) {
    console.log(`DEMO_${platform.toUpperCase()}_CONNECTION=${id}`);
  }
  console.log(
    `\nThe worker needs ${webhookSecretRef.replace(/^env:/, '')} in its environment, ` +
      'and the demo needs the same value.',
  );
}
