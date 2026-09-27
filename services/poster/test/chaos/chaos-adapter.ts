/**
 * A fake adapter that can kill its own process mid-dispatch, and whose record of
 * what it published survives that kill.
 *
 * The in-memory publish counter in the normal fake is useless here: SIGKILL takes
 * it with the process. So a publish appends one line to a shared file
 * **synchronously, before returning**, and the parent counts lines per target
 * afterwards. That file is the moral equivalent of "the post is on the platform",
 * and the invariant under test is that it never contains two lines for one target.
 *
 * `lookup` consults the same file by `attemptRef`, which models a provider that
 * accepts our attempt id as an idempotency key — exactly the property D-012 says
 * decides whether reconciliation can answer `absent` instead of `unknown`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  ConnectionCheckRequest,
  ConnectionHealth,
  LookupOutcome,
  LookupRequest,
  PlatformAdapter,
  PublishOutcome,
  PublishRequest,
} from '../../src/adapters/adapter.js';

/**
 * Where the crash lands, relative to the adapter call.
 *
 *   before_send  nothing reached the platform, so a retry must be safe
 *   after_send   the platform has it but the database does not — the dangerous
 *                window, and the one a wrong reconciliation turns into a duplicate
 *   none         control: no crash
 *
 * The windows outside the adapter (after the claim, before the attempt row) are
 * covered by the `race` mode in the harness, which kills on a random short delay.
 */
export type CrashPoint = 'before_send' | 'after_send' | 'none';

export interface ChaosAdapterOptions {
  /** File the "platform" records publishes in. Shared with the parent process. */
  readonly publishLogPath: string;
  readonly crashAt?: CrashPoint;
  /** What `lookup` should say regardless of the log. Used to test the unknown path. */
  readonly forceLookup?: LookupOutcome;
}

/** One recorded publish. */
interface PublishRecord {
  readonly attemptRef: string;
  readonly targetId: string;
}

export function readPublishLog(path: string): PublishRecord[] {
  let contents = '';
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return contents
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [attemptRef = '', targetId = ''] = line.split('\t');
      return { attemptRef, targetId };
    });
}

export function publishCountFor(path: string, targetId: string): number {
  return readPublishLog(path).filter((record) => record.targetId === targetId).length;
}

function die(): never {
  // A real SIGKILL to our own process: uncatchable, no cleanup, no flush. This is
  // the crash the acceptance criterion is about, not a simulated one.
  process.kill(process.pid, 'SIGKILL');
  // Unreachable, but the type system does not know that.
  throw new Error('unreachable');
}

export function createChaosAdapter(options: ChaosAdapterOptions): PlatformAdapter {
  const crashAt = options.crashAt ?? 'none';

  return {
    id: 'chaos',
    platforms: ['tiktok', 'youtube'],
    supportsIdempotencyKey: true,

    publish(request: PublishRequest): Promise<PublishOutcome> {
      if (crashAt === 'before_send') die();

      // Written synchronously so it is durable before we can be killed.
      appendFileSync(options.publishLogPath, `${request.attemptRef}\t${request.target.targetId}\n`);

      if (crashAt === 'after_send') die();

      return Promise.resolve({
        kind: 'success',
        platformPostId: `chaos-${randomUUID()}`,
        permalink: `https://chaos.test/p/${request.target.targetId}`,
        raw: { adapter: 'chaos' },
      });
    },

    lookup(request: LookupRequest): Promise<LookupOutcome> {
      if (options.forceLookup !== undefined) return Promise.resolve(options.forceLookup);

      const record = readPublishLog(options.publishLogPath).find(
        (entry) => entry.attemptRef === request.attemptRef,
      );

      return Promise.resolve(
        record === undefined
          ? // Provably absent: this attempt id never reached the platform.
            { kind: 'absent' }
          : { kind: 'found', platformPostId: `chaos-${record.attemptRef}` },
      );
    },

    checkConnection(_request: ConnectionCheckRequest): Promise<ConnectionHealth> {
      return Promise.resolve({ kind: 'active' });
    },
  };
}
