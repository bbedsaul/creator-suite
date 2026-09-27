/**
 * Webhook delivery (contract §7, D-014).
 *
 * Claims outbox rows, signs the public envelope, POSTs it, and retries with
 * exponential backoff for up to 24 hours. Delivery is at-least-once by design:
 * a slow consumer that returns 200 after we time out gets the event again, and the
 * contract requires consumers to dedupe on `event_id` rather than us pretending to
 * be exactly-once.
 *
 * `claim_webhook_events` bumps `next_attempt_at` forward as its lease, so a row
 * being worked on is invisible to another worker. That means every exit path from
 * here must set `next_attempt_at` deliberately — leaving it at the lease value
 * would retry in one minute regardless of the backoff schedule.
 */
import type { Sql } from 'postgres';
import {
  SIGNATURE_HEADER,
  formatSignatureHeader,
  type WebhookEnvelope,
} from '@suite/poster-contract';
import { signWebhook, type SecretsManager } from '@suite/server-core';
import { buildWebhookEnvelope, type OutboxRow } from './webhook-envelope.js';
import type { DispatchLoopLogger } from './dispatch-loop.js';

export interface DeliverConfig {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /** Lease while a row is being delivered. */
  readonly leaseMs: number;
  /** Per-request deadline. */
  readonly timeoutMs: number;
  /** Stop retrying after this long from `occurred_at` (§7 says 24 h). */
  readonly giveUpAfterMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface DeliverDeps {
  readonly sql: Sql;
  readonly secrets: SecretsManager;
  readonly logger: DispatchLoopLogger;
  /** Injected so tests do not need a real network. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface DeliverTickResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly gaveUp: number;
  readonly unroutable: number;
}

interface ClaimedEvent extends OutboxRow {
  readonly app_id: string;
  readonly attempt_count: number;
}

const EMPTY: DeliverTickResult = {
  claimed: 0,
  delivered: 0,
  retried: 0,
  gaveUp: 0,
  unroutable: 0,
};

/** Exponential with a ceiling: base * 2^(attempt-1), capped. */
export function backoffMs(attempt: number, config: DeliverConfig): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(config.maxBackoffMs, config.baseBackoffMs * 2 ** exponent);
}

export async function deliverTick(
  config: DeliverConfig,
  deps: DeliverDeps,
): Promise<DeliverTickResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;

  const claimed = await deps.sql<ClaimedEvent[]>`
    select e.id, e.app_id, e.type, e.occurred_at, e.post_id, e.target_id,
           e.external_ref, e.payload, e.attempt_count
      from poster.claim_webhook_events(
        ${config.batchSize},
        ${`${String(Math.round(config.leaseMs / 1000))} seconds`}::interval
      ) e`;

  if (claimed.length === 0) return EMPTY;

  const counts = { delivered: 0, retried: 0, gaveUp: 0, unroutable: 0 };

  for (const event of claimed) {
    try {
      const apps = await deps.sql<
        { webhook_url: string | null; webhook_secret_ref: string | null }[]
      >`
        select webhook_url, webhook_secret_ref from poster.client_apps where id = ${event.app_id}`;
      const app = apps[0];

      if (app?.webhook_url == null || app.webhook_secret_ref == null) {
        // Nowhere to send it. Not "delivered" — that would be a lie — and not a
        // retry either, because nothing about waiting will conjure a URL. The row
        // is closed with a reason so the backlog does not grow forever (D-077).
        await deps.sql`
          update poster.webhook_events
             set gave_up_at = now(), last_error = 'app has no webhook_url configured'
           where id = ${event.id}`;
        counts.unroutable += 1;
        continue;
      }

      const envelope: WebhookEnvelope = buildWebhookEnvelope(event);
      // Signed over exactly the bytes sent: serialise once and reuse the string.
      const rawBody = JSON.stringify(envelope);
      const timestamp = Math.floor(Date.now() / 1000);
      const secret = await deps.secrets.get(app.webhook_secret_ref);

      let status = 0;
      let error: string | null = null;
      try {
        const response = await doFetch(app.webhook_url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: formatSignatureHeader(
              timestamp,
              signWebhook(secret, timestamp, rawBody),
            ),
          },
          body: rawBody,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        status = response.status;
        if (status < 200 || status >= 300) error = `consumer returned ${String(status)}`;
      } catch (cause) {
        // A timeout is not a failure to deliver: the consumer may have processed it
        // and been slow to answer. Retrying is correct, and the consumer's dedupe
        // is what makes that safe (§7).
        error = cause instanceof Error ? `request failed: ${cause.message}` : 'request failed';
      }

      if (error === null) {
        await deps.sql`
          update poster.webhook_events set delivered_at = now(), last_error = null
           where id = ${event.id}`;
        counts.delivered += 1;
        continue;
      }

      const ageMs = Date.now() - event.occurred_at.getTime();
      if (ageMs >= config.giveUpAfterMs) {
        await deps.sql`
          update poster.webhook_events set gave_up_at = now(), last_error = ${error}
           where id = ${event.id}`;
        deps.logger.warn(
          { eventId: event.id, type: event.type, attempts: event.attempt_count },
          'gave up delivering a webhook after the retry window',
        );
        counts.gaveUp += 1;
        continue;
      }

      const delay = backoffMs(event.attempt_count, config);
      await deps.sql`
        update poster.webhook_events
           set next_attempt_at = now() + ${`${String(Math.round(delay / 1000))} seconds`}::interval,
               last_error = ${error}
         where id = ${event.id}`;
      counts.retried += 1;
    } catch (cause) {
      // Something unexpected, e.g. the secret could not be resolved. Leave the
      // lease to expire rather than losing the event.
      deps.logger.error(
        { eventId: event.id, err: cause },
        'webhook delivery failed before a verdict; it will be retried',
      );
    }
  }

  return { claimed: claimed.length, ...counts };
}

export interface DeliverLoop {
  readonly done: Promise<void>;
}

export function startDeliverLoop(
  config: DeliverConfig,
  deps: DeliverDeps,
  signal: AbortSignal,
): DeliverLoop {
  const done = (async () => {
    deps.logger.info({ pollIntervalMs: config.pollIntervalMs }, 'webhook deliverer started');

    while (!signal.aborted) {
      let result = EMPTY;
      try {
        result = await deliverTick(config, deps);
        if (result.claimed > 0) deps.logger.info({ ...result }, 'webhook delivery pass complete');
      } catch (error) {
        deps.logger.error({ err: error }, 'webhook delivery tick failed; retrying');
      }

      // A full batch probably means more is waiting.
      if (result.claimed >= config.batchSize && !signal.aborted) continue;
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

    deps.logger.info({}, 'webhook deliverer stopped');
  })();

  return { done };
}
