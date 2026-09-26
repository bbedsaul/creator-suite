/**
 * API entrypoint. Runs with no frontend and no worker present (D-022).
 */
import { loadConfig } from '../config.js';
import { installShutdownHandlers } from '../shutdown.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = buildServer(config);

installShutdownHandlers({
  logger: app.log,
  timeoutMs: config.shutdownTimeoutMs,
  hook: async () => {
    // Stops accepting connections and waits for in-flight requests.
    await app.close();
  },
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`poster-api listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
} catch (error) {
  app.log.error({ err: error }, 'poster-api failed to start');
  process.exit(1);
}
