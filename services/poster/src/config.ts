import { intEnv, optionalEnv, requireEnv } from '@suite/server-core';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
] as const;

function logLevel(): LogLevel {
  const raw = optionalEnv('LOG_LEVEL', 'info');
  const found = LOG_LEVELS.find((level) => level === raw);
  if (found === undefined) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${raw}`);
  }
  return found;
}

export interface ServiceConfig {
  readonly nodeEnv: string;
  readonly logLevel: LogLevel;
  /** HTTP port for the API entrypoint. Ignored by the worker. */
  readonly port: number;
  /** 0.0.0.0 by default so the container is reachable from outside it. */
  readonly host: string;
  /** Milliseconds the worker waits between heartbeat ticks. */
  readonly workerTickMs: number;
  /** Milliseconds to let in-flight work finish on SIGTERM before forcing exit. */
  readonly shutdownTimeoutMs: number;
}

/**
 * Config is read once at startup so a misconfigured process fails before it
 * accepts traffic or claims a row.
 */
export function loadConfig(): ServiceConfig {
  return {
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    logLevel: logLevel(),
    port: intEnv('PORT', 8080),
    host: optionalEnv('HOST', '0.0.0.0'),
    workerTickMs: intEnv('WORKER_TICK_MS', 5_000),
    shutdownTimeoutMs: intEnv('SHUTDOWN_TIMEOUT_MS', 10_000),
  };
}

/**
 * Config the API needs beyond process basics: the database, the signing secret,
 * and the Supabase project whose sessions we accept.
 *
 * Read separately from `loadConfig` and only by the API entrypoint, so the worker
 * and the unit tests do not have to satisfy requirements they never use. Every
 * value fails loudly at startup rather than at first request.
 */
export interface ApiConfig {
  readonly databaseUrl: string;
  /** HS256 secret for our own app tokens. Never Supabase's JWT secret (D-046). */
  readonly appTokenSecret: string;
  readonly appTokenKeyId: string;
  readonly appTokenIssuer: string;
  readonly appTokenAudience: string;
  /** Supabase JWKS for verifying user-mode session tokens (D-046). */
  readonly supabaseJwksUrl: string;
  readonly supabaseIssuer: string;
  /** client_id of the app user-mode requests act as (contract §2.2). */
  readonly firstPartyClientId: string;
  readonly tokenEndpointLimitPerMin: number;
  readonly corsOrigins: readonly string[];
}

export function loadApiConfig(): ApiConfig {
  const secret = requireEnv('APP_TOKEN_SECRET');
  if (secret.length < 32) {
    throw new Error('APP_TOKEN_SECRET must be at least 32 characters');
  }

  return {
    databaseUrl: requireEnv('DATABASE_URL'),
    appTokenSecret: secret,
    appTokenKeyId: optionalEnv('APP_TOKEN_KEY_ID', 'k1'),
    appTokenIssuer: optionalEnv('APP_TOKEN_ISSUER', 'poster-api'),
    appTokenAudience: optionalEnv('APP_TOKEN_AUDIENCE', 'poster-api'),
    supabaseJwksUrl: requireEnv('SUPABASE_JWKS_URL'),
    supabaseIssuer: requireEnv('SUPABASE_JWT_ISSUER'),
    firstPartyClientId: optionalEnv('FIRST_PARTY_CLIENT_ID', 'poster-web'),
    tokenEndpointLimitPerMin: intEnv('TOKEN_ENDPOINT_LIMIT_PER_MIN', 30),
    corsOrigins: optionalEnv('CORS_ALLOWED_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  };
}
