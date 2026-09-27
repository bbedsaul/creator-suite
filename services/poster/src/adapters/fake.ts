/**
 * The fake adapter: scripted outcomes, latency and hangs.
 *
 * Built first on purpose (the `platform-adapter` skill says so). Every behaviour
 * the dispatcher must survive is reachable here without a network: a transient
 * sequence, a permanent rejection, an `unknown` that reconciliation has to
 * resolve, and a publish that hangs past its lease so crash safety can be
 * exercised deliberately rather than hoped for.
 *
 * It also counts real publishes per target, which is what makes "zero
 * double-posts" measurable rather than asserted (NFR-02).
 */
import { randomUUID } from 'node:crypto';
import type {
  ConnectionCheckRequest,
  ConnectionHealth,
  LookupOutcome,
  LookupRequest,
  PlatformAdapter,
  PublishOutcome,
  PublishRequest,
} from './adapter.js';

/** One scripted step. Consumed in order; the last step repeats once exhausted. */
export type FakeStep =
  | { readonly kind: 'success'; readonly platformPostId?: string; readonly permalink?: string }
  | { readonly kind: 'transient'; readonly message?: string; readonly retryAfterMs?: number }
  | { readonly kind: 'permanent'; readonly message?: string }
  | { readonly kind: 'unknown'; readonly message?: string }
  /** Resolves after `ms`, then behaves as `then`. Models a slow provider. */
  | { readonly kind: 'slow'; readonly ms: number; readonly then: FakeStep }
  /** Never resolves until the request's own timeout fires. Models a wedged provider. */
  | { readonly kind: 'hang' };

export interface FakeScenario {
  /** Steps for this target, in order. */
  readonly steps: readonly FakeStep[];
  /** What `lookup` should answer for this target. Defaults to `unknown`. */
  readonly lookup?: LookupOutcome;
}

export interface FakeAdapterOptions {
  readonly id?: string;
  readonly platforms?: readonly string[];
  /** Scenario per target id. Targets with no scenario succeed immediately. */
  readonly scenarios?: Map<string, FakeScenario>;
  readonly supportsIdempotencyKey?: boolean;
  readonly supportsReferenceLookup?: boolean;
}

export interface FakeAdapter extends PlatformAdapter {
  /** Scripts a target. Replaces any existing scenario. */
  script(targetId: string, scenario: FakeScenario): void;
  /** How many times `publish` actually reached the "posted" point for a target. */
  publishCount(targetId: string): number;
  /** Every attemptRef this adapter was asked to publish, in order. */
  readonly attemptRefs: readonly string[];
  /** Publishes currently in flight, so a test can wait for a hang to be reached. */
  inFlight(): number;
  reset(): void;
}

const DEFAULT_STEP: FakeStep = { kind: 'success' };

/**
 * Never settles until the signal aborts.
 *
 * Deliberately not `sleep(Number.MAX_SAFE_INTEGER)`: setTimeout clamps any delay
 * above 2^31-1 to 1ms, so that version resolved immediately and the "hang" did not
 * hang at all — which would quietly make every crash-safety scenario pass for the
 * wrong reason.
 */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

/** Resolves after `ms`, or rejects when the request's deadline passes first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const scenarios = options.scenarios ?? new Map<string, FakeScenario>();
  const stepIndex = new Map<string, number>();
  const publishes = new Map<string, number>();
  const attemptRefs: string[] = [];
  let inFlightCount = 0;

  function nextStep(targetId: string): FakeStep {
    const scenario = scenarios.get(targetId);
    if (scenario === undefined || scenario.steps.length === 0) return DEFAULT_STEP;

    const index = stepIndex.get(targetId) ?? 0;
    stepIndex.set(targetId, index + 1);
    // The last step repeats, so "always transient" is one step rather than many.
    return scenario.steps[Math.min(index, scenario.steps.length - 1)] ?? DEFAULT_STEP;
  }

  async function runStep(
    step: FakeStep,
    request: PublishRequest,
    signal: AbortSignal,
  ): Promise<PublishOutcome> {
    switch (step.kind) {
      case 'slow':
        await sleep(step.ms, signal);
        return runStep(step.then, request, signal);

      case 'hang':
        // Waits for the caller's deadline and nothing else. The dispatcher's
        // timeout is what ends this, which is exactly the situation
        // reconciliation exists for.
        await untilAborted(signal);
        throw new Error('unreachable');

      case 'success': {
        const count = (publishes.get(request.target.targetId) ?? 0) + 1;
        publishes.set(request.target.targetId, count);
        return {
          kind: 'success',
          platformPostId: step.platformPostId ?? `fake-${randomUUID()}`,
          permalink: step.permalink ?? `https://fake.test/p/${request.target.targetId}`,
          raw: { adapter: 'fake', attemptRef: request.attemptRef },
        };
      }

      case 'transient':
        return {
          kind: 'transient',
          message: step.message ?? 'fake transient failure',
          ...(step.retryAfterMs === undefined
            ? {}
            : { retryAt: new Date(Date.now() + step.retryAfterMs) }),
          raw: { adapter: 'fake' },
        };

      case 'permanent':
        return {
          kind: 'permanent',
          message: step.message ?? 'fake permanent rejection',
          raw: { adapter: 'fake' },
        };

      case 'unknown':
        return {
          kind: 'unknown',
          message: step.message ?? 'fake ambiguous outcome',
          raw: { adapter: 'fake' },
        };
    }
  }

  return {
    id: options.id ?? 'fake',
    platforms: options.platforms ?? [
      'tiktok',
      'youtube',
      'x',
      'linkedin',
      'instagram',
      'facebook_pages',
    ],
    supportsIdempotencyKey: options.supportsIdempotencyKey ?? true,
    // The fake models a provider that honours our attempt id both ways; the
    // chaos harness depends on being able to look a publish up by it (D-076).
    supportsReferenceLookup: options.supportsReferenceLookup ?? true,

    async publish(request) {
      attemptRefs.push(request.attemptRef);
      inFlightCount += 1;

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        return await runStep(nextStep(request.target.targetId), request, controller.signal);
      } catch {
        // The deadline fired mid-publish. This is the honest answer: the request
        // may or may not have landed, and only a lookup can say (D-012).
        return {
          kind: 'unknown',
          message: `publish exceeded ${String(request.timeoutMs)}ms`,
          raw: { adapter: 'fake', timedOut: true },
        };
      } finally {
        clearTimeout(deadline);
        inFlightCount -= 1;
      }
    },

    lookup(request: LookupRequest): Promise<LookupOutcome> {
      const scenario = scenarios.get(request.target.targetId);
      return Promise.resolve(scenario?.lookup ?? { kind: 'unknown' });
    },

    checkConnection(_request: ConnectionCheckRequest): Promise<ConnectionHealth> {
      return Promise.resolve({ kind: 'active' });
    },

    script(targetId, scenario) {
      scenarios.set(targetId, scenario);
      stepIndex.delete(targetId);
    },

    publishCount(targetId) {
      return publishes.get(targetId) ?? 0;
    },

    get attemptRefs() {
      return attemptRefs;
    },

    inFlight() {
      return inFlightCount;
    },

    reset() {
      scenarios.clear();
      stepIndex.clear();
      publishes.clear();
      attemptRefs.length = 0;
    },
  };
}
