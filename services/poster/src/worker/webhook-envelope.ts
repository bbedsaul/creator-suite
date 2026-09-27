/**
 * Turns an outbox row into the public webhook body (contract §7, D-014).
 *
 * The triggers that write the outbox store **internal uuids** — they are database
 * triggers and have no business knowing about prefixed ids. Translating them is
 * this module's whole job, and it is the reason the envelope is built here rather
 * than in SQL: rule 7 says prefixed ids appear only at the boundary, via one
 * encode/decode module.
 *
 * Any id field this does not know about is left alone, which is the safe default:
 * a new event type added by a trigger will deliver with a raw uuid rather than
 * crash the deliverer, and the mismatch shows up in a schema test.
 */
import { encodeId, type WebhookEnvelope } from '@suite/poster-contract';

export interface OutboxRow {
  readonly id: string;
  readonly type: string;
  readonly occurred_at: Date;
  readonly post_id: string | null;
  readonly target_id: string | null;
  readonly external_ref: string | null;
  readonly payload: { state?: string | null; data?: Record<string, unknown> } | null;
}

/** Which data fields hold an internal uuid, and what kind of id each becomes. */
const DATA_ID_FIELDS: Readonly<Record<string, 'connection' | 'grant'>> = {
  connection_id: 'connection',
  grant_id: 'grant',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const kind = DATA_ID_FIELDS[key];
    // Only encode when it really is a uuid: `user_id` stays a uuid on the wire
    // everywhere else in the API, and re-encoding an already-public id would
    // double-prefix it.
    out[key] =
      kind !== undefined && typeof value === 'string' && UUID_RE.test(value)
        ? encodeId(kind, value)
        : value;
  }
  return out;
}

export function buildWebhookEnvelope(row: OutboxRow): WebhookEnvelope {
  const state = row.payload?.state ?? null;

  return {
    event_id: encodeId('event', row.id),
    type: row.type,
    occurred_at: row.occurred_at.toISOString(),
    post_id: row.post_id === null ? null : encodeId('post', row.post_id),
    target_id: row.target_id === null ? null : encodeId('target', row.target_id),
    external_ref: row.external_ref,
    state: state as WebhookEnvelope['state'],
    data: publicData(row.payload?.data ?? {}),
  };
}
