import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_COLOR_TOKENS,
  REQUIRED_TOKEN_PREFIXES,
  REQUIRED_TYPE_TOKENS,
} from '../src/index.js';

const css = readFileSync(fileURLToPath(new URL('../src/tokens.css', import.meta.url)), 'utf8');

/** The `:root` block only, so we can tell light values from the dark override. */
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const darkBlock = /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

describe('design tokens', () => {
  it('defines a light value on :root for every required color token', () => {
    expect(rootBlock).not.toBe('');
    for (const token of REQUIRED_COLOR_TOKENS) {
      expect(rootBlock, `missing ${token} on :root`).toContain(`${token}:`);
    }
  });

  it('overrides every color token in the dark scope', () => {
    expect(darkBlock).not.toBe('');
    for (const token of REQUIRED_COLOR_TOKENS) {
      expect(darkBlock, `missing ${token} in dark scope`).toContain(`${token}:`);
    }
  });

  it('defines the display, body, and mono families (D-003)', () => {
    for (const token of REQUIRED_TYPE_TOKENS) {
      expect(rootBlock).toContain(`${token}:`);
    }
    expect(rootBlock).toContain('Sora');
    expect(rootBlock).toContain('Instrument Sans');
  });

  it('defines at least one token in each required scale', () => {
    for (const prefix of REQUIRED_TOKEN_PREFIXES) {
      expect(rootBlock, `no ${prefix}* token`).toMatch(new RegExp(`${prefix}[a-z0-9]+:`));
    }
  });

  it('is still marked as a placeholder export, not the real design system', () => {
    expect(css).toContain('TODO: export from design system');
  });
});
