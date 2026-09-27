/**
 * Resolves which adapter publishes to which platform.
 *
 * In M1 the only adapter is the fake one; the real aggregator arrives in S09 and
 * registers itself here alongside it. A platform with no adapter must fail loudly
 * rather than silently never dispatch, which is why this throws instead of
 * returning undefined.
 */
import type { PlatformAdapter } from './adapter.js';

export interface AdapterRegistry {
  /** Throws when no adapter claims the platform. */
  for(platformId: string): PlatformAdapter;
  /** Platforms that at least one registered adapter claims. */
  supportedPlatforms(): string[];
  readonly adapters: readonly PlatformAdapter[];
}

export class NoAdapterError extends Error {
  constructor(platformId: string) {
    super(`no adapter is registered for platform ${platformId}`);
    this.name = 'NoAdapterError';
  }
}

export function createAdapterRegistry(adapters: readonly PlatformAdapter[]): AdapterRegistry {
  const byPlatform = new Map<string, PlatformAdapter>();
  for (const adapter of adapters) {
    for (const platform of adapter.platforms) {
      // First registration wins, so a direct adapter added later must be listed
      // ahead of the aggregator to take over a platform. Deliberately explicit.
      if (!byPlatform.has(platform)) byPlatform.set(platform, adapter);
    }
  }

  return {
    adapters,
    for(platformId) {
      const adapter = byPlatform.get(platformId);
      if (adapter === undefined) throw new NoAdapterError(platformId);
      return adapter;
    },
    supportedPlatforms() {
      return [...byPlatform.keys()].sort();
    },
  };
}
