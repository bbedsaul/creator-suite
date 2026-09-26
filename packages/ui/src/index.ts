/**
 * @suite/ui — frontend-only shared code (D-022): design tokens and the
 * components every Creator Suite UI is built from (D-003).
 *
 * Nothing in services/* may import this package; `pnpm lint:deps` enforces it.
 * The component set (Button, StatusBadge, PlatformChip, ...) arrives with the
 * first screens in M3. S01 establishes the package and the token contract.
 *
 * Import the tokens as `@suite/ui/tokens.css`.
 */

/** Token names every consumer may rely on, asserted against tokens.css in tests. */
export const REQUIRED_COLOR_TOKENS = [
  '--color-bg',
  '--color-surface',
  '--color-border',
  '--color-text',
  '--color-text-muted',
  '--color-accent',
  '--color-accent-contrast',
  '--color-success',
  '--color-warning',
  '--color-danger',
  '--color-info',
] as const;

export const REQUIRED_TYPE_TOKENS = ['--font-display', '--font-body', '--font-mono'] as const;

export const REQUIRED_TOKEN_PREFIXES = [
  '--text-',
  '--space-',
  '--radius-',
  '--shadow-',
  '--duration-',
] as const;

/**
 * True until the real tokens are exported from the design system before the
 * first M3 screen. Kept as a value so a future check can refuse to build a
 * production bundle on placeholder values.
 */
export const TOKENS_ARE_PLACEHOLDERS = true as const;
