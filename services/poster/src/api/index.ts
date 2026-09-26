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
import { createPlatformConstraintStore } from '../db/platform-constraints.js';
import { createValidationContextStore } from '../db/validation-context.js';
import { createGrantStore } from '../db/grants.js';
import { createMediaStore } from '../db/media.js';
import { createPostStore } from '../db/posts.js';
import { createFfprobeProber } from '../media/prober.js';
import { createSupabaseStorage, ensureBucket } from '../media/storage.js';
import { createPool } from '../db/pool.js';
import { installShutdownHandlers } from '../shutdown.js';
import { buildServer } from './server.js';

const config = loadConfig();
const apiConfig = loadApiConfig();

const sql = createPool({ databaseUrl: apiConfig.databaseUrl });

const storageOptions = {
  url: apiConfig.supabaseUrl,
  serviceRoleKey: apiConfig.supabaseServiceRoleKey,
  bucket: apiConfig.mediaBucket,
  signedUrlTtlS: apiConfig.signedUrlTtlS,
};
// Idempotent, and cheaper than making every deployment remember to do it.
await ensureBucket(storageOptions);

const app = buildServer(config, {
  apps: createClientAppStore(sql),
  constraints: createPlatformConstraintStore(sql),
  validationContext: createValidationContextStore(sql),
  grants: createGrantStore(sql),
  mediaStore: createMediaStore(sql),
  postStore: createPostStore(sql),
  storage: createSupabaseStorage(storageOptions),
  prober: createFfprobeProber(),
  maxDirectUploadBytes: apiConfig.maxDirectUploadBytes,
  signedUrlTtlS: apiConfig.signedUrlTtlS,
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
