/**
 * Reconciliation: deciding what happened to a dispatch nobody came back from
 * (D-012, CLAUDE.md rule 3).
 *
 * A worker that dies mid-call leaves its target in `dispatching`. That row is
 * never re-dispatched — only `scheduled` rows are claimable — so something has to
 * ask the platform what actually happened. That is this loop:
 *
 *   1. `mark_stale_dispatches()` flags targets whose lease has expired.
 *   2. For each flagged target, `lookup(attemptRef)` asks the provider.
 *   3. The answer is applied through `finish_dispatch`, impersonating the dead
 *      worker via `p_worker => claimed_by`, because the fence checks exactly that.
 *
 * The mapping is the whole safety argument:
 *
 *   found   -> success   The post landed. Recording it is the only correct move.
 *   absent  -> transient Provably not posted, so a retry cannot duplicate.
 *   unknown -> unknown   finish_dispatch sees needs_reconciliation already set and
 *                        fails the target `dispatch_outcome_unknown`. A rare
 *                        visible failure beats a silent duplicate.
 *
 * Note step 1 flags only rows that are not already flagged, so a target this loop
 * flagged but did not finish resolving — because the reconciler itself died —
 * would never be returned again. Hence the separate sweep of already-flagged rows:
 * without it, "nothing stays stuck in dispatching" would be false in exactly the
 * case reconciliation exists for.
 */
import type { Sql } from 'postgres';
import type { LookupOutcome, PlatformAdapter } from '../adapters/adapter.js';
import type { CredentialVault } from '../vault/credentials.js';
import type { DispatchLoopLogger } from './dispatch-loop.js';

export interface ReconcileConfig {
  /** How many stale targets to resolve per tick. */
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /** Deadline for a lookup call. */
  readonly lookupTimeoutMs: number;
}

export interface ReconcileDeps {
  readonly sql: Sql;
  readonly vault: CredentialVault;
  readonly adapterFor: (platformId: string) => PlatformAdapter;
  readonly logger: DispatchLoopLogger;
}

export interface ReconcileTickResult {
  readonly flagged: number;
  readonly examined: number;
  readonly posted: number;
  readonly retried: number;
  readonly failedUnknown: number;
  readonly fencedOut: number;
}

interface StaleTarget {
  id: string;
  post_id: string;
  connection_id: string;
  platform_id: string;
  claimed_by: string | null;
  attempt_count: number;
}

const EMPTY: ReconcileTickResult = {
  flagged: 0,
  examined: 0,
  posted: 0,
  retried: 0,
  failedUnknown: 0,
  fencedOut: 0,
};

/**
 * Resolves one flagged target.
 *
 * Returns which branch it took, so a caller can assert on the mix rather than
 * just "it did something".
 */
async function reconcileOne(
  target: StaleTarget,
  config: ReconcileConfig,
  deps: ReconcileDeps,
): Promise<'posted' | 'retried' | 'failedUnknown' | 'fencedOut'> {
  // The dead worker still owns the lease, and finish_dispatch fences on exactly
  // this value. Impersonating it is deliberate, not a loophole.
  const worker = target.claimed_by;
  if (worker === null) {
    // A dispatching row with no claim should be impossible: the check constraint
    // on post_targets forbids it. Treat it as unresolvable rather than guess.
    deps.logger.error({ targetId: target.id }, 'dispatching target has no claim; leaving it');
    return 'fencedOut';
  }

  const attempts = await deps.sql<{ id: string; attempt_no: number }[]>`
    select id, attempt_no from poster.dispatch_attempts
     where target_id = ${target.id} and outcome = 'in_flight'
     order by attempt_no desc
     limit 1`;
  const attempt = attempts[0];

  let outcome: LookupOutcome;
  if (attempt === undefined) {
    // No in-flight attempt row means the adapter was never called: rule 4 puts
    // that row in *before* any publish. So nothing was sent, and a retry is safe.
    outcome = { kind: 'absent' };
  } else {
    try {
      const connections = await deps.sql<{ credential_id: string; external_account_id: string }[]>`
        select credential_id, external_account_id
          from poster.connections where id = ${target.connection_id}`;
      const connection = connections[0];
      if (connection === undefined) throw new Error('connection vanished');

      const credential = await deps.vault.open(connection.credential_id, {
        accessor: 'reconciler',
        purpose: 'dispatch',
        targetId: target.id,
      });

      outcome = await deps.adapterFor(target.platform_id).lookup({
        attemptRef: attempt.id,
        credential: {
          kind: credential.kind,
          provider: credential.provider,
          secret: credential.secret,
        },
        target: {
          targetId: target.id,
          platformId: target.platform_id,
          externalAccountId: connection.external_account_id,
          text: null,
          title: null,
        },
        timeoutMs: config.lookupTimeoutMs,
      });
    } catch (error) {
      // A lookup we could not perform tells us nothing, and `unknown` is the only
      // honest answer. Guessing `absent` here is how duplicates happen.
      deps.logger.error(
        { targetId: target.id, err: error },
        'lookup failed; treating the outcome as unknown',
      );
      outcome = { kind: 'unknown' };
    }
  }

  const attemptNo = attempt?.attempt_no ?? target.attempt_count;

  const finish = await deps.sql<{ finish_dispatch: boolean }[]>`
    select poster.finish_dispatch(
      ${target.id}::uuid,
      ${worker},
      ${attemptNo},
      ${outcome.kind === 'found' ? 'success' : outcome.kind === 'absent' ? 'transient' : 'unknown'}::poster.attempt_outcome,
      ${outcome.kind === 'found' ? (outcome.platformPostId ?? null) : null},
      ${outcome.kind === 'found' ? (outcome.permalink ?? null) : null},
      ${outcome.kind === 'unknown' ? 'reconciliation could not determine the outcome' : null},
      ${deps.sql.json({ reconciled: true, lookup: outcome.kind } as never)},
      ${null},
      ${null}
    ) as finish_dispatch`;

  if (finish[0]?.finish_dispatch !== true) {
    // Someone else resolved it between our flag and our finish. Not an error.
    deps.logger.warn({ targetId: target.id }, 'reconciliation was fenced out');
    return 'fencedOut';
  }

  deps.logger.info(
    { targetId: target.id, platformId: target.platform_id, lookup: outcome.kind },
    'reconciled a stale dispatch',
  );

  switch (outcome.kind) {
    case 'found':
      return 'posted';
    case 'absent':
      return 'retried';
    case 'unknown':
      return 'failedUnknown';
  }
}

/**
 * One reconciliation pass. Exposed separately from the loop so tests can drive it
 * deterministically instead of racing a timer.
 */
export async function reconcileTick(
  config: ReconcileConfig,
  deps: ReconcileDeps,
): Promise<ReconcileTickResult> {
  const flagged = await deps.sql<{ id: string }[]>`
    select id from poster.mark_stale_dispatches()`;

  // Everything currently flagged, not just what this tick flagged: see the module
  // comment on why the two are different sets.
  const stale = await deps.sql<StaleTarget[]>`
    select id, post_id, connection_id, platform_id, claimed_by, attempt_count
      from poster.post_targets
     where state = 'dispatching' and needs_reconciliation
     order by claim_expires_at
     limit ${config.batchSize}`;

  if (stale.length === 0) return { ...EMPTY, flagged: flagged.length };

  const counts = { posted: 0, retried: 0, failedUnknown: 0, fencedOut: 0 };
  for (const target of stale) {
    try {
      counts[await reconcileOne(target, config, deps)] += 1;
    } catch (error) {
      // Left flagged, so the next tick tries again rather than abandoning it.
      deps.logger.error(
        { targetId: target.id, err: error },
        'reconciliation threw; the target stays flagged for the next tick',
      );
    }
  }

  return { flagged: flagged.length, examined: stale.length, ...counts };
}

export interface ReconcileLoop {
  readonly done: Promise<void>;
}

/**
 * Starts the reconciler. One loop for the whole worker rather than one per
 * platform: it is not on the hot path, and a stale target is rare by construction.
 */
export function startReconcileLoop(
  config: ReconcileConfig,
  deps: ReconcileDeps,
  signal: AbortSignal,
): ReconcileLoop {
  const done = (async () => {
    deps.logger.info({ pollIntervalMs: config.pollIntervalMs }, 'reconciler started');

    while (!signal.aborted) {
      try {
        const result = await reconcileTick(config, deps);
        if (result.examined > 0) {
          deps.logger.info({ ...result }, 'reconciliation pass complete');
        }
      } catch (error) {
        deps.logger.error({ err: error }, 'reconciliation tick failed; retrying');
      }

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

    deps.logger.info({}, 'reconciler stopped');
  })();

  return { done };
}
