/**
 * The fake adapter (the `platform-adapter` skill: fake first).
 *
 * Its job is to make every dispatcher-relevant behaviour reachable without a
 * network, so what is tested here is that the script is honoured exactly — a fake
 * that quietly succeeds when it was told to hang would hide the very bug the
 * dispatcher's crash safety exists for.
 */
import { describe, expect, it } from 'vitest';
import { createFakeAdapter } from '../src/adapters/fake.js';
import type { PublishRequest } from '../src/adapters/adapter.js';

const TARGET = '66666666-6666-6666-6666-666666666601';

function request(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    attemptRef: crypto.randomUUID(),
    credential: { kind: 'aggregator_profile', provider: 'fake', secret: 'shh' },
    target: {
      targetId: TARGET,
      platformId: 'tiktok',
      externalAccountId: 'acct-1',
      text: 'hello',
      title: null,
    },
    renditions: [],
    timeoutMs: 1000,
    ...over,
  };
}

describe('default behaviour', () => {
  it('succeeds with a post id and permalink when unscripted', async () => {
    const adapter = createFakeAdapter();
    const outcome = await adapter.publish(request());

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.platformPostId).toBeTruthy();
      expect(outcome.permalink).toContain(TARGET);
    }
  });

  it('never puts the credential in its raw response', async () => {
    const adapter = createFakeAdapter();
    const outcome = await adapter.publish(request());
    expect(JSON.stringify(outcome.raw)).not.toContain('shh');
  });
});

describe('scripted sequences', () => {
  it('walks the steps in order', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, {
      steps: [{ kind: 'transient' }, { kind: 'transient' }, { kind: 'success' }],
    });

    const kinds = [
      (await adapter.publish(request())).kind,
      (await adapter.publish(request())).kind,
      (await adapter.publish(request())).kind,
    ];
    expect(kinds).toEqual(['transient', 'transient', 'success']);
  });

  it('repeats the last step once the script runs out', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'permanent' }] });

    for (let i = 0; i < 3; i += 1) {
      expect((await adapter.publish(request())).kind).toBe('permanent');
    }
  });

  it('carries the platform message on a permanent rejection', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'permanent', message: 'caption too long' }] });

    const outcome = await adapter.publish(request());
    expect(outcome.kind).toBe('permanent');
    if (outcome.kind === 'permanent') expect(outcome.message).toBe('caption too long');
  });

  it('honours a provider-supplied retryAt on a transient failure', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'transient', retryAfterMs: 5000 }] });

    const outcome = await adapter.publish(request());
    expect(outcome.kind).toBe('transient');
    if (outcome.kind === 'transient') {
      expect(outcome.retryAt?.getTime()).toBeGreaterThan(Date.now() + 4000);
    }
  });
});

describe('latency and hangs', () => {
  it('delays a slow step but still returns its outcome', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'slow', ms: 60, then: { kind: 'success' } }] });

    const started = Date.now();
    const outcome = await adapter.publish(request({ timeoutMs: 2000 }));
    expect(outcome.kind).toBe('success');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('answers unknown when a hang hits the deadline', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'hang' }] });

    const outcome = await adapter.publish(request({ timeoutMs: 80 }));
    // Not transient: after a hang we cannot prove the post did not land, and
    // calling it transient would risk sending it twice (D-012).
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind === 'unknown') expect(outcome.message).toContain('exceeded');
  });

  it('does not count a hang as a publish', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'hang' }] });
    await adapter.publish(request({ timeoutMs: 50 }));
    expect(adapter.publishCount(TARGET)).toBe(0);
  });

  it('reports in-flight publishes, so a test can wait for a hang to be reached', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'hang' }] });

    const pending = adapter.publish(request({ timeoutMs: 120 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.inFlight()).toBe(1);

    await pending;
    expect(adapter.inFlight()).toBe(0);
  });
});

describe('publish counting (NFR-02)', () => {
  it('counts only real publishes, which is what makes double-posts measurable', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [{ kind: 'transient' }, { kind: 'success' }] });

    await adapter.publish(request());
    expect(adapter.publishCount(TARGET)).toBe(0);
    await adapter.publish(request());
    expect(adapter.publishCount(TARGET)).toBe(1);
  });

  it('records every attemptRef it was given', async () => {
    const adapter = createFakeAdapter();
    const refs = [crypto.randomUUID(), crypto.randomUUID()];
    for (const attemptRef of refs) await adapter.publish(request({ attemptRef }));
    expect(adapter.attemptRefs).toEqual(refs);
  });
});

describe('lookup', () => {
  it('answers unknown unless the scenario says otherwise', async () => {
    const adapter = createFakeAdapter();
    const outcome = await adapter.lookup({
      attemptRef: 'ref',
      credential: { kind: 'aggregator_profile', provider: 'fake', secret: 'shh' },
      target: request().target,
      timeoutMs: 1000,
    });
    // Unknown is the honest default: a fake that claimed `absent` would make
    // reconciliation look safer than it is.
    expect(outcome.kind).toBe('unknown');
  });

  it('answers what the scenario scripted', async () => {
    const adapter = createFakeAdapter();
    adapter.script(TARGET, { steps: [], lookup: { kind: 'found', platformPostId: 'pp-9' } });

    const outcome = await adapter.lookup({
      attemptRef: 'ref',
      credential: { kind: 'aggregator_profile', provider: 'fake', secret: 'shh' },
      target: request().target,
      timeoutMs: 1000,
    });
    expect(outcome).toEqual({ kind: 'found', platformPostId: 'pp-9' });
  });
});

describe('declared capabilities', () => {
  it('says it supports idempotency keys, which is what lookup accuracy rests on', () => {
    expect(createFakeAdapter().supportsIdempotencyKey).toBe(true);
  });

  it('can be restricted to specific platforms', () => {
    expect(createFakeAdapter({ platforms: ['tiktok'] }).platforms).toEqual(['tiktok']);
  });
});
