import { describe, expect, it } from 'vitest';
import { CLIENT_GENERATED, TARGET_CONTRACT_VERSION } from '../src/index.js';

describe('poster client', () => {
  it('is still the S01 placeholder, not generated output', () => {
    expect(CLIENT_GENERATED).toBe(false);
  });

  it('targets the contract version in docs/ (D-027)', () => {
    expect(TARGET_CONTRACT_VERSION).toBe('1.1');
  });
});
