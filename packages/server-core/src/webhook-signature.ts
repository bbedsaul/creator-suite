/**
 * HMAC signing and verification for outbound webhooks (contract §7).
 *
 * Both halves live together on purpose: the signer and the reference consumer must
 * agree byte for byte, and splitting them across packages is how that drifts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of `${timestamp}.${rawBody}` under `secret`. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${rawBody}`, 'utf8')
    .digest('hex');
}

export interface VerifyWebhookOptions {
  readonly secret: string;
  readonly timestamp: number;
  readonly rawBody: string;
  readonly signature: string;
  /** Seconds a signature stays valid. Contract §7 says 300. */
  readonly maxAgeS: number;
  /** Injectable clock, so replay-window tests do not sleep. */
  readonly nowS?: number;
}

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'expired' | 'bad_signature' | 'future' };

/**
 * Verifies a webhook signature and its age.
 *
 * Compared in constant time: a fast-failing comparison leaks the correct prefix a
 * byte at a time, which is enough to forge a signature given patience.
 */
export function verifyWebhook(options: VerifyWebhookOptions): WebhookVerification {
  const now = options.nowS ?? Math.floor(Date.now() / 1000);
  const age = now - options.timestamp;

  // Replay window (§7). Checked before the HMAC so an old-but-valid capture is
  // rejected on age alone.
  if (age > options.maxAgeS) return { ok: false, reason: 'expired' };
  // A timestamp meaningfully in the future is either a broken clock or someone
  // trying to mint a signature that stays valid for a long time.
  if (age < -options.maxAgeS) return { ok: false, reason: 'future' };

  const expected = Buffer.from(
    signWebhook(options.secret, options.timestamp, options.rawBody),
    'utf8',
  );
  const provided = Buffer.from(options.signature, 'utf8');

  if (expected.length !== provided.length) return { ok: false, reason: 'bad_signature' };
  return timingSafeEqual(expected, provided)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
