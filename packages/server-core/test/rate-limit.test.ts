import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '../src/rate-limit.js';

/** Controllable clock: the limiter must be testable without sleeping. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('InMemoryRateLimiter (D-047)', () => {
  it('allows a full minute of requests as a burst, then refuses', () => {
    const clock = fakeClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.consume('app:1', 10).allowed, `request ${String(i)}`).toBe(true);
    }

    const refused = limiter.consume('app:1', 10);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it('reports a Retry-After of at least one second', () => {
    const clock = fakeClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });
    for (let i = 0; i < 60; i += 1) limiter.consume('app:1', 60);

    const refused = limiter.consume('app:1', 60);
    // Retry-After: 0 would invite an immediate retry, which is not a limit.
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills continuously rather than resetting on a minute boundary', () => {
    const clock = fakeClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });
    for (let i = 0; i < 60; i += 1) limiter.consume('app:1', 60);
    expect(limiter.consume('app:1', 60).allowed).toBe(false);

    clock.advance(1000); // one second at 60/min == one token
    expect(limiter.consume('app:1', 60).allowed).toBe(true);
    expect(limiter.consume('app:1', 60).allowed).toBe(false);
  });

  it('never accumulates more than one minute of capacity', () => {
    const clock = fakeClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });
    limiter.consume('app:1', 10);
    clock.advance(60 * 60 * 1000); // an idle hour

    for (let i = 0; i < 10; i += 1) expect(limiter.consume('app:1', 10).allowed).toBe(true);
    expect(limiter.consume('app:1', 10).allowed).toBe(false);
  });

  it('keeps buckets independent, so one noisy app cannot starve another', () => {
    const clock = fakeClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });
    for (let i = 0; i < 5; i += 1) limiter.consume('app:noisy', 5);

    expect(limiter.consume('app:noisy', 5).allowed).toBe(false);
    expect(limiter.consume('app:quiet', 5).allowed).toBe(true);
  });

  it('honors each app’s own limit, because limits are data not constants', () => {
    const clock = fakeClock();
    const limiter = new InMemoryRateLimiter({ now: clock.now });
    limiter.consume('app:small', 1);
    expect(limiter.consume('app:small', 1).allowed).toBe(false);

    for (let i = 0; i < 100; i += 1) expect(limiter.consume('app:large', 100).allowed).toBe(true);
  });

  it('rejects a nonsensical limit rather than silently allowing everything', () => {
    const limiter = new InMemoryRateLimiter();
    expect(() => limiter.consume('app:1', 0)).toThrow(RangeError);
    expect(() => limiter.consume('app:1', -5)).toThrow(RangeError);
    expect(() => limiter.consume('app:1', Number.NaN)).toThrow(RangeError);
  });
});
