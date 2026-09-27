/**
 * Webhook signing and verification (contract §7).
 *
 * The signer and the verifier must agree byte for byte, and the replay window must
 * be enforced before anything else, so a captured-but-valid delivery cannot be
 * replayed a day later.
 */
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from '../src/webhook-signature.js';

const SECRET = 'per-app-webhook-secret';
const BODY = '{"event_id":"ev_1","type":"post.posted"}';
const NOW = 1_800_000_000;

function verify(over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) {
  return verifyWebhook({
    secret: SECRET,
    timestamp: NOW,
    rawBody: BODY,
    signature: signWebhook(SECRET, NOW, BODY),
    maxAgeS: 300,
    nowS: NOW,
    ...over,
  });
}

describe('signWebhook', () => {
  it('covers timestamp and body together, per §7', () => {
    // Changing either must change the signature, or a body could be swapped
    // between timestamps.
    const base = signWebhook(SECRET, NOW, BODY);
    expect(signWebhook(SECRET, NOW + 1, BODY)).not.toBe(base);
    expect(signWebhook(SECRET, NOW, `${BODY} `)).not.toBe(base);
  });

  it('is deterministic and hex', () => {
    expect(signWebhook(SECRET, NOW, BODY)).toBe(signWebhook(SECRET, NOW, BODY));
    expect(signWebhook(SECRET, NOW, BODY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the secret, so one app cannot sign for another', () => {
    expect(signWebhook('other-secret', NOW, BODY)).not.toBe(signWebhook(SECRET, NOW, BODY));
  });
});

describe('verifyWebhook', () => {
  it('accepts a fresh, correctly signed delivery', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it('accepts one right at the edge of the window', () => {
    expect(verify({ nowS: NOW + 300 })).toEqual({ ok: true });
  });

  it('rejects one past the window as expired', () => {
    expect(verify({ nowS: NOW + 301 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a replay a day later even though the signature is valid', () => {
    // The whole point of the timestamp: the signature never stops being correct.
    expect(verify({ nowS: NOW + 86_400 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a timestamp far in the future', () => {
    expect(verify({ nowS: NOW - 3_600 })).toEqual({ ok: false, reason: 'future' });
  });

  it('rejects a tampered body', () => {
    expect(verify({ rawBody: `${BODY.slice(0, -1)},"extra":1}` })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a body that differs only in whitespace, because bytes are what is signed', () => {
    expect(verify({ rawBody: `{"event_id":"ev_1", "type":"post.posted"}` })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects the wrong secret', () => {
    expect(verify({ signature: signWebhook('wrong', NOW, BODY) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature reused with a different timestamp', () => {
    expect(verify({ timestamp: NOW + 5, nowS: NOW + 5 })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects malformed signatures without throwing', () => {
    for (const signature of ['', 'nothex', 'ab', 'f'.repeat(64)]) {
      expect(verify({ signature }).ok).toBe(false);
    }
  });
});
