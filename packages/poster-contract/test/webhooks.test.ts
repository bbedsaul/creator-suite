/**
 * Webhook schemas (contract §7).
 *
 * The §7 table has seven rows, but connection.revoked / connection.restored share
 * one, so there are eight type strings. Every one must have a schema branch, or a
 * type the database can emit would have no specification.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_MAX_AGE_S,
  WEBHOOK_EVENT_TYPES,
  WebhookEnvelope,
  WebhookEvent,
  formatSignatureHeader,
  parseSignatureHeader,
  signedPayload,
} from '../src/webhooks.js';

const base = {
  event_id: 'ev_0123456789ABCDEFGHJKMNPQRS',
  occurred_at: '2026-09-26T12:00:00.000Z',
  post_id: 'po_0123456789ABCDEFGHJKMNPQRS',
  target_id: 'tg_0123456789ABCDEFGHJKMNPQRS',
  external_ref: 'lesson_42/clip_3',
  state: 'posted' as const,
};

/** One valid example per documented type. */
const EXAMPLES: Record<(typeof WEBHOOK_EVENT_TYPES)[number], unknown> = {
  'post.scheduled': {
    ...base,
    state: 'scheduled',
    type: 'post.scheduled',
    data: { schedule_at: base.occurred_at },
  },
  'post.posted': {
    ...base,
    type: 'post.posted',
    data: { permalink: 'https://tiktok.com/@x/video/1', platform_post_id: '123' },
  },
  'post.failed': {
    ...base,
    state: 'failed',
    type: 'post.failed',
    data: { reason_class: 'platform_rejected', platform_message: 'Caption too long' },
  },
  'post.paused': {
    ...base,
    state: 'paused',
    type: 'post.paused',
    data: { connection_id: 'cn_0123456789ABCDEFGHJKMNPQRS' },
  },
  'post.resumed': { ...base, state: 'scheduled', type: 'post.resumed', data: {} },
  'grant.updated': {
    ...base,
    post_id: null,
    target_id: null,
    state: null,
    type: 'grant.updated',
    data: {
      grant_id: 'gr_0123456789ABCDEFGHJKMNPQRS',
      user_id: '11111111-1111-4111-8111-111111111111',
      connection_id: 'cn_0123456789ABCDEFGHJKMNPQRS',
      scopes: ['publish'],
      revoked: false,
    },
  },
  'connection.revoked': {
    ...base,
    post_id: null,
    target_id: null,
    state: null,
    type: 'connection.revoked',
    data: { connection_id: 'cn_0123456789ABCDEFGHJKMNPQRS', platform: 'tiktok' },
  },
  'connection.restored': {
    ...base,
    post_id: null,
    target_id: null,
    state: null,
    type: 'connection.restored',
    data: { connection_id: 'cn_0123456789ABCDEFGHJKMNPQRS', platform: 'tiktok' },
  },
};

describe('event types', () => {
  it('covers the eight type strings in the §7 table (seven rows)', () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([
      'post.scheduled',
      'post.posted',
      'post.failed',
      'post.paused',
      'post.resumed',
      'grant.updated',
      'connection.revoked',
      'connection.restored',
    ]);
  });

  it('documents every type in the contract', () => {
    const doc = readFileSync(
      fileURLToPath(
        new URL('../../../docs/social-poster-internal-api-contract.md', import.meta.url),
      ),
      'utf8',
    );
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(doc, `§7 does not mention ${type}`).toContain(`\`${type}\``);
    }
  });

  it('has an example for every type, so none is untested', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
  });
});

describe('WebhookEvent', () => {
  it.each(WEBHOOK_EVENT_TYPES)('validates a %s payload', (type) => {
    const parsed = WebhookEvent.safeParse(EXAMPLES[type]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('narrows data by type, so a consumer cannot read the wrong fields', () => {
    const parsed = WebhookEvent.parse(EXAMPLES['post.failed']);
    if (parsed.type === 'post.failed') {
      expect(parsed.data.reason_class).toBe('platform_rejected');
    } else {
      expect.unreachable();
    }
  });

  it('rejects a payload whose data belongs to another type', () => {
    const wrong = { ...(EXAMPLES['post.posted'] as object), type: 'post.failed' };
    expect(WebhookEvent.safeParse(wrong).success).toBe(false);
  });

  it('rejects an unknown reason_class, which would be a new enum nobody declared', () => {
    const wrong = {
      ...(EXAMPLES['post.failed'] as { data: object }),
      data: { reason_class: 'invented', platform_message: null },
    };
    expect(WebhookEvent.safeParse(wrong).success).toBe(false);
  });

  it('requires event_id, because dedupe depends on it', () => {
    const withoutEventId = Object.fromEntries(
      Object.entries(EXAMPLES['post.posted'] as Record<string, unknown>).filter(
        ([key]) => key !== 'event_id',
      ),
    );
    expect(WebhookEvent.safeParse(withoutEventId).success).toBe(false);
  });
});

describe('WebhookEnvelope', () => {
  it('accepts every documented type too', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(WebhookEnvelope.safeParse(EXAMPLES[type]).success).toBe(true);
    }
  });

  it('tolerates a type it has never heard of (§1, §10)', () => {
    // Clients must ignore unknown event types rather than reject the delivery.
    const future = { ...(EXAMPLES['post.posted'] as object), type: 'post.teleported' };
    expect(WebhookEnvelope.safeParse(future).success).toBe(true);
  });
});

describe('signature header', () => {
  it('round-trips', () => {
    const header = formatSignatureHeader(1_800_000_000, 'abc123');
    expect(parseSignatureHeader(header)).toEqual({ timestamp: 1_800_000_000, v1: 'abc123' });
  });

  it('tolerates spacing and extra parts', () => {
    expect(parseSignatureHeader('t=17, v1=beef, v2=ignored')).toEqual({
      timestamp: 17,
      v1: 'beef',
    });
  });

  it('returns undefined for anything malformed, rather than throwing', () => {
    for (const header of [
      undefined,
      '',
      'garbage',
      't=abc,v1=beef',
      't=1',
      'v1=beef',
      't=0,v1=beef',
    ]) {
      expect(parseSignatureHeader(header)).toBeUndefined();
    }
  });

  it('rejects a non-hex signature', () => {
    expect(parseSignatureHeader('t=1,v1=nothex!')).toBeUndefined();
  });

  it('signs timestamp and body joined by a dot, per §7', () => {
    expect(signedPayload(17, '{"a":1}')).toBe('17.{"a":1}');
  });

  it('uses the five minute replay window the contract specifies', () => {
    expect(SIGNATURE_MAX_AGE_S).toBe(300);
  });
});
