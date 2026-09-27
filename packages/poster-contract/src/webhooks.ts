/**
 * Lifecycle webhooks (contract §7, D-014).
 *
 * Delivery is **at-least-once and unordered**. That is not a limitation to work
 * around, it is the contract: a consumer must deduplicate on `event_id` and treat
 * `state` as authoritative rather than inferring anything from arrival order. A
 * consumer that assumes ordering will eventually process a `post.posted` before
 * the `post.scheduled` that preceded it.
 *
 * Every id here is a public prefixed id. The database triggers that write the
 * outbox store internal uuids, and the delivery worker translates them — so these
 * schemas are also the specification of that translation.
 */
import { z } from 'zod';
import { ReasonClass, TargetState } from './posts.js';

/**
 * The §7 table has seven rows, but `connection.revoked` / `connection.restored`
 * share one, so there are eight type strings.
 */
export const WEBHOOK_EVENT_TYPES = [
  'post.scheduled',
  'post.posted',
  'post.failed',
  'post.paused',
  'post.resumed',
  'grant.updated',
  'connection.revoked',
  'connection.restored',
] as const;

export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

// ---------------------------------------------------------------------------
// Per-type data payloads
// ---------------------------------------------------------------------------

export const PostScheduledData = z
  .object({ schedule_at: z.string().describe('When this target is due to be sent.') })
  .describe('post.scheduled');

export const PostPostedData = z
  .object({
    permalink: z.string().nullable().describe('Null when the platform returns no link.'),
    platform_post_id: z.string().nullable(),
  })
  .describe('post.posted');

export const PostFailedData = z
  .object({
    reason_class: ReasonClass.describe('Machine-readable; switch on this, not the message.'),
    platform_message: z.string().nullable().describe("The platform's own words, verbatim."),
  })
  .describe('post.failed');

export const PostPausedData = z
  .object({ connection_id: z.string().describe('Public id of the connection that was revoked.') })
  .describe('post.paused');

export const PostResumedData = z.object({}).describe('post.resumed carries no extra data.');

export const GrantUpdatedData = z
  .object({
    grant_id: z.string(),
    user_id: z.string().uuid(),
    connection_id: z.string(),
    scopes: z.array(z.string()),
    revoked: z.boolean().describe('True when this update revoked the grant.'),
  })
  .describe('grant.updated carries the full grant state.');

export const ConnectionEventData = z
  .object({ connection_id: z.string(), platform: z.string() })
  .describe('connection.revoked / connection.restored');

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Fields every event carries, whatever its type. */
const envelopeBase = {
  event_id: z.string().describe('Public event id. Deduplicate on this.'),
  occurred_at: z.string().describe('ISO 8601 UTC, when the state change happened.'),
  post_id: z.string().nullable(),
  target_id: z.string().nullable(),
  external_ref: z
    .string()
    .nullable()
    .describe("The client's own id from submission, echoed so no lookup table is needed."),
  state: TargetState.nullable().describe('Authoritative target state; ignore arrival order.'),
};

/**
 * The delivered body, as a discriminated union on `type` so a consumer that
 * narrows on the type gets the right `data` shape.
 */
export const WebhookEvent = z
  .discriminatedUnion('type', [
    z.object({ ...envelopeBase, type: z.literal('post.scheduled'), data: PostScheduledData }),
    z.object({ ...envelopeBase, type: z.literal('post.posted'), data: PostPostedData }),
    z.object({ ...envelopeBase, type: z.literal('post.failed'), data: PostFailedData }),
    z.object({ ...envelopeBase, type: z.literal('post.paused'), data: PostPausedData }),
    z.object({ ...envelopeBase, type: z.literal('post.resumed'), data: PostResumedData }),
    z.object({ ...envelopeBase, type: z.literal('grant.updated'), data: GrantUpdatedData }),
    z.object({ ...envelopeBase, type: z.literal('connection.revoked'), data: ConnectionEventData }),
    z.object({
      ...envelopeBase,
      type: z.literal('connection.restored'),
      data: ConnectionEventData,
    }),
  ])
  .describe('A lifecycle webhook. At-least-once and unordered: dedupe on event_id.');
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/**
 * Loose envelope for consumers that want the common fields without narrowing.
 * Unknown types must be tolerated (§1, §10), so `type` is a plain string here.
 */
export const WebhookEnvelope = z
  .object({
    ...envelopeBase,
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
  })
  .describe('Any lifecycle webhook, including types this client does not know yet.');
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = 'x-poster-signature';

/** How long a signature stays acceptable (§7 replay window). */
export const SIGNATURE_MAX_AGE_S = 300;

/**
 * Parses `t=<unix>,v1=<hex>`.
 *
 * Returns undefined rather than throwing, because a malformed header is an
 * ordinary rejection for a consumer, not an exceptional condition.
 */
export function parseSignatureHeader(
  header: string | undefined,
): { timestamp: number; v1: string } | undefined {
  if (header === undefined) return undefined;

  let timestamp: number | undefined;
  let v1: string | undefined;

  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't' && value !== undefined) {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) timestamp = parsed;
    }
    if (key === 'v1' && value !== undefined && /^[0-9a-f]+$/i.test(value)) v1 = value;
  }

  return timestamp === undefined || v1 === undefined ? undefined : { timestamp, v1 };
}

/** The exact bytes the HMAC covers: `${timestamp}.${rawBody}` (§7). */
export function signedPayload(timestamp: number, rawBody: string): string {
  return `${String(timestamp)}.${rawBody}`;
}

export function formatSignatureHeader(timestamp: number, v1: string): string {
  return `t=${String(timestamp)},v1=${v1}`;
}
