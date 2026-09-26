import { afterEach, describe, expect, it } from 'vitest';
import { intEnv, optionalEnv, requireEnv } from '../src/env.js';

const KEY = 'SUITE_TEST_ENV_VAR';

afterEach(() => {
  delete process.env[KEY];
});

describe('requireEnv', () => {
  it('returns the value when set', () => {
    process.env[KEY] = 'hello';
    expect(requireEnv(KEY)).toBe('hello');
  });

  it('throws naming the variable when unset', () => {
    expect(() => requireEnv(KEY)).toThrow(/SUITE_TEST_ENV_VAR/);
  });

  it('treats whitespace-only as unset', () => {
    process.env[KEY] = '   ';
    expect(() => requireEnv(KEY)).toThrow();
  });
});

describe('optionalEnv', () => {
  it('falls back when unset', () => {
    expect(optionalEnv(KEY, 'fallback')).toBe('fallback');
  });
});

describe('intEnv', () => {
  it('parses an integer', () => {
    process.env[KEY] = '42';
    expect(intEnv(KEY, 1)).toBe(42);
  });

  it('rejects a non-integer', () => {
    process.env[KEY] = '4.5';
    expect(() => intEnv(KEY, 1)).toThrow(/must be an integer/);
  });
});
