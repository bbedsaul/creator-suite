import { intEnv, optionalEnv } from '@suite/server-core';

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
