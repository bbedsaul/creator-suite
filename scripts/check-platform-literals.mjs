#!/usr/bin/env node
/**
 * Fails when a platform limit is written as a literal in TypeScript (CLAUDE.md
 * rule 9, S04 acceptance criterion 3).
 *
 *   node scripts/check-platform-literals.mjs
 *
 * Platform limits are data: they live in supabase/seed-data/platform-constraints,
 * are stored in `poster.platform_constraints`, and are served by
 * GET /v1/platforms/constraints. A number baked into a .ts file is a limit that
 * cannot be corrected without a deploy, and that will silently disagree with what
 * the API tells clients.
 *
 * Two rules, both narrow on purpose — a check that cries wolf gets disabled:
 *
 *   1. No numeric literal assigned to, or compared against, a limit-shaped name
 *      (max_length, max_duration_s, max_count, aspect ratio, and friends).
 *   2. No platform id (tiktok, youtube, …) in application code outside the
 *      places that legitimately name one: adapters, and the spec loader.
 *
 * Exceptions go in ALLOWLIST below with a reason, so waiving a case is a
 * reviewable diff rather than a quietly loosened regex.
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose src/ is application code subject to the rules. */
const ROOTS = ['services', 'packages', 'apps'];

/** Paths that may legitimately name a platform. */
const PLATFORM_NAME_ALLOWED = [
  /^services\/[^/]+\/src\/adapters\//,
  /^packages\/media-pipeline\/src\//,
];

/**
 * Specific waivers: { file, line substring, reason }. A waiver must name the
 * exact text it excuses, so it cannot silently cover a later addition.
 */
const ALLOWLIST = [
  {
    file: 'packages/poster-contract/src/openapi.ts',
    line: 'maxLength: 255',
    reason:
      'Our own Idempotency-Key length cap, documented in the spec and mirroring the ' +
      'length(key) between 1 and 255 check on poster.idempotency_keys. It is an API ' +
      'limit we set, not a platform rule we are told, so it does not belong in a ' +
      'constraint spec.',
  },
];

const LIMIT_NAME = String.raw`(?:max|min)_?(?:length|duration(?:_s|_ms)?|count|size|bytes|width|height|parts|attempts)|aspect_ratio|max_video_post_duration_sec`;

/** `max_length: 2200`, `maxDuration = 600`, `x.max_count > 10`, `=== 2200` after a limit name. */
const LIMIT_LITERAL = new RegExp(
  String.raw`\b(${LIMIT_NAME})\b\s*(?::|=|===|==|>=|<=|>|<)\s*(-?\d[\d_]*(?:\.\d+)?)`,
  'i',
);

const PLATFORM_IDS = ['tiktok', 'youtube', 'instagram', 'linkedin', 'facebook_pages'];
const PLATFORM_ID = new RegExp(String.raw`['"\`](${PLATFORM_IDS.join('|')})['"\`]`, 'i');

function walk(directory) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function sourceFiles() {
  return ROOTS.flatMap((root) =>
    walk(join(repoRoot, root)).filter((file) => relative(repoRoot, file).includes('/src/')),
  );
}

function scan(files) {
  const findings = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const lines = readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (code.trim() === '' || code.trim().startsWith('*')) return;

      const waived = ALLOWLIST.some((entry) => entry.file === rel && code.includes(entry.line));
      if (waived) return;

      const limit = LIMIT_LITERAL.exec(code);
      if (limit !== null) {
        findings.push({
          rel,
          line: index + 1,
          rule: 'limit-literal',
          detail: `${limit[1]} = ${limit[2]}`,
          text: line.trim(),
        });
      }

      const platform = PLATFORM_ID.exec(code);
      if (platform !== null && !PLATFORM_NAME_ALLOWED.some((pattern) => pattern.test(rel))) {
        findings.push({
          rel,
          line: index + 1,
          rule: 'platform-name',
          detail: platform[1],
          text: line.trim(),
        });
      }
    });
  }
  return findings;
}

/**
 * Proves the scan can go red. A check that only ever passes is indistinguishable
 * from a check that sees nothing (the lesson of D-033 and D-054).
 */
function selfTest() {
  const probe = join(repoRoot, 'services', 'poster', 'src', '__limit_check_probe__.ts');
  const cases = [
    { rule: 'limit-literal', source: 'export const spec = { max_length: 2200 };\n' },
    { rule: 'platform-name', source: "export const platform = 'tiktok';\n" },
  ];

  let failures = 0;
  for (const testCase of cases) {
    writeFileSync(probe, testCase.source, 'utf8');
    try {
      const found = scan([probe]).filter((finding) => finding.rule === testCase.rule);
      if (found.length === 0) {
        console.error(`FAIL ${testCase.rule}: not detected in ${testCase.source.trim()}`);
        failures += 1;
      } else {
        console.log(`ok   ${testCase.rule}: rejected \`${testCase.source.trim()}\``);
      }
    } finally {
      rmSync(probe, { force: true });
    }
  }

  if (scan([]).length !== 0) {
    console.error('FAIL: scanning nothing produced findings');
    failures += 1;
  }

  if (failures > 0) process.exit(1);
  console.log(`all ${String(cases.length)} rules can fail`);
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

const files = sourceFiles();
const findings = scan(files);

if (findings.length > 0) {
  console.error(`Platform limits must be data, not TypeScript literals (CLAUDE.md rule 9).\n`);
  for (const finding of findings) {
    console.error(`  ${finding.rel}:${String(finding.line)}  [${finding.rule}] ${finding.detail}`);
    console.error(`    ${finding.text}`);
  }
  console.error(
    `\n${String(findings.length)} finding(s). Put the value in ` +
      `supabase/seed-data/platform-constraints/<platform>.json and read it from the spec, ` +
      `or add a reviewed waiver to ALLOWLIST in scripts/check-platform-literals.mjs.`,
  );
  process.exit(1);
}

console.log(
  `No platform limits hard-coded in TypeScript (${String(files.length)} source file(s) scanned).`,
);
