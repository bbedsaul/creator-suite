/**
 * `pnpm -F @suite/m1-demo start`
 *
 * Reads configuration from the environment, runs the demo, prints a table, and
 * exits non-zero if any step failed — so it works as a smoke test in a deploy
 * pipeline as well as a demonstration.
 *
 * Prerequisites, in order:
 *   pnpm -F @suite/poster-service seed          # registers the m1-demo app
 *   pnpm -F @suite/poster-service seed:demo     # user, connections, grant, webhook
 *   pnpm -F @suite/poster-service dev:api
 *   M1_DEMO_WEBHOOK_SECRET=… pnpm -F @suite/poster-service dev:worker
 */
import { runDemo, type DemoConfig } from './index.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`Missing ${name}. See the header of tools/m1-demo/src/cli.ts.`);
    process.exit(2);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`${name} must be a number, got ${raw}`);
    process.exit(2);
  }
  return parsed;
}

const config: DemoConfig = {
  baseUrl: process.env['POSTER_BASE_URL'] ?? 'http://127.0.0.1:8080',
  clientId: process.env['DEMO_CLIENT_ID'] ?? 'm1-demo',
  clientSecret: required('SEED_SECRET_M1_DEMO'),
  userId: required('DEMO_USER_ID'),
  connections: {
    tiktok: required('DEMO_TIKTOK_CONNECTION'),
    youtube: required('DEMO_YOUTUBE_CONNECTION'),
  },
  webhookSecret: required('M1_DEMO_WEBHOOK_SECRET'),
  webhookPort: optionalNumber('DEMO_WEBHOOK_PORT', 4100),
  scheduleLeadS: optionalNumber('DEMO_SCHEDULE_LEAD_S', 5),
  webhookTimeoutMs: optionalNumber('DEMO_WEBHOOK_TIMEOUT_MS', 90_000),
  log: (line) => {
    console.log(line);
  },
};

console.log(`M1 exit demo → ${config.baseUrl}\n`);

const report = await runDemo(config);

console.log('\n─── Steps ───');
for (const step of report.steps) {
  console.log(`${step.ok ? '✓' : '✗'} ${step.name.padEnd(40)} ${step.detail}`);
}

if (Object.keys(report.lagS).length > 0) {
  console.log('\n─── Dispatch lag (s, positive = late) ───');
  for (const [target, lag] of Object.entries(report.lagS)) {
    console.log(`  ${target}  ${lag.toFixed(3)}`);
  }
}

console.log(
  `\n${report.ok ? 'PASS' : 'FAIL'} — ${String(report.steps.filter((step) => step.ok).length)}/${String(report.steps.length)} steps` +
    (report.postId === undefined ? '' : `, post ${report.postId}`),
);

process.exit(report.ok ? 0 : 1);
