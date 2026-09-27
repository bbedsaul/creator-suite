/**
 * Live aggregator smoke tests — the other half of S09 (D-082).
 *
 * Excluded from `pnpm test` and from CI. Run with:
 *
 *   pnpm -F @suite/poster-service test:live
 *
 * Two gates, not one, and the second one matters:
 *
 *   LIVE_ADAPTER_TESTS=1     read-only. Checks auth, the connected-account
 *                            endpoints, and that a lookup for an attempt that
 *                            never happened answers correctly. Safe to run any
 *                            time; posts nothing.
 *   LIVE_ADAPTER_PUBLISH=1   actually publishes to the linked accounts. Separate
 *                            because a test that posts publicly as a side effect
 *                            of `test:live` is a trap, and because these posts are
 *                            real and visible.
 *
 * Every response is printed, so this doubles as the fixture-refresh tool
 * described in test/fixtures/adapters/PROVENANCE.md. Scrub before committing.
 *
 * Credentials come from the environment and are never written anywhere: rule 5
 * applies to tests too.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAyrshareAdapter } from '../../src/adapters/ayrshare.js';
import { createUploadPostAdapter } from '../../src/adapters/upload-post.js';
import type { AdapterCredential, PlatformAdapter } from '../../src/adapters/adapter.js';

const LIVE = process.env['LIVE_ADAPTER_TESTS'] === '1';
const PUBLISH = process.env['LIVE_ADAPTER_PUBLISH'] === '1';

const UPLOAD_POST_KEY = process.env['UPLOAD_POST_API_KEY'];
const UPLOAD_POST_USER = process.env['UPLOAD_POST_USER'];
const AYRSHARE_KEY = process.env['AYRSHARE_API_KEY'];
/** A publicly fetchable 60 s vertical video. See docs/S09-acceptance.md step 5. */
const MEDIA_URL = process.env['LIVE_MEDIA_URL'];

/** Platforms the spike targets. Both must be linked at both providers. */
const PLATFORMS = ['tiktok', 'youtube'] as const;

function credential(secret: string, provider: string): AdapterCredential {
  return { kind: 'aggregator_profile', provider, secret };
}

function show(label: string, value: unknown): void {
  // Printed so a real response can be copied into a fixture. Outcomes are already
  // scrubbed by the adapter, but re-check before committing anything.
  console.log(`\n--- ${label} ---\n${JSON.stringify(value, null, 2)}`);
}

interface Provider {
  readonly name: string;
  readonly adapter: PlatformAdapter;
  readonly secret: string;
  readonly account: string;
}

function providers(): Provider[] {
  const out: Provider[] = [];

  if (UPLOAD_POST_KEY !== undefined && UPLOAD_POST_USER !== undefined) {
    out.push({
      name: 'upload-post',
      // Verified platforms are passed in here, not hard-coded in the adapter:
      // this run is what does the verifying (D-083).
      adapter: createUploadPostAdapter({ platforms: PLATFORMS }),
      secret: UPLOAD_POST_KEY,
      account: UPLOAD_POST_USER,
    });
  }

  if (AYRSHARE_KEY !== undefined) {
    out.push({
      name: 'ayrshare',
      adapter: createAyrshareAdapter({ platforms: PLATFORMS }),
      secret: AYRSHARE_KEY,
      // Ayrshare addresses the profile by API key, so there is no separate handle.
      account: 'primary',
    });
  }

  return out;
}

describe.skipIf(!LIVE)('live: aggregator read-only checks', () => {
  const configured = providers();

  it('has at least one provider configured', () => {
    expect(
      configured.length,
      'Set UPLOAD_POST_API_KEY + UPLOAD_POST_USER and/or AYRSHARE_API_KEY in .env.local',
    ).toBeGreaterThan(0);
  });

  for (const provider of configured) {
    for (const platformId of PLATFORMS) {
      it(`${provider.name}: reports ${platformId} connection health`, async () => {
        const health = await provider.adapter.checkConnection({
          credential: credential(provider.secret, provider.name),
          platformId,
          externalAccountId: provider.account,
          timeoutMs: 15_000,
        });
        show(`${provider.name} checkConnection ${platformId}`, health);

        // `unknown` means we could not read the provider's answer at all, which is
        // a failure of this test rather than a finding about the account.
        expect(health.kind).not.toBe('unknown');
      });
    }

    it(`${provider.name}: answers a lookup for an attempt that never happened`, async () => {
      const outcome = await provider.adapter.lookup({
        attemptRef: randomUUID(),
        credential: credential(provider.secret, provider.name),
        target: {
          targetId: randomUUID(),
          platformId: 'tiktok',
          externalAccountId: provider.account,
          text: `never posted ${randomUUID()}`,
          title: null,
        },
        timeoutMs: 15_000,
      });
      show(`${provider.name} lookup (nonexistent)`, outcome);

      // The heart of the scorecard, measured rather than read off a docs page:
      // a provider that can be queried by our reference proves absence, and one
      // that cannot must say so.
      expect(outcome.kind).toBe(provider.adapter.supportsReferenceLookup ? 'absent' : 'unknown');
    });
  }
});

describe.skipIf(!LIVE || !PUBLISH)('live: publishing (posts for real)', () => {
  const configured = providers();

  it('has a fetchable media URL', () => {
    expect(
      MEDIA_URL,
      'Set LIVE_MEDIA_URL to a publicly reachable 60 s vertical mp4 (docs/S09-acceptance.md)',
    ).toBeTruthy();
  });

  for (const provider of configured) {
    for (const platformId of PLATFORMS) {
      it(`${provider.name}: publishes to ${platformId} and can find it again`, async () => {
        if (MEDIA_URL === undefined) return;

        const attemptRef = randomUUID();
        const target = {
          targetId: randomUUID(),
          platformId,
          externalAccountId: provider.account,
          text: `Creator Suite S09 spike ${attemptRef}`,
          title: `Creator Suite S09 spike ${attemptRef}`,
        };

        const outcome = await provider.adapter.publish({
          attemptRef,
          credential: credential(provider.secret, provider.name),
          target,
          renditions: [
            {
              mediaId: randomUUID(),
              kind: 'video',
              mimeType: 'video/mp4',
              url: MEDIA_URL,
              durationS: 60,
            },
          ],
          timeoutMs: 120_000,
        });
        show(`${provider.name} publish ${platformId}`, outcome);

        expect(JSON.stringify(outcome)).not.toContain(provider.secret);
        expect(outcome.kind).toBe('success');

        // Criterion 2 of S09: a permalink, so the post can be seen.
        if (outcome.kind === 'success') {
          expect(outcome.permalink, 'no permalink in the publish response').toBeTruthy();
        }

        const found = await provider.adapter.lookup({
          attemptRef,
          credential: credential(provider.secret, provider.name),
          target,
          timeoutMs: 15_000,
        });
        show(`${provider.name} lookup after publish ${platformId}`, found);

        expect(found.kind).toBe('found');
      }, 180_000);
    }
  }
});
