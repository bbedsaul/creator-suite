/**
 * The reference consumer's three obligations (contract §7).
 *
 * This doubles as the worked example an integrator copies, so each test is written
 * as the thing a real consumer must get right rather than as coverage.
 */
import { signWebhook } from '@suite/server-core';
import { formatSignatureHeader, SIGNATURE_HEADER } from '@suite/poster-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebhookSink, type WebhookSink } from '../src/index.js';

const SECRET = 'sink-test-secret';

let sink: WebhookSink | undefined;
let baseUrl = '';

afterEach(async () => {
  await sink?.close();
  sink = undefined;
});

async function start(options: Partial<Parameters<typeof createWebhookSink>[0]> = {}) {
  sink = createWebhookSink({ secret: SECRET, ...options });
  const port = await sink.listen();
  baseUrl = `http://127.0.0.1:${String(port)}`;
  return sink;
}

function event(id: string, type = 'post.posted'): string {
  return JSON.stringify({
    event_id: id,
    type,
    occurred_at: '2026-09-26T12:00:00.000Z',
    post_id: 'po_0123456789ABCDEFGHJKMNPQRS',
    target_id: 'tg_0123456789ABCDEFGHJKMNPQRS',
    external_ref: 'lesson_42/clip_3',
    state: 'posted',
    data: { permalink: 'https://fake.test/p/1', platform_post_id: 'pp-1' },
  });
}

async function post(
  body: string,
  options: { secret?: string; timestamp?: number; header?: string | null } = {},
): Promise<Response> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (options.header !== null) {
    headers[SIGNATURE_HEADER] =
      options.header ??
      formatSignatureHeader(timestamp, signWebhook(options.secret ?? SECRET, timestamp, body));
  }

  return fetch(baseUrl, { method: 'POST', headers, body });
}

describe('signature verification', () => {
  it('accepts a correctly signed delivery', async () => {
    await start();
    const response = await post(event('ev_1'));

    expect(response.status).toBe(200);
    expect(sink?.received).toHaveLength(1);
    expect(sink?.received[0]?.type).toBe('post.posted');
  });

  it('rejects a tampered body', async () => {
    await start();
    const body = event('ev_2');
    // Signed over the original, then the body is changed in flight.
    const timestamp = Math.floor(Date.now() / 1000);
    const header = formatSignatureHeader(timestamp, signWebhook(SECRET, timestamp, body));
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: header },
      body: body.replace('pp-1', 'pp-TAMPERED'),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ rejected: 'bad_signature' });
    expect(sink?.received).toHaveLength(0);
  });

  it('rejects a body signed with the wrong secret', async () => {
    await start();
    const response = await post(event('ev_3'), { secret: 'not-the-secret' });
    expect(response.status).toBe(401);
    expect(sink?.received).toHaveLength(0);
  });

  it('rejects a missing signature header', async () => {
    await start();
    const response = await post(event('ev_4'), { header: null });
    expect(response.status).toBe(401);
    expect(sink?.rejected[0]?.reason).toBe('missing_signature');
  });

  it('rejects a malformed signature header', async () => {
    await start();
    for (const header of ['garbage', 't=abc,v1=xyz', 'v1=deadbeef', 't=123']) {
      const response = await post(event('ev_5'), { header });
      expect(response.status).toBe(401);
    }
    expect(sink?.received).toHaveLength(0);
  });
});

describe('replay window', () => {
  it('rejects a delivery older than five minutes', async () => {
    await start();
    const stale = Math.floor(Date.now() / 1000) - 301;
    const response = await post(event('ev_6'), { timestamp: stale });

    // The signature is still valid; the age is what disqualifies it.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ rejected: 'expired' });
    expect(sink?.received).toHaveLength(0);
  });

  it('accepts one just inside the window', async () => {
    await start();
    const response = await post(event('ev_7'), { timestamp: Math.floor(Date.now() / 1000) - 290 });
    expect(response.status).toBe(200);
  });
});

describe('deduplication on event_id', () => {
  it('processes an event once however many times it arrives', async () => {
    await start();
    for (let i = 0; i < 4; i += 1) await post(event('ev_dupe'));

    // Delivery is at-least-once, so four arrivals is normal. What matters is that
    // the consumer processed one event.
    expect(sink?.requestCount()).toBe(4);
    expect(sink?.processedIds()).toEqual(['ev_dupe']);
    expect(sink?.received.filter((entry) => entry.duplicate)).toHaveLength(3);
  });

  it('reports duplicates in the response, which helps a sender debug', async () => {
    await start();
    expect(await (await post(event('ev_d2'))).json()).toEqual({ ok: true, duplicate: false });
    expect(await (await post(event('ev_d2'))).json()).toEqual({ ok: true, duplicate: true });
  });

  it('treats different event ids as different events', async () => {
    await start();
    await post(event('ev_a'));
    await post(event('ev_b'));
    expect(sink?.processedIds()).toEqual(['ev_a', 'ev_b']);
  });
});

describe('scripted responses', () => {
  it('fails the configured number of times, then accepts', async () => {
    await start({ responses: [500, 500, 500, 200] });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post(event('ev_retry'))).status);

    expect(statuses).toEqual([500, 500, 500, 200]);
    // It saw the event four times and processed it once.
    expect(sink?.processedIds()).toEqual(['ev_retry']);
  });
});

describe('body validation', () => {
  it('rejects a correctly signed body that is not JSON', async () => {
    await start();
    const response = await post('not json at all');
    expect(response.status).toBe(400);
    expect(sink?.rejected[0]?.reason).toBe('malformed_body');
  });

  it('rejects a signed JSON body that is not an envelope', async () => {
    await start();
    const response = await post(JSON.stringify({ hello: 'world' }));
    expect(response.status).toBe(400);
  });

  it('accepts an event type it has never heard of (§1, §10)', async () => {
    await start();
    // Clients must tolerate unknown types rather than rejecting the delivery.
    const response = await post(event('ev_future', 'post.teleported'));
    expect(response.status).toBe(200);
    expect(sink?.received[0]?.type).toBe('post.teleported');
  });
});
