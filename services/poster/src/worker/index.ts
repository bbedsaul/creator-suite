/**
 * Worker entrypoint: the long-running process that dispatches posts.
 *
 * One loop per enabled platform, each independent (rule 10). The webhook
 * deliverer (S08), the reconciler (S07) and the sweepers join them here as they
 * arrive. Deployed as its own container alongside the API (D-022).
 */
import { hostname } from 'node:os';
import pino from 'pino';
import { createLocalKeyManager } from '@suite/server-core';
import { createFakeAdapter } from '../adapters/fake.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import { loadConfig, loadWorkerConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createCredentialVault } from '../vault/credentials.js';
import { startDispatchLoop, type DispatchLoop } from './dispatch-loop.js';
import { startReconcileLoop } from './reconcile-loop.js';
import { loadDispatchablePlatforms } from './platforms.js';

const config = loadConfig();
const workerConfig = loadWorkerConfig();
const logger = pino({ level: config.logLevel, name: 'poster-worker' });
const stopping = new AbortController();

const workerId = `${hostname()}:${String(process.pid)}`;
const sql = createPool({ databaseUrl: workerConfig.databaseUrl, max: workerConfig.poolSize });

const vault = createCredentialVault(
  sql,
  createLocalKeyManager({ masterKeyBase64: workerConfig.vaultMasterKey }),
);

// S09 replaces this with the aggregator adapter chosen by the spike; until then the
// fake is the only thing that can publish, which is why it is production-shaped.
const registry = createAdapterRegistry([createFakeAdapter()]);

logger.info(
  { workerId, adapters: registry.adapters.map((adapter) => adapter.id) },
  'poster-worker starting',
);

const platforms = await loadDispatchablePlatforms(
  sql,
  workerConfig.dispatchDefaults,
  workerConfig.dispatchOverrides,
);

if (platforms.length === 0) {
  // Not an error: a fresh database has no enabled platform until constraints are
  // seeded. Saying so beats looking healthy while dispatching nothing.
  logger.warn(
    {},
    'no enabled platform has a constraint spec; nothing to dispatch. Run seed:constraints',
  );
}

const loops: DispatchLoop[] = platforms.map((platform) =>
  startDispatchLoop(
    platform,
    { sql, vault, adapterFor: (platformId) => registry.for(platformId), workerId, logger },
    stopping.signal,
  ),
);

// One reconciler for the whole worker, not one per platform: it is off the hot
// path, and a stale dispatch is rare by construction (D-075).
const reconciler = startReconcileLoop(
  workerConfig.reconcile,
  { sql, vault, adapterFor: (platformId) => registry.for(platformId), logger },
  stopping.signal,
);

const running = Promise.all([...loops.map((loop) => loop.done), reconciler.done]);

// Signal handling is deliberately not the shared installShutdownHandlers helper's
// job to know about loops: it takes a hook, and this is the hook.
const { installShutdownHandlers } = await import('../shutdown.js');
installShutdownHandlers({
  logger,
  timeoutMs: config.shutdownTimeoutMs,
  hook: async () => {
    // Loops finish the batch they are on. A target still in flight when the
    // process dies stays `dispatching` and reconciliation resolves it (D-012);
    // that is safe by design, but an orderly stop avoids the wait.
    stopping.abort();
    await running;
    await sql.end({ timeout: 5 });
  },
});

await running;
logger.info({}, 'poster-worker stopped');
