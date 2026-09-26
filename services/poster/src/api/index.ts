/**
 * API entrypoint. Runs with no frontend and no worker present (D-022).
 *
 * This is the only place the real dependencies are constructed; everything else
 * takes them as arguments, which is what lets the tests build the same server
 * against fakes.
 */
import {
  createAppTokenSigner,
  createUserTokenVerifier,
  InMemoryRateLimiter,
} from '@suite/server-core';
import { loadApiConfig, loadConfig } from '../config.js';
import { createClientAppStore } from '../db/client-apps.js';
import { createPool } from '../db/pool.js';
import { installShutdownHandlers } from '../shutdown.js';
import { buildServer } from './server.js';

const config = loadConfig();
const apiConfig = loadApiConfig();

const sql = createPool({ databaseUrl: apiConfig.databaseUrl });

const app = buildServer(config, {
  apps: createClientAppStore(sql),
  appTokens: createAppTokenSigner({
    secret: apiConfig.appTokenSecret,
    keyId: apiConfig.appTokenKeyId,
    issuer: apiConfig.appTokenIssuer,
    audience: apiConfig.appTokenAudience,
  }),
  userTokens: createUserTokenVerifier({
    jwksUrl: apiConfig.supabaseJwksUrl,
    issuer: apiConfig.supabaseIssuer,
  }),
  rateLimiter: new InMemoryRateLimiter(),
  appTokenIssuer: apiConfig.appTokenIssuer,
  firstPartyClientId: apiConfig.firstPartyClientId,
  tokenEndpointLimitPerMin: apiConfig.tokenEndpointLimitPerMin,
  corsOrigins: apiConfig.corsOrigins,
});

installShutdownHandlers({
  logger: app.log,
  timeoutMs: config.shutdownTimeoutMs,
  hook: async () => {
    // Stop accepting connections and finish in-flight requests, then drain the pool.
    await app.close();
    await sql.end({ timeout: 5 });
  },
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`poster-api listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
} catch (error) {
  app.log.error({ err: error }, 'poster-api failed to start');
  process.exit(1);
}
