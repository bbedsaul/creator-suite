/**
 * Building the public webhook body from an outbox row (D-014).
 *
 * The triggers store internal uuids; the wire carries prefixed ids (rule 7). This
 * translation is the only place that happens, so it is worth pinning down.
 */
import { describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId, WebhookEvent } from '@suite/poster-contract';
import { buildWebhookEnvelope, type OutboxRow } from '../src/worker/webhook-envelope.js';
import { backoffMs } from '../src/worker/deliver-loop.js';

const uuids = {
  event: '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a01',
  post: '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a02',
  target: '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a03',
  connection: '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a04',
  grant: '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a05',
  user: '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a06',
};

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: uuids.event,
    type: 'post.posted',
    occurred_at: new Date('2026-09-26T12:00:00.000Z'),
    post_id: uuids.post,
    target_id: uuids.target,
    external_ref: 'lesson_42/clip_3',
    payload: { state: 'posted', data: { permalink: 'https://x.test/1', platform_post_id: '9' } },
    ...over,
  };
}

describe('buildWebhookEnvelope', () => {
  it('encodes the event, post and target ids', () => {
    const envelope = buildWebhookEnvelope(row());

    expect(envelope.event_id).toBe(encodeId('event', uuids.event));
    expect(envelope.post_id).toBe(encodeId('post', uuids.post));
    expect(envelope.target_id).toBe(encodeId('target', uuids.target));
    // No raw uuid reaches the wire (rule 7).
    expect(JSON.stringify(envelope)).not.toContain(uuids.event);
  });

  it('produces something the contract schema accepts', () => {
    expect(WebhookEvent.safeParse(buildWebhookEnvelope(row())).success).toBe(true);
  });

  it('carries external_ref through untouched, so a client needs no lookup table', () => {
    expect(buildWebhookEnvelope(row()).external_ref).toBe('lesson_42/clip_3');
  });

  it('formats occurred_at as ISO 8601 UTC', () => {
    expect(buildWebhookEnvelope(row()).occurred_at).toBe('2026-09-26T12:00:00.000Z');
  });

  it('encodes connection_id inside data', () => {
    const envelope = buildWebhookEnvelope(
      row({
        type: 'post.paused',
        payload: { state: 'paused', data: { connection_id: uuids.connection } },
      }),
    );
    expect(envelope.data['connection_id']).toBe(encodeId('connection', uuids.connection));
    expect(tryDecodeId('connection', envelope.data['connection_id'] as string)).toBe(
      uuids.connection,
    );
  });

  it('encodes grant_id but leaves user_id a uuid, as it is everywhere else in the API', () => {
    const envelope = buildWebhookEnvelope(
      row({
        type: 'grant.updated',
        post_id: null,
        target_id: null,
        payload: {
          state: null,
          data: {
            grant_id: uuids.grant,
            user_id: uuids.user,
            connection_id: uuids.connection,
            scopes: ['publish'],
            revoked: false,
          },
        },
      }),
    );

    expect(envelope.data['grant_id']).toBe(encodeId('grant', uuids.grant));
    expect(envelope.data['user_id']).toBe(uuids.user);
    expect(WebhookEvent.safeParse(envelope).success).toBe(true);
  });

  it('leaves a non-uuid value in an id field alone rather than double-encoding it', () => {
    const envelope = buildWebhookEnvelope(
      row({
        payload: { state: 'posted', data: { connection_id: 'cn_ALREADYPUBLIC0000000000AB' } },
      }),
    );
    expect(envelope.data['connection_id']).toBe('cn_ALREADYPUBLIC0000000000AB');
  });

  it('handles a null payload and null ids without throwing', () => {
    const envelope = buildWebhookEnvelope(
      row({ payload: null, post_id: null, target_id: null, external_ref: null }),
    );
    expect(envelope).toMatchObject({ post_id: null, target_id: null, state: null, data: {} });
  });
});

describe('backoffMs', () => {
  const config = {
    batchSize: 10,
    pollIntervalMs: 1000,
    leaseMs: 60_000,
    timeoutMs: 5_000,
    giveUpAfterMs: 86_400_000,
    baseBackoffMs: 10_000,
    maxBackoffMs: 3_600_000,
  };

  it('doubles per attempt', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, config))).toEqual([10_000, 20_000, 40_000, 80_000]);
  });

  it('caps, so a long-dead consumer is retried hourly rather than yearly', () => {
    expect(backoffMs(30, config)).toBe(config.maxBackoffMs);
  });

  it('treats a zeroth attempt as the base delay', () => {
    expect(backoffMs(0, config)).toBe(10_000);
  });

  it('stays inside the 24 hour window for the first several attempts', () => {
    // Roughly: a consumer down for a day gets tried a couple of dozen times, not
    // thousands and not twice.
    let total = 0;
    let attempts = 0;
    while (total < config.giveUpAfterMs) {
      attempts += 1;
      total += backoffMs(attempts, config);
    }
    expect(attempts).toBeGreaterThan(10);
    expect(attempts).toBeLessThan(40);
  });
});
