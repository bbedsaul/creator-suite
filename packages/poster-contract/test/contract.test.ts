import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '../src/index.js';

describe('poster contract', () => {
  it('declares the contract version the repo doc is at (D-027)', () => {
    expect(CONTRACT_VERSION).toBe('1.1');
  });
});
