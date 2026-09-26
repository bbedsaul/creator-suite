#!/usr/bin/env node
/**
 * Proves `pnpm lint:deps` actually catches D-022 violations.
 *
 * A boundary check that passes tells you nothing on its own - it passes just as
 * happily when it is misconfigured and sees no edges at all. This writes
 * deliberately forbidden imports, asserts the cruise fails and names the
 * expected rule, then removes them. S01 acceptance criterion 4.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each case plants files (and, where a real import needs it, the node_modules
 * symlink pnpm would create if the dependency were declared), then expects the
 * named rule to fire.
 */
const cases = [
  {
    name: 'service importing packages/ui by package name',
    rule: 'no-backend-to-frontend',
    files: {
      'services/poster/src/__boundary_violation__.ts':
        "import { TOKENS_ARE_PLACEHOLDERS } from '@suite/ui';\n" +
        'export const leak = TOKENS_ARE_PLACEHOLDERS;\n',
    },
    // packages/ui is deliberately NOT a dependency of the service, so pnpm has
    // not linked it. Link it here so the specifier resolves and the boundary
    // rule is what rejects the import, rather than the module being unresolvable.
    symlinks: { 'services/poster/node_modules/@suite/ui': '../../../../packages/ui' },
  },
  {
    name: 'service reaching into packages/ui by relative path',
    rule: 'no-backend-to-frontend',
    files: {
      'services/poster/src/__boundary_violation__.ts':
        "import { TOKENS_ARE_PLACEHOLDERS } from '../../../packages/ui/src/index.js';\n" +
        'export const leak = TOKENS_ARE_PLACEHOLDERS;\n',
    },
  },
  {
    name: 'app importing a service directly instead of over HTTP',
    rule: 'no-frontend-to-backend',
    files: {
      'apps/__probe__/src/main.ts':
        "import { loadConfig } from '../../../services/poster/src/config.js';\n" +
        'export const config = loadConfig();\n',
    },
  },
];

function cruise() {
  return spawnSync('pnpm', ['exec', 'depcruise', '.', '--config', '.dependency-cruiser.cjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

const baseline = cruise();
if (baseline.status !== 0) {
  console.error('The tree already violates lint:deps; fix that before running this check.\n');
  console.error(baseline.stdout || baseline.stderr);
  process.exit(1);
}
console.log('baseline: lint:deps passes on the clean tree\n');

let failures = 0;

for (const testCase of cases) {
  const planted = [];
  try {
    for (const [relative, source] of Object.entries(testCase.files)) {
      const absolute = join(repoRoot, relative);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, source, 'utf8');
      planted.push(absolute);
    }
    for (const [relative, target] of Object.entries(testCase.symlinks ?? {})) {
      const absolute = join(repoRoot, relative);
      mkdirSync(dirname(absolute), { recursive: true });
      rmSync(absolute, { force: true, recursive: true });
      symlinkSync(target, absolute, 'dir');
      planted.push(absolute);
    }

    const result = cruise();
    const output = `${result.stdout}${result.stderr}`;

    if (result.status === 0) {
      console.error(`FAIL ${testCase.name}: lint:deps passed but should have failed`);
      failures += 1;
    } else if (!output.includes(testCase.rule)) {
      console.error(
        `FAIL ${testCase.name}: cruise failed without naming ${testCase.rule}:\n${output}`,
      );
      failures += 1;
    } else {
      console.log(`ok   ${testCase.name}`);
      console.log(`     rejected by ${testCase.rule}`);
    }
  } finally {
    for (const absolute of planted.reverse()) {
      rmSync(absolute, { force: true, recursive: true });
    }
    // The probe app directory only ever holds the planted file. Remove apps/
    // itself too if this check created it: git does not track empty directories,
    // so a leftover apps/ is invisible in `git status` but real on disk, and the
    // service is required to run with no apps/ present (D-022).
    rmSync(join(repoRoot, 'apps/__probe__'), { force: true, recursive: true });
    const apps = join(repoRoot, 'apps');
    try {
      if (readdirSync(apps).length === 0) rmSync(apps, { recursive: true });
    } catch {
      // apps/ does not exist, which is the desired state.
    }
  }
}

const restored = cruise();
if (restored.status !== 0) {
  console.error('\nlint:deps still fails after cleanup; something was left behind.');
  console.error(restored.stdout || restored.stderr);
  process.exit(1);
}
console.log('\ncleanup: lint:deps passes again');

if (failures > 0) {
  console.error(`${failures} boundary rule(s) did not fire.`);
  process.exit(1);
}
console.log(`all ${cases.length} boundary violations were rejected`);
