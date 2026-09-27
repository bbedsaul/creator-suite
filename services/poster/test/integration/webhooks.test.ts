/**
 * Webhook delivery end to end (S08 acceptance criteria, contract §7, D-014).
 *
 * The events here are not fixtures: they are produced by the database triggers that
 * write the outbox, delivered by the real deliverer, and received by the real
 * reference consumer. That is the only arrangement that can show the schemas match
 * what the system actually emits, rather than what someone thought it emitted.
 *
 * Requires a running local stack (`pnpm exec supabase start`).
 */
import { randomBytes } from 'node:crypto';
import { createLocalKeyManager, createStaticSecretsManager } from '@suite/server-core';
import { WEBHOOK_EVENT_TYPES, WebhookEvent } from '@suite/poster-contract';
import { createWebhookSink, type WebhookSink } from '@suite/webhook-sink';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCredentialVault, type CredentialVault } from '../../src/vault/credentials.js';
import { deliverTick, type DeliverConfig } from '../../src/worker/deliver-loop.js';
import { loadConstraints, readSpecs, specDirectory } from '../../src/seed-constraints.js';
import { TEST_CLIENT_ID, seed } from '../../src/seed.js';

const DATABASE_URL =
  process.env['POSTER_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const repoRoot = process.cwd().replace(/\/services\/poster$/, '');

const SECRET = 'webhook-integration-secret';
const SECRET_REF = 'test:webhook';

const ids = {
  user: crypto.randomUUID(),
  connection: crypto.randomUUID(),
  grant: crypto.randomUUID(),
};

const sql = postgres(DATABASE_URL, { max: 8, onnotice: () => {} });
const secrets = createStaticSecretsManager({ [SECRET_REF]: SECRET });
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let vault: CredentialVault;
let appId = '';
let credentialId = '';
let sink: WebhookSink | undefined;
let sinkUrl = '';
let reachable = false;

function config(over: Partial<DeliverConfig> = {}): DeliverConfig {
  return {
    batchSize: 50,
    pollIntervalMs: 20,
    leaseMs: 60_000,
    timeoutMs: 5_000,
    giveUpAfterMs: 24 * 60 * 60 * 1000,
    baseBackoffMs: 10_000,
    maxBackoffMs: 3_600_000,
    ...over,
  };
}

function deps() {
  return { sql, secrets, logger: silent };
}

/**
 * Replaces the sink, optionally with scripted responses.
 *
 * Owns all three things that must change together: the listening server, the
 * `sinkUrl` the tampering tests post to, and the app's `webhook_url`. Doing this by
 * hand left sinkUrl pointing at a closed port.
 */
async function useSink(responses?: readonly number[]): Promise<WebhookSink> {
  await sink?.close();
  sink = createWebhookSink({ secret: SECRET, ...(responses === undefined ? {} : { responses }) });
  const port = await sink.listen();
  sinkUrl = `http://127.0.0.1:${String(port)}`;
  // Both columns together: client_apps has a check constraint that a webhook url
  // and its secret reference are either both set or both null, which is right —
  // a url with no way to sign for it would be unusable.
  await sql`
    update poster.client_apps set webhook_url = ${sinkUrl}, webhook_secret_ref = ${SECRET_REF}
     where id = ${appId}`;
  return sink;
}

async function cleanup(): Promise<void> {
  await sql`delete from poster.webhook_events where app_id = ${appId}`;
  await sql`delete from poster.posts where user_id = ${ids.user}`;
  await sql`delete from poster.grants where user_id = ${ids.user}`;
  await sql`delete from poster.connections where user_id = ${ids.user}`;
  await sql`delete from poster.credentials where user_id = ${ids.user}`;
  await sql`delete from auth.users where id = ${ids.user}`;
}

/** Clears the outbox so each test reasons about only the events it caused. */
async function clearOutbox(): Promise<void> {
  await sql`delete from poster.webhook_events where app_id = ${appId}`;
}

async function createTarget(state: 'accepted' | 'scheduled' = 'scheduled'): Promise<string> {
  const posts = await sql<{ id: string }[]>`
    insert into poster.posts (user_id, app_id, external_ref, content)
    values (${ids.user}, ${appId}, 'lesson_42/clip_3', ${sql.json({ text: 'hook me' } as never)})
    returning id`;
  const targets = await sql<{ id: string }[]>`
    insert into poster.post_targets
      (post_id, user_id, connection_id, platform_id, position, due_at, state)
    values (${posts[0]?.id as string}, ${ids.user}, ${ids.connection}, 'tiktok', 0,
            now(), ${state})
    returning id`;
  return targets[0]?.id as string;
}

beforeAll(async () => {
  try {
    await sql`select 1`;
    reachable = true;
  } catch {
    return;
  }

  await seed(DATABASE_URL);
  await loadConstraints(DATABASE_URL, readSpecs(specDirectory(repoRoot)));

  const apps = await sql<{ id: string }[]>`
    select id from poster.client_apps where client_id = ${TEST_CLIENT_ID}`;
  appId = apps[0]?.id as string;
  await cleanup();

  // The app gets a webhook URL and a *reference* to its secret. The secret itself
  // is never stored in the database (contract §2.1).
  await useSink();

  await sql`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${ids.user}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`hooks-${ids.user}@example.test`}, 'x', now(), now())`;

  vault = createCredentialVault(
    sql,
    createLocalKeyManager({ masterKeyBase64: randomBytes(32).toString('base64') }),
  );
  credentialId = await vault.store({
    userId: ids.user,
    kind: 'aggregator_profile',
    provider: 'fake',
    secret: 'never-logged',
  });

  await sql`
    insert into poster.connections (id, user_id, platform_id, credential_id, external_account_id)
    values (${ids.connection}, ${ids.user}, 'tiktok', ${credentialId}, ${`tt-${ids.connection}`})`;
}, 120_000);

afterEach(async () => {
  if (reachable) {
    await clearOutbox();
    await sql`delete from poster.posts where user_id = ${ids.user}`;
    sink?.reset();
  }
});

afterAll(async () => {
  await sink?.close();
  if (reachable) {
    await cleanup();
    await sql`update poster.client_apps set webhook_url = null, webhook_secret_ref = null
               where id = ${appId}`;
  }
  await sql.end({ timeout: 5 });
});

describe('environment', () => {
  it('has a reachable database and a listening sink', () => {
    expect(reachable, `need a local stack for ${DATABASE_URL}`).toBe(true);
    expect(sinkUrl).toMatch(/^http/);
  });
});

describe('delivery', () => {
  it('signs the envelope so the reference consumer accepts it', async () => {
    await createTarget();
    const result = await deliverTick(config(), deps());

    expect(result.delivered).toBeGreaterThan(0);
    expect(sink?.rejected, JSON.stringify(sink?.rejected)).toHaveLength(0);
    expect(sink?.received.length).toBeGreaterThan(0);
  });

  it('delivers public prefixed ids, never raw uuids (rule 7)', async () => {
    const targetId = await createTarget();
    await deliverTick(config(), deps());

    const body = sink?.received[0]?.body as { event_id: string; target_id: string };
    expect(body.event_id).toMatch(/^ev_/);
    expect(body.target_id).toMatch(/^tg_/);
    expect(JSON.stringify(sink?.received)).not.toContain(targetId);
  });

  it('echoes external_ref so a client maps the event back without a lookup', async () => {
    await createTarget();
    await deliverTick(config(), deps());
    expect((sink?.received[0]?.body as { external_ref: string }).external_ref).toBe(
      'lesson_42/clip_3',
    );
  });

  it('marks the row delivered and does not send it again', async () => {
    await createTarget();
    await deliverTick(config(), deps());
    const before = sink?.requestCount() ?? 0;

    const second = await deliverTick(config(), deps());
    expect(second.claimed).toBe(0);
    expect(sink?.requestCount()).toBe(before);

    const rows = await sql<{ delivered_at: Date | null; last_error: string | null }[]>`
      select delivered_at, last_error from poster.webhook_events where app_id = ${appId}`;
    for (const row of rows) {
      expect(row.delivered_at).not.toBeNull();
      expect(row.last_error).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 1
// ---------------------------------------------------------------------------
describe('retries (criterion 1)', () => {
  it('a sink that 500s three times then 200s receives the event once in effect', async () => {
    const scripted = await useSink([500, 500, 500, 200]);
    await createTarget();

    // Four passes, each clearing the backoff so the test does not wait ten seconds
    // between attempts. The backoff value itself is unit-tested.
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await deliverTick(config(), deps());
      outcomes.push(result.delivered > 0 ? 'delivered' : result.retried > 0 ? 'retried' : 'none');
      await sql`
        update poster.webhook_events set next_attempt_at = now()
         where app_id = ${appId} and delivered_at is null and gave_up_at is null`;
    }

    expect(outcomes).toEqual(['retried', 'retried', 'retried', 'delivered']);

    // Four deliveries arrived — at-least-once is the contract — but the consumer
    // processed the event once, which is what "once in effect" means (§7).
    expect(scripted.requestCount()).toBe(4);
    expect(scripted.processedIds()).toHaveLength(1);
    expect(scripted.received.filter((entry) => entry.duplicate)).toHaveLength(3);

    const rows = await sql<{ delivered_at: Date | null; attempt_count: number }[]>`
      select delivered_at, attempt_count from poster.webhook_events where app_id = ${appId}`;
    expect(rows[0]?.delivered_at).not.toBeNull();
    expect(rows[0]?.attempt_count).toBe(4);

    // Restore the plain sink for the remaining tests.
    await useSink();
  });

  it('records the failure reason while retrying', async () => {
    await useSink([503]);

    await createTarget();
    const result = await deliverTick(config(), deps());
    expect(result.retried).toBeGreaterThan(0);

    const rows = await sql<{ last_error: string | null; delivered_at: Date | null }[]>`
      select last_error, delivered_at from poster.webhook_events where app_id = ${appId}`;
    expect(rows[0]?.last_error).toContain('503');
    expect(rows[0]?.delivered_at).toBeNull();

    await useSink();
  });

  it('gives up once the event is older than the retry window', async () => {
    await useSink([500]);

    await createTarget();
    // 25 hours old: past the 24 hour window in §7.
    await sql`
      update poster.webhook_events set occurred_at = now() - interval '25 hours'
       where app_id = ${appId}`;

    const result = await deliverTick(config(), deps());
    expect(result.gaveUp).toBeGreaterThan(0);

    const rows = await sql<{ gave_up_at: Date | null; last_error: string | null }[]>`
      select gave_up_at, last_error from poster.webhook_events where app_id = ${appId}`;
    expect(rows[0]?.gave_up_at).not.toBeNull();
    expect(rows[0]?.last_error).toContain('500');

    // And it is not claimed again.
    expect((await deliverTick(config(), deps())).claimed).toBe(0);

    await useSink();
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2
// ---------------------------------------------------------------------------
describe('tampering (criterion 2)', () => {
  it('a tampered body is rejected by the sink', async () => {
    // Deliver normally to capture a real signed body, then replay it modified.
    await createTarget();
    await deliverTick(config(), deps());

    const delivered = sink?.received[0]?.body as Record<string, unknown>;
    expect(delivered).toBeDefined();

    const { signWebhook } = await import('@suite/server-core');
    const { formatSignatureHeader, SIGNATURE_HEADER } = await import('@suite/poster-contract');
    const timestamp = Math.floor(Date.now() / 1000);
    const honest = JSON.stringify(delivered);
    const header = formatSignatureHeader(timestamp, signWebhook(SECRET, timestamp, honest));

    const tampered = JSON.stringify({ ...delivered, state: 'failed' });
    const response = await fetch(sinkUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: header },
      body: tampered,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ rejected: 'bad_signature' });
  });

  it('a replayed delivery outside the window is rejected', async () => {
    await createTarget();
    await deliverTick(config(), deps());

    const delivered = JSON.stringify(sink?.received[0]?.body);
    const { signWebhook } = await import('@suite/server-core');
    const { formatSignatureHeader, SIGNATURE_HEADER } = await import('@suite/poster-contract');
    // A capture from an hour ago, correctly signed for that moment.
    const stale = Math.floor(Date.now() / 1000) - 3_600;

    const response = await fetch(sinkUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: formatSignatureHeader(stale, signWebhook(SECRET, stale, delivered)),
      },
      body: delivered,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ rejected: 'expired' });
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3
// ---------------------------------------------------------------------------
describe('every event type validates against the §7 schemas (criterion 3)', () => {
  it('delivers all eight documented type strings and each parses', async () => {
    await clearOutbox();
    sink?.reset();

    // Produce every type by driving the real triggers.
    const scheduled = await createTarget('accepted');
    await sql`update poster.post_targets set state = 'scheduled' where id = ${scheduled}`; // post.scheduled

    // post.posted, via the legal route through dispatching.
    await sql`
      update poster.post_targets
         set state = 'dispatching', claimed_by = 'w', claim_expires_at = now() + interval '5 min'
       where id = ${scheduled}`;
    await sql`update poster.post_targets set state = 'posted' where id = ${scheduled}`;

    // post.failed on a second target.
    const failing = await createTarget();
    await sql`
      update poster.post_targets set state = 'failed', reason_class = 'platform_rejected',
             platform_message = 'Caption too long'
       where id = ${failing}`;

    // A live grant, so the connection events have an audience: grant.updated.
    await sql`
      insert into poster.grants (id, app_id, user_id, connection_id, scopes)
      values (${ids.grant}, ${appId}, ${ids.user}, ${ids.connection}, '{publish}')`;

    // post.paused + connection.revoked, then post.resumed + connection.restored.
    const pausing = await createTarget();
    await sql`update poster.connections set status = 'revoked' where id = ${ids.connection}`;
    await sql`update poster.connections set status = 'active' where id = ${ids.connection}`;
    expect(pausing).toBeTruthy();

    // grant.updated again, as a revocation.
    await sql`update poster.grants set revoked_at = now() where id = ${ids.grant}`;

    const queued = await sql<{ type: string }[]>`
      select distinct type from poster.webhook_events where app_id = ${appId} order by type`;
    const types = queued.map((row) => row.type);

    // Every documented type string was actually produced by a trigger.
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(types, `no trigger produced ${type}`).toContain(type);
    }

    // Deliver them all, then validate what the consumer received.
    for (let pass = 0; pass < 6; pass += 1) {
      const result = await deliverTick(config(), deps());
      if (result.claimed === 0) break;
      await sql`
        update poster.webhook_events set next_attempt_at = now()
         where app_id = ${appId} and delivered_at is null and gave_up_at is null`;
    }

    expect(sink?.rejected, JSON.stringify(sink?.rejected)).toHaveLength(0);

    const receivedTypes = new Set((sink?.received ?? []).map((entry) => entry.type));
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect([...receivedTypes], `${type} was never delivered`).toContain(type);
    }

    // The point of the criterion: each delivered body validates against the schema
    // for its own type, so §7 describes what the system really sends.
    for (const entry of sink?.received ?? []) {
      const parsed = WebhookEvent.safeParse(entry.body);
      expect(
        parsed.success,
        `${entry.type} failed validation: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
    }

    console.log(
      `webhooks: delivered and validated ${String(receivedTypes.size)} distinct event types ` +
        `(${[...receivedTypes].sort().join(', ')})`,
    );
  }, 120_000);
});

describe('an app with no webhook_url', () => {
  it('closes the event with a reason rather than retrying forever', async () => {
    await sql`update poster.client_apps set webhook_url = null, webhook_secret_ref = null
               where id = ${appId}`;
    try {
      await createTarget();
      const result = await deliverTick(config(), deps());

      expect(result.unroutable).toBeGreaterThan(0);
      const rows = await sql<{ gave_up_at: Date | null; last_error: string | null }[]>`
        select gave_up_at, last_error from poster.webhook_events where app_id = ${appId}`;
      // Not "delivered", which would be a lie, and not retried, since waiting will
      // not conjure a URL (D-077).
      expect(rows[0]?.gave_up_at).not.toBeNull();
      expect(rows[0]?.last_error).toContain('webhook_url');
    } finally {
      await sql`update poster.client_apps set webhook_url = ${sinkUrl}, webhook_secret_ref = ${SECRET_REF}
                 where id = ${appId}`;
    }
  });
});
