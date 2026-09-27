/**
 * The reference webhook consumer.
 *
 * Deliberately a separate package with no dependency on the service: it is meant
 * to show what a *third party* has to do, and anything it could reach inside the
 * Poster would be a shortcut a real integrator does not have. `pnpm lint:deps`
 * enforces that (D-079).
 *
 * The three things every consumer must do, per contract §7:
 *
 *   1. Verify `X-Poster-Signature` over the **raw body**, not a re-serialisation.
 *      Parsing and re-encoding JSON changes bytes and breaks the HMAC.
 *   2. Reject a timestamp older than five minutes, so a captured delivery cannot
 *      be replayed later.
 *   3. Deduplicate on `event_id`, because delivery is at-least-once. A retry after
 *      a slow 200 is normal, not exceptional.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  SIGNATURE_HEADER,
  SIGNATURE_MAX_AGE_S,
  WebhookEnvelope,
  parseSignatureHeader,
} from '@suite/poster-contract';
import { verifyWebhook } from '@suite/server-core';

export type RejectionReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'expired'
  | 'future'
  | 'bad_signature'
  | 'malformed_body';

export interface ReceivedEvent {
  readonly eventId: string;
  readonly type: string;
  readonly body: unknown;
  /** True when this event_id had already been seen and was ignored. */
  readonly duplicate: boolean;
}

export interface WebhookSinkOptions {
  readonly secret: string;
  /**
   * Status codes to return, consumed in order; the last repeats. Lets a test make
   * the sink fail a few times before accepting, which is how retry behaviour gets
   * exercised without waiting on a real outage.
   */
  readonly responses?: readonly number[];
  readonly maxAgeS?: number;
  readonly nowS?: () => number;
}

export interface WebhookSink {
  readonly server: Server;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  /** Accepted events, in arrival order, including duplicates (flagged). */
  readonly received: readonly ReceivedEvent[];
  /** Distinct event ids that were accepted — what actually got processed. */
  processedIds(): string[];
  readonly rejected: readonly { reason: RejectionReason; status: number }[];
  /** How many requests arrived, whatever the outcome. */
  requestCount(): number;
  reset(): void;
}

function readRawBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function createWebhookSink(options: WebhookSinkOptions): WebhookSink {
  const received: ReceivedEvent[] = [];
  const rejected: { reason: RejectionReason; status: number }[] = [];
  /** Processed event ids. A real consumer persists this; a reference one need not. */
  const seen = new Set<string>();
  const responses = [...(options.responses ?? [200])];
  const maxAgeS = options.maxAgeS ?? SIGNATURE_MAX_AGE_S;
  let requests = 0;
  let responseIndex = 0;

  function nextStatus(): number {
    const status = responses[Math.min(responseIndex, responses.length - 1)] ?? 200;
    responseIndex += 1;
    return status;
  }

  function reject(response: ServerResponse, reason: RejectionReason, status: number): void {
    rejected.push({ reason, status });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ rejected: reason }));
  }

  const server = createServer((request, response) => {
    void (async () => {
      requests += 1;

      // Raw bytes: the signature covers exactly what was sent.
      const rawBody = await readRawBody(request);

      const parsed = parseSignatureHeader(request.headers[SIGNATURE_HEADER] as string | undefined);
      if (request.headers[SIGNATURE_HEADER] === undefined) {
        reject(response, 'missing_signature', 401);
        return;
      }
      if (parsed === undefined) {
        reject(response, 'malformed_signature', 401);
        return;
      }

      const verification = verifyWebhook({
        secret: options.secret,
        timestamp: parsed.timestamp,
        rawBody,
        signature: parsed.v1,
        maxAgeS,
        ...(options.nowS === undefined ? {} : { nowS: options.nowS() }),
      });
      if (!verification.ok) {
        // 401 for a bad signature, 400 for a stale one: the first is "I do not
        // believe you", the second "I believe you but this is too old".
        reject(response, verification.reason, verification.reason === 'bad_signature' ? 401 : 400);
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        reject(response, 'malformed_body', 400);
        return;
      }

      const envelope = WebhookEnvelope.safeParse(body);
      if (!envelope.success) {
        reject(response, 'malformed_body', 400);
        return;
      }

      const duplicate = seen.has(envelope.data.event_id);
      seen.add(envelope.data.event_id);
      received.push({
        eventId: envelope.data.event_id,
        type: envelope.data.type,
        body,
        duplicate,
      });

      // The scripted status applies even to a duplicate: a consumer that 500s on a
      // retry is exactly the case the sender's backoff exists for.
      const status = nextStatus();
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: status < 300, duplicate }));
    })();
  });

  return {
    server,

    listen(port = 0) {
      return new Promise((resolve, reject_) => {
        server.once('error', reject_);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          if (typeof address !== 'object' || address === null) {
            reject_(new Error('sink did not bind a port'));
            return;
          }
          resolve(address.port);
        });
      });
    },

    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },

    received,
    rejected,

    processedIds() {
      return [...seen];
    },

    requestCount() {
      return requests;
    },

    reset() {
      received.length = 0;
      rejected.length = 0;
      seen.clear();
      requests = 0;
      responseIndex = 0;
    },
  };
}
