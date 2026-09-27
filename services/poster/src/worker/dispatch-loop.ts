/**
 * One dispatch loop per platform (CLAUDE.md rules 2–4 and 10, NFR-02, NFR-04).
 *
 * The four rules this file exists to obey, in the order they bite:
 *
 *   2. Every state change goes through `claim_due_targets` / `finish_dispatch`.
 *      This module never writes `post_targets.state` itself.
 *   3. Only `scheduled` rows are claimable, so a row in `dispatching` is never
 *      re-sent. A crash leaves it there for reconciliation (S07), not for a retry.
 *   4. The `dispatch_attempts` row is inserted with outcome `in_flight` **before**
 *      the adapter is called, so a crash mid-call leaves evidence that the attempt
 *      existed and what its reference was.
 *  10. One platform's outage cannot delay another's. Each platform gets its own
 *      loop, its own concurrency budget and its own timeouts, and nothing is
 *      awaited across platforms.
 */
import type { Sql } from 'postgres';
import type {
  PlatformAdapter,
  PublishOutcome,
  PublishTarget,
  Rendition,
} from '../adapters/adapter.js';
import type { CredentialVault } from '../vault/credentials.js';

export interface DispatchLoopLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface PlatformDispatchConfig {
  readonly platformId: string;
  /** How many targets this platform may have in flight at once. */
  readonly concurrency: number;
  /** How long to wait after an empty claim before asking again. */
  readonly pollIntervalMs: number;
  /** Database-side claim lease. Must exceed publishTimeoutMs with room to spare. */
  readonly leaseMs: number;
  /** Hard deadline handed to the adapter. */
  readonly publishTimeoutMs: number;
}

export interface DispatchDeps {
  readonly sql: Sql;
  readonly vault: CredentialVault;
  /** Resolves the adapter for a platform. */
  readonly adapterFor: (platformId: string) => PlatformAdapter;
  readonly workerId: string;
  readonly logger: DispatchLoopLogger;
}

/** A claimed row, as `claim_due_targets` returns it. */
interface ClaimedTarget {
  id: string;
  post_id: string;
  user_id: string;
  connection_id: string;
  platform_id: string;
  overrides: { text?: string; title?: string } | null;
  attempt_count: number;
  due_at: Date;
}

interface TargetContext {
  readonly credentialId: string;
  readonly externalAccountId: string;
  readonly text: string | null;
  readonly title: string | null;
  readonly renditions: Rendition[];
}

export interface DispatchTickResult {
  readonly claimed: number;
  readonly resolved: number;
  /** finish_dispatch returned false: the lease was lost, so someone else owns it. */
  readonly fencedOut: number;
}

/**
 * Loads everything the adapter needs that the claim did not return: the account
 * to post to, the effective text, and the media. Kept separate from the claim so
 * the claim stays the narrow, hot, index-driven query it is.
 */
async function loadContext(sql: Sql, target: ClaimedTarget): Promise<TargetContext> {
  const connections = await sql<{ credential_id: string; external_account_id: string }[]>`
    select credential_id, external_account_id
      from poster.connections where id = ${target.connection_id}`;
  const connection = connections[0];
  if (connection === undefined) {
    throw new Error(`connection ${target.connection_id} vanished mid-dispatch`);
  }

  const posts = await sql<{ content: { text?: string; title?: string } }[]>`
    select content from poster.posts where id = ${target.post_id}`;
  const content = posts[0]?.content ?? {};

  const media = await sql<
    {
      media_id: string;
      kind: 'image' | 'video';
      mime_type: string;
      storage_path: string;
      duration_ms: number | null;
    }[]
  >`
    select m.id as media_id, m.kind, m.mime_type, m.storage_path, m.duration_ms
      from poster.post_media pm
      join poster.media m on m.id = pm.media_id
     where pm.post_id = ${target.post_id}
     order by pm.part, pm.position`;

  return {
    credentialId: connection.credential_id,
    externalAccountId: connection.external_account_id,
    // Overrides replace the default content for this target only (§5).
    text: target.overrides?.text ?? content.text ?? null,
    title: target.overrides?.title ?? content.title ?? null,
    renditions: media.map((row) => ({
      mediaId: row.media_id,
      kind: row.kind,
      mimeType: row.mime_type,
      // Per-platform renditions arrive later; until then the original is the URL.
      url: row.storage_path,
      durationS: row.duration_ms === null ? null : row.duration_ms / 1000,
    })),
  };
}

/**
 * Dispatches one claimed target: attempt row, credential, publish, finish.
 *
 * Returns false when `finish_dispatch` fenced us out, which means our lease had
 * already expired and another worker or the reconciler owns the row. That is not
 * an error; it is the mechanism working.
 */
async function dispatchOne(
  target: ClaimedTarget,
  config: PlatformDispatchConfig,
  deps: DispatchDeps,
): Promise<boolean> {
  const adapter = deps.adapterFor(target.platform_id);
  // The claim already incremented attempt_count, so this is our attempt number.
  const attemptNo = target.attempt_count;

  // Rule 4: the attempt row exists before the adapter is called, and its id is the
  // reference the provider is given, so a crash leaves a trail that can be looked up.
  const attempts = await deps.sql<{ id: string }[]>`
    insert into poster.dispatch_attempts (target_id, attempt_no, worker_id, adapter, outcome)
    values (${target.id}, ${attemptNo}, ${deps.workerId}, ${adapter.id}, 'in_flight')
    returning id`;
  const attemptRef = attempts[0]?.id;
  if (attemptRef === undefined) throw new Error('attempt insert returned no id');

  let outcome: PublishOutcome;
  try {
    const context = await loadContext(deps.sql, target);

    // Every decrypt is logged by the vault, attributed to this platform's loop
    // and this target (rule 5, NFR-03).
    const credential = await deps.vault.open(context.credentialId, {
      accessor: `dispatcher:${target.platform_id}`,
      purpose: 'dispatch',
      targetId: target.id,
    });

    const publishTarget: PublishTarget = {
      targetId: target.id,
      platformId: target.platform_id,
      externalAccountId: context.externalAccountId,
      text: context.text,
      title: context.title,
    };

    outcome = await adapter.publish({
      attemptRef,
      credential: {
        kind: credential.kind,
        provider: credential.provider,
        secret: credential.secret,
      },
      target: publishTarget,
      renditions: context.renditions,
      timeoutMs: config.publishTimeoutMs,
    });
  } catch (error) {
    // We do not know whether the adapter reached the platform, and guessing in
    // either direction is worse than admitting it (D-012). Note the message is
    // ours, not the error's: an error could carry credential material.
    deps.logger.error(
      { targetId: target.id, platformId: target.platform_id, err: error },
      'dispatch threw before producing an outcome',
    );
    outcome = {
      kind: 'unknown',
      message: 'dispatch failed before an outcome was known',
      raw: null,
    };
  }

  const resolved = await deps.sql<{ finish_dispatch: boolean }[]>`
    select poster.finish_dispatch(
      ${target.id}::uuid,
      ${deps.workerId},
      ${attemptNo},
      ${outcome.kind}::poster.attempt_outcome,
      ${outcome.kind === 'success' ? outcome.platformPostId : null},
      ${outcome.kind === 'success' ? (outcome.permalink ?? null) : null},
      ${outcome.kind === 'success' ? null : outcome.message},
      ${deps.sql.json((outcome.raw ?? null) as never)},
      ${null},
      ${outcome.kind === 'transient' ? (outcome.retryAt ?? null) : null}
    ) as finish_dispatch`;

  const accepted = resolved[0]?.finish_dispatch === true;
  if (!accepted) {
    deps.logger.warn(
      { targetId: target.id, attemptNo, outcome: outcome.kind },
      'finish_dispatch fenced this worker out; the lease had been lost',
    );
  }
  return accepted;
}

/** Runs `tasks` with at most `limit` in flight. */
async function withConcurrency<T>(
  limit: number,
  tasks: readonly (() => Promise<T>)[],
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (task === undefined) continue;
      try {
        results[index] = { status: 'fulfilled', value: await task() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Claims and dispatches one batch for one platform. Exposed separately from the
 * loop so tests can drive a single tick deterministically instead of racing a
 * timer.
 */
export async function dispatchTick(
  config: PlatformDispatchConfig,
  deps: DispatchDeps,
): Promise<DispatchTickResult> {
  const claimed = await deps.sql<ClaimedTarget[]>`
    select * from poster.claim_due_targets(
      ${config.platformId},
      ${deps.workerId},
      ${config.concurrency},
      ${`${String(Math.round(config.leaseMs / 1000))} seconds`}::interval
    )`;

  if (claimed.length === 0) return { claimed: 0, resolved: 0, fencedOut: 0 };

  const settled = await withConcurrency(
    config.concurrency,
    claimed.map((target) => () => dispatchOne(target, config, deps)),
  );

  let resolved = 0;
  let fencedOut = 0;
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      if (result.value) resolved += 1;
      else fencedOut += 1;
    } else {
      // The row stays in `dispatching` and reconciliation will pick it up; not
      // re-dispatching it here is the whole point of rule 3.
      deps.logger.error(
        { targetId: claimed[index]?.id, err: result.reason },
        'dispatch left a target unresolved; reconciliation will decide',
      );
    }
  }

  return { claimed: claimed.length, resolved, fencedOut };
}

export interface DispatchLoop {
  readonly platformId: string;
  /** Resolves when the loop has stopped. */
  readonly done: Promise<void>;
}

/**
 * Starts a loop for one platform. Returns immediately; the loop runs until
 * `signal` aborts. Each platform's loop is an independent task, so a platform
 * that is slow, wedged or rate-limited cannot hold another one up (rule 10).
 */
export function startDispatchLoop(
  config: PlatformDispatchConfig,
  deps: DispatchDeps,
  signal: AbortSignal,
): DispatchLoop {
  const done = (async () => {
    deps.logger.info(
      {
        platformId: config.platformId,
        concurrency: config.concurrency,
        pollIntervalMs: config.pollIntervalMs,
      },
      'dispatch loop started',
    );

    while (!signal.aborted) {
      let result: DispatchTickResult = { claimed: 0, resolved: 0, fencedOut: 0 };
      try {
        result = await dispatchTick(config, deps);
      } catch (error) {
        // A database blip must not kill the loop; the next tick tries again.
        deps.logger.error(
          { platformId: config.platformId, err: error },
          'dispatch tick failed; retrying after the poll interval',
        );
      }

      // A full batch means there is probably more waiting, so go straight round
      // again; that is what keeps p95 lag low when a minute's worth lands at once.
      if (result.claimed >= config.concurrency && !signal.aborted) continue;
      if (signal.aborted) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.pollIntervalMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    deps.logger.info({ platformId: config.platformId }, 'dispatch loop stopped');
  })();

  return { platformId: config.platformId, done };
}
