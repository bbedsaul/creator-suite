/**
 * The service's Postgres connection, as service_role (D-019, D-024).
 *
 * postgres.js with a direct connection, not PostgREST: server code calls the
 * `security definer` functions that hold the invariants, and RLS is defence in
 * depth for the browser path we do not use.
 */
import postgres, { type Sql } from 'postgres';

export interface PoolOptions {
  readonly databaseUrl: string;
  readonly max?: number;
}

export function createPool(options: PoolOptions): Sql {
  return postgres(options.databaseUrl, {
    max: options.max ?? 10,
    // Statements never interpolate strings, but this makes that structural.
    prepare: true,
    onnotice: () => {},
  });
}
