/**
 * Canonical request hashing (FR-14).
 *
 * `Idempotency-Key` equality is decided by this hash, so two things must hold: a
 * body that differs only in key order is the *same* request, and a body that
 * differs in any value is a *different* one. Getting the first wrong turns a
 * harmless retry into 409; getting the second wrong lets a changed request quietly
 * return the old result.
 */
import { describe, expect, it } from 'vitest';
import { canonicalize, hashRequest } from '../src/db/posts.js';

describe('canonicalize', () => {
  it('orders object keys, so field order does not change identity', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('orders nested keys too', () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe(canonicalize({ x: { a: 2, b: 1 } }));
  });

  it('preserves array order, because target order is meaningful', () => {
    // targets[0] is target_index 0 in every §8 details entry.
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('drops undefined values, which JSON would have dropped anyway', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  it('does not confuse a number with its string form', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
  });
});

describe('hashRequest', () => {
  const submission = {
    user_id: '11111111-1111-4111-8111-111111111111',
    content: { text: 'hello', media: ['md_ABC'] },
    targets: [{ connection_id: 'cn_ONE' }, { connection_id: 'cn_TWO' }],
  };

  it('is stable across key reordering', () => {
    const reordered = {
      targets: submission.targets,
      content: { media: submission.content.media, text: submission.content.text },
      user_id: submission.user_id,
    };
    expect(hashRequest(reordered).equals(hashRequest(submission))).toBe(true);
  });

  it('changes when any value changes', () => {
    for (const altered of [
      { ...submission, user_id: '22222222-2222-4222-8222-222222222222' },
      { ...submission, content: { ...submission.content, text: 'goodbye' } },
      { ...submission, targets: [{ connection_id: 'cn_ONE' }] },
      { ...submission, external_ref: 'added' },
    ]) {
      expect(
        hashRequest(altered).equals(hashRequest(submission)),
        `${JSON.stringify(altered).slice(0, 60)} hashed the same`,
      ).toBe(false);
    }
  });

  it('changes when target order changes, because the targets are ordered', () => {
    const swapped = { ...submission, targets: [...submission.targets].reverse() };
    expect(hashRequest(swapped).equals(hashRequest(submission))).toBe(false);
  });

  it('produces a 32-byte sha256 digest', () => {
    expect(hashRequest(submission)).toHaveLength(32);
  });
});
