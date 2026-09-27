/**
 * Resolving named secrets by reference.
 *
 * Distinct from the envelope encryption in ./envelope.ts, which protects secrets
 * *we* store per row. This is for secrets someone else owns the lifecycle of — an
 * app's webhook signing key, an aggregator API key — where the database holds only
 * a **reference** and never the value (contract §2.1: "stored in the secrets
 * manager, never in app databases").
 *
 * A reference is `<scheme>:<name>`. The env scheme is for development; a cloud
 * secret manager implements the same interface in production.
 */

export class SecretNotFoundError extends Error {
  constructor(ref: string) {
    // The ref, never the value.
    super(`no secret for reference ${ref}`);
    this.name = 'SecretNotFoundError';
  }
}

export class InvalidSecretRefError extends Error {
  constructor(ref: string) {
    super(`malformed secret reference ${ref}`);
    this.name = 'InvalidSecretRefError';
  }
}

export interface SecretsManager {
  /**
   * Resolves a reference to its value, **rejecting** rather than returning
   * undefined. Implementations must be async so a failure arrives as a rejected
   * promise: a synchronous throw from a Promise-returning function is invisible to
   * a caller using `.catch()`, which is how a missing secret turns into a crash.
   */
  get(ref: string): Promise<string>;
}

const ENV_REF = /^env:([A-Z][A-Z0-9_]*)$/;

/**
 * Development secrets manager: `env:NAME` reads process.env.NAME.
 *
 * The name pattern is restricted deliberately. A reference comes from the database,
 * and without this an attacker who could write `webhook_secret_ref` could read any
 * environment variable the process has — including the database URL.
 */
export function createEnvSecretsManager(env: NodeJS.ProcessEnv = process.env): SecretsManager {
  return {
    async get(ref) {
      const match = ENV_REF.exec(ref);
      if (match === null) throw new InvalidSecretRefError(ref);

      const value = env[match[1] as string];
      if (value === undefined || value === '') throw new SecretNotFoundError(ref);
      return value;
    },
  };
}

/** In-memory manager, for tests and for a process given its secrets directly. */
export function createStaticSecretsManager(
  secrets: Readonly<Record<string, string>>,
): SecretsManager {
  return {
    async get(ref) {
      const value = secrets[ref];
      if (value === undefined) throw new SecretNotFoundError(ref);
      return value;
    },
  };
}
