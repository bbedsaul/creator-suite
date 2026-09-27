/**
 * The M1 exit demo.
 *
 * Exercises the whole publish path the way a future app has to: over HTTP,
 * through `@suite/poster-client`, with no access to the database and no imports
 * from `services/*` (D-022, enforced by `pnpm lint:deps`). If this passes, an
 * integrator can do what it does.
 *
 * It checks the M1 exit criteria that are observable from outside:
 *
 *   - an API client submits a scheduled video post to TikTok and YouTube;
 *   - each target posts within 60 s of `schedule_at` and **not before** (NFR-01);
 *   - signed webhooks arrive, verified by the reference consumer;
 *   - no target posts twice (NFR-02), as far as the event stream can show.
 *
 * The chaos criterion — 100 kills, zero double-posts — is not here. It needs to
 * kill the worker process, which an HTTP client cannot do; it is proven by
 * `services/poster/test/integration/chaos.test.ts` (D-076).
 *
 * What it deliberately does not do is create its own user or connections. There
 * is no Connections API in M1 (contract §4 is M2), so those are set up by
 * `pnpm -F @suite/poster-service seed:demo` and passed in (D-094).
 */
import { randomUUID } from 'node:crypto';
import { createPosterClient, unwrap, type PosterClient } from '@suite/poster-client';
import { WebhookEnvelope } from '@suite/poster-contract';
import { createWebhookSink, type ReceivedEvent, type WebhookSink } from '@suite/webhook-sink';
import { buildFixtureVideo } from './fixture-video.js';

export interface DemoConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userId: string;
  readonly connections: Readonly<Record<'tiktok' | 'youtube', string>>;
  readonly webhookSecret: string;
  readonly webhookPort: number;
  /** Seconds between submitting and `schedule_at`. */
  readonly scheduleLeadS: number;
  /** How long to wait for the terminal webhooks before giving up. */
  readonly webhookTimeoutMs: number;
  readonly log?: (line: string) => void;
}

export interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DemoReport {
  readonly steps: readonly StepResult[];
  readonly ok: boolean;
  readonly postId?: string;
  /** Lag per target in seconds: positive is late, negative is early. */
  readonly lagS: Readonly<Record<string, number>>;
}

/** The §7 window the contract promises, and therefore what we assert. */
const PUNCTUALITY_BUDGET_S = 60;

class StepFailure extends Error {}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new StepFailure(message);
}

async function fetchToken(config: DemoConfig): Promise<string> {
  const anonymous = createPosterClient({ baseUrl: config.baseUrl });
  const result = await anonymous.POST('/v1/oauth/token', {
    body: {
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
  });
  return unwrap(result).access_token;
}

/** Waits until `predicate` holds over the events received so far, or times out. */
async function waitFor(
  sink: WebhookSink,
  predicate: (events: readonly ReceivedEvent[]) => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(sink.received)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new StepFailure(
    `timed out after ${String(timeoutMs)}ms waiting for ${what}; ` +
      `received ${String(sink.received.length)} event(s): ` +
      sink.received.map((event) => event.type).join(', '),
  );
}

/** Parses an accepted event into the contract's envelope, rejecting junk. */
function envelopeOf(event: ReceivedEvent): ReturnType<typeof WebhookEnvelope.parse> {
  return WebhookEnvelope.parse(event.body);
}

/**
 * Accepted, first-delivery events of one type **for one post**.
 *
 * Scoping to the post is not tidiness, it is correctness. The outbox delivers
 * everything the app has ever done that is still within its retry window, so a
 * shared or previously-used environment hands the sink a backlog of unrelated
 * events. A real consumer has to key off the post or `external_ref` too; counting
 * "all post.posted events" would make the demo pass or fail on history.
 */
function eventsFor(
  sink: WebhookSink,
  type: string,
  postId: string | undefined,
): ReturnType<typeof envelopeOf>[] {
  return sink.received
    .filter((event) => !event.duplicate && event.type === type)
    .map((event) => envelopeOf(event))
    .filter((envelope) => postId === undefined || envelope.post_id === postId);
}

/** Counts distinct targets that have a given event type for a post. */
function targetsWith(sink: WebhookSink, type: string, postId: string | undefined): number {
  return new Set(eventsFor(sink, type, postId).map((envelope) => envelope.target_id)).size;
}

export async function runDemo(config: DemoConfig): Promise<DemoReport> {
  const log = config.log ?? (() => {});
  const steps: StepResult[] = [];
  const lagS: Record<string, number> = {};
  let postId: string | undefined;
  let sink: WebhookSink | undefined;

  async function step(name: string, body: () => Promise<string>): Promise<void> {
    log(`… ${name}`);
    try {
      const detail = await body();
      steps.push({ name, ok: true, detail });
      log(`✓ ${name} — ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      steps.push({ name, ok: false, detail });
      log(`✗ ${name} — ${detail}`);
      throw error;
    }
  }

  let client: PosterClient | undefined;
  let scheduleAt = new Date();
  let mediaId = '';
  const targetIds: string[] = [];

  try {
    // The sink comes up first: the outbox may deliver post.scheduled the moment
    // the post is accepted, and an event delivered to a closed port is a retry we
    // would then have to wait out.
    sink = createWebhookSink({ secret: config.webhookSecret });
    const port = await sink.listen(config.webhookPort);
    log(`webhook sink listening on ${String(port)}`);

    await step('authenticate (app mode)', async () => {
      const token = await fetchToken(config);
      client = createPosterClient({ baseUrl: config.baseUrl, getToken: () => token });
      return `bearer token acquired for ${config.clientId}`;
    });

    await step('confirm identity', async () => {
      const context = unwrap(await client!.GET('/v1/auth/context', {}));
      assert(context.mode === 'app', `expected app mode, got ${context.mode}`);
      assert(
        context.app.client_id === config.clientId,
        `token belongs to ${context.app.client_id}, not ${config.clientId}`,
      );
      return `mode=${context.mode} app=${context.app.client_id} first_party=${String(context.app.first_party)}`;
    });

    await step('read platform constraints', async () => {
      const { platforms } = unwrap(await client!.GET('/v1/platforms/constraints', {}));
      const ids = platforms.map((platform) => platform.platform_id);
      for (const needed of ['tiktok', 'youtube']) {
        assert(ids.includes(needed), `${needed} is not an enabled platform`);
      }
      // Read, not assumed: rule 9 says limits are data, so the demo quotes them
      // rather than hard-coding what it thinks they are.
      const described = platforms
        .map((platform) => {
          const spec = platform.spec as { video?: { max_duration_s?: number } };
          return `${platform.platform_id}≤${String(spec.video?.max_duration_s ?? '?')}s`;
        })
        .join(' ');
      return `${String(platforms.length)} platform(s): ${described}`;
    });

    await step('upload a video', async () => {
      const video = buildFixtureVideo({ durationS: 3 });
      // `POST /v1/media` answers 201 with the media or 202 with an upload URL, so
      // the generated type is a union. A multipart upload is the direct path and
      // must come back ready; anything else means the API took the signed-URL
      // branch, which this step did not ask for.
      const response = unwrap(
        await client!.POST('/v1/media', {
          body: { user_id: config.userId, file: video as unknown as string },
          bodySerializer: (body) => {
            // Multipart stays inside the client: the wire shape is the spec's,
            // this only decides how the two fields are encoded.
            const form = new FormData();
            const fields = body as unknown as { user_id: string; file: Buffer };
            form.set('user_id', fields.user_id);
            form.set(
              'file',
              new Blob([new Uint8Array(fields.file)], { type: 'video/mp4' }),
              'm1-demo.mp4',
            );
            return form;
          },
        }),
      );
      assert('kind' in response, 'a multipart upload returned a signed-URL response');
      const media = response as Extract<typeof response, { kind: unknown }>;

      assert(media.status === 'ready', `media is ${media.status}, expected ready`);
      assert(media.kind === 'video', `media is ${media.kind}, expected video`);
      // Measured server-side from the file, never taken from us (contract §5).
      assert(media.width === 1080 && media.height === 1920, 'dimensions were not read back');
      mediaId = media.media_id;
      return `${mediaId} ${String(media.width)}x${String(media.height)} ${String(media.duration_s)}s`;
    });

    const content = { text: 'Creator Suite M1 exit demo', media: [mediaId] };
    const targets = [
      { connection_id: config.connections.tiktok, overrides: { text: 'M1 exit demo #shorts' } },
      { connection_id: config.connections.youtube, overrides: { title: 'M1 exit demo' } },
    ];

    await step('validate without submitting', async () => {
      const result = unwrap(
        await client!.POST('/v1/posts/validate', {
          body: { user_id: config.userId, content, targets },
        }),
      );
      assert(result.valid, 'validation reported the post as invalid');
      return `${String(result.targets.length)} target(s) would be accepted`;
    });

    const idempotencyKey = `m1-demo-${randomUUID()}`;
    const externalRef = `m1-demo/${randomUUID()}`;

    await step('submit a scheduled post', async () => {
      scheduleAt = new Date(Date.now() + config.scheduleLeadS * 1000);
      const submitted = unwrap(
        await client!.POST('/v1/posts', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            user_id: config.userId,
            external_ref: externalRef,
            content,
            targets,
            schedule_at: scheduleAt.toISOString(),
          },
        }),
      );
      postId = submitted.post_id;
      assert(
        submitted.targets.length === 2,
        `expected 2 targets, got ${String(submitted.targets.length)}`,
      );
      targetIds.push(...submitted.targets.map((target) => target.target_id));
      return `${postId} due ${scheduleAt.toISOString()} with ${String(submitted.targets.length)} targets`;
    });

    await step('replay the same Idempotency-Key', async () => {
      const replay = unwrap(
        await client!.POST('/v1/posts', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            user_id: config.userId,
            external_ref: externalRef,
            content,
            targets,
            schedule_at: scheduleAt.toISOString(),
          },
        }),
      );
      // FR-14: the same key returns the original result rather than a second post.
      assert(replay.post_id === postId, `replay created ${replay.post_id}, not ${String(postId)}`);
      return `returned the original ${replay.post_id}`;
    });

    await step('receive signed post.scheduled webhooks', async () => {
      await waitFor(
        sink!,
        () => targetsWith(sink!, 'post.scheduled', postId) >= 2,
        config.webhookTimeoutMs,
        'post.scheduled for both targets',
      );
      const scheduled = eventsFor(sink!, 'post.scheduled', postId);
      // Signature verification already happened in the sink: an event that failed
      // it never reaches `received`. Asserting zero rejections says so explicitly.
      assert(
        sink!.rejected.length === 0,
        `sink rejected ${String(sink!.rejected.length)} event(s)`,
      );
      for (const event of scheduled) {
        assert(event.external_ref === externalRef, 'external_ref was not echoed back');
      }
      return `${String(scheduled.length)} verified, external_ref echoed`;
    });

    await step('post within the punctuality budget', async () => {
      await waitFor(
        sink!,
        () => targetsWith(sink!, 'post.posted', postId) >= 2,
        config.webhookTimeoutMs,
        'post.posted for both targets',
      );

      const posted = eventsFor(sink!, 'post.posted', postId);
      for (const event of posted) {
        const lag = (Date.parse(event.occurred_at) - scheduleAt.getTime()) / 1000;
        lagS[event.target_id ?? 'unknown'] = lag;
        // Not early is as much a requirement as not late (NFR-01): a post that
        // goes out before its time is a scheduling bug, not a fast success.
        assert(lag >= 0, `target ${String(event.target_id)} posted ${String(-lag)}s early`);
        assert(
          lag <= PUNCTUALITY_BUDGET_S,
          `target ${String(event.target_id)} posted ${String(lag)}s late`,
        );
      }
      const worst = Math.max(...Object.values(lagS));
      return `${String(posted.length)} posted, worst lag ${worst.toFixed(2)}s of ${String(PUNCTUALITY_BUDGET_S)}s`;
    });

    await step('carry a permalink on every post.posted', async () => {
      const posted = eventsFor(sink!, 'post.posted', postId);
      for (const event of posted) {
        const data = event.data as { permalink?: unknown };
        assert(
          typeof data.permalink === 'string' && data.permalink !== '',
          `target ${String(event.target_id)} posted with no permalink`,
        );
      }
      return `${String(posted.length)} permalink(s)`;
    });

    await step('post no target twice', async () => {
      const posted = eventsFor(sink!, 'post.posted', postId);
      const perTarget = new Map<string, number>();
      for (const event of posted) {
        const key = event.target_id ?? 'unknown';
        perTarget.set(key, (perTarget.get(key) ?? 0) + 1);
      }
      for (const [target, count] of perTarget) {
        // Delivery is at-least-once, so duplicate *deliveries* are expected and
        // are filtered by event_id above. Two distinct post.posted events for one
        // target would be a genuine double post (NFR-02).
        assert(count === 1, `target ${target} has ${String(count)} distinct post.posted events`);
      }
      const duplicateDeliveries = sink!.received.filter((event) => event.duplicate).length;
      assert(perTarget.size === 2, `expected 2 targets, saw ${String(perTarget.size)}`);
      return `${String(perTarget.size)} target(s), 1 event each (${String(duplicateDeliveries)} duplicate deliveries de-duped)`;
    });

    await step('read the post back', async () => {
      assert(postId !== undefined, 'no post id');
      // `user_id` is required in app mode: the token carries no user, so the app
      // says which one it is acting for (contract §5.3, declared in v1.6).
      const post = unwrap(
        await client!.GET('/v1/posts/{post_id}', {
          params: { path: { post_id: postId! }, query: { user_id: config.userId } },
        }),
      );
      for (const target of post.targets) {
        assert(
          target.state === 'posted',
          `target ${target.target_id} is ${target.state}, expected posted`,
        );
        assert(
          typeof target.permalink === 'string' && target.permalink !== '',
          `target ${target.target_id} has no permalink`,
        );
      }
      return `${String(post.targets.length)} target(s) posted, per-target permalinks present`;
    });
  } catch {
    // Already recorded as a failed step; the report carries the detail.
  } finally {
    if (sink !== undefined) await sink.close();
  }

  return {
    steps,
    ok: steps.length > 0 && steps.every((entry) => entry.ok),
    ...(postId === undefined ? {} : { postId }),
    lagS,
  };
}
