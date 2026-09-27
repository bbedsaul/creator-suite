/**
 * Adapter resolution and per-platform dispatch configuration.
 */
import { describe, expect, it } from 'vitest';
import { NoAdapterError, createAdapterRegistry } from '../src/adapters/registry.js';
import { createFakeAdapter } from '../src/adapters/fake.js';
import { parseOverrides } from '../src/worker/platforms.js';

describe('createAdapterRegistry', () => {
  it('resolves a platform to its adapter', () => {
    const fake = createFakeAdapter({ platforms: ['tiktok', 'youtube'] });
    const registry = createAdapterRegistry([fake]);

    expect(registry.for('tiktok')).toBe(fake);
    expect(registry.supportedPlatforms()).toEqual(['tiktok', 'youtube']);
  });

  it('throws for an unclaimed platform rather than silently never dispatching', () => {
    const registry = createAdapterRegistry([createFakeAdapter({ platforms: ['tiktok'] })]);
    expect(() => registry.for('youtube')).toThrow(NoAdapterError);
  });

  it('lets the first registration win, so a direct adapter can take over a platform', () => {
    // S09 adds an aggregator; a later direct adapter is listed ahead of it.
    const direct = createFakeAdapter({ id: 'direct:tiktok', platforms: ['tiktok'] });
    const aggregator = createFakeAdapter({ id: 'ayrshare', platforms: ['tiktok', 'youtube'] });
    const registry = createAdapterRegistry([direct, aggregator]);

    expect(registry.for('tiktok').id).toBe('direct:tiktok');
    expect(registry.for('youtube').id).toBe('ayrshare');
  });

  it('is empty but usable with no adapters', () => {
    const registry = createAdapterRegistry([]);
    expect(registry.supportedPlatforms()).toEqual([]);
    expect(() => registry.for('tiktok')).toThrow(NoAdapterError);
  });
});

describe('parseOverrides', () => {
  it('treats an empty value as no overrides', () => {
    expect(parseOverrides('')).toEqual({});
    expect(parseOverrides('   ')).toEqual({});
  });

  it('parses per-platform budgets, so one platform can be tuned alone (rule 10)', () => {
    expect(parseOverrides('{"tiktok":{"concurrency":2,"pollIntervalMs":5000}}')).toEqual({
      tiktok: { concurrency: 2, pollIntervalMs: 5000 },
    });
  });

  it('rejects malformed JSON with a message naming the variable', () => {
    expect(() => parseOverrides('{not json')).toThrow(/DISPATCH_OVERRIDES/);
  });

  it('rejects a non-object, which would silently override nothing', () => {
    expect(() => parseOverrides('[1,2]')).toThrow(/JSON object/);
    expect(() => parseOverrides('"tiktok"')).toThrow(/JSON object/);
  });
});
