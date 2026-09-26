/**
 * Post submission, read, edit and cancel (contract §5, §6, FR-13, FR-14).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PatchPostRequest,
  SubmitPostRequest,
  encodeId,
  tryDecodeId,
  type CancelPostResponse,
  type Post,
  type PostDetail,
  type PostState,
  type PostTargetDetail,
  type PostTargetSummary,
} from '@suite/poster-contract';
import type { RateLimiter } from '@suite/server-core';
import { ApiError } from '../errors.js';
import { enforceAppLimit } from '../plugins/rate-limit.js';
import type { GrantStore } from '../../db/grants.js';
import type { PlatformConstraintStore } from '../../db/platform-constraints.js';
import {
  hashRequest,
  type PostRow,
  type PostScope,
  type PostStore,
  type TargetRow,
} from '../../db/posts.js';
import type { ValidationContextStore } from '../../db/validation-context.js';
import { resolveSubmission } from '../../posts/submission.js';
import type { ResolvedAuth } from '../plugins/auth.js';

export interface PostRouteDeps {
  readonly posts: PostStore;
  readonly constraints: PlatformConstraintStore;
  readonly context: ValidationContextStore;
  readonly grants: GrantStore;
  readonly rateLimiter: RateLimiter;
}

const IDEMPOTENCY_HEADER = 'idempotency-key';

/** States an edit is still possible from. Anything else means dispatch began. */
const EDITABLE = new Set(['accepted', 'scheduled', 'paused']);

function targetSummary(row: TargetRow): PostTargetSummary {
  return {
    target_id: encodeId('target', row.target_id),
    connection_id: encodeId('connection', row.connection_id),
    platform_id: row.platform_id,
    state: row.state,
    due_at: row.due_at.toISOString(),
    position: row.position,
  };
}

function targetDetail(row: TargetRow): PostTargetDetail {
  return {
    ...targetSummary(row),
    permalink: row.permalink,
    platform_post_id: row.platform_post_id,
    reason_class: row.reason_class as PostTargetDetail['reason_class'],
    platform_message: row.platform_message,
    attempt_count: row.attempt_count,
    posted_at: row.posted_at === null ? null : row.posted_at.toISOString(),
  };
}

function postDetail(post: PostRow, targets: TargetRow[]): PostDetail {
  return {
    post_id: encodeId('post', post.post_id),
    state: post.state as PostState,
    external_ref: post.external_ref,
    schedule_at: post.schedule_at === null ? null : post.schedule_at.toISOString(),
    content: post.content,
    created_at: post.created_at.toISOString(),
    targets: targets.map(targetDetail),
  };
}

/**
 * App mode is scoped to the app's own posts; user mode is scoped only to the user,
 * because the post is theirs whichever app created it and the composer should show
 * all of it (D-066).
 */
function scopeFor(auth: ResolvedAuth, postUuid: string, userId: string): PostScope {
  return { postUuid, userId, appId: auth.mode === 'app' ? auth.app.id : null };
}

function postUuidFrom(request: FastifyRequest): string {
  const { post_id: publicId } = request.params as { post_id?: string };
  const uuid = publicId === undefined ? undefined : tryDecodeId('post', publicId);
  // A malformed id is "no such post", never a 500 (rule 7, contract §8).
  if (uuid === undefined) throw ApiError.notFound('No such post');
  return uuid;
}

export function registerPostRoutes(app: FastifyInstance, deps: PostRouteDeps): void {
  // ---------------------------------------------------------------------------
  // POST /v1/posts
  // ---------------------------------------------------------------------------
  app.post('/v1/posts', async (request, reply): Promise<Post> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    const parsed = SubmitPostRequest.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.invalidRequest(
        `Invalid request body: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }
    const submission = parsed.data;

    if (auth.userId !== null && auth.userId !== submission.user_id) {
      throw ApiError.forbiddenUser();
    }

    const idempotencyKey = request.headers[IDEMPOTENCY_HEADER];
    const key = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : null;
    const requestHash = hashRequest(submission);

    // Validation runs before the key is claimed, so a request rejected for bad
    // content leaves no key behind and the client may fix it and retry with the
    // same key (D-063).
    const resolved = await resolveSubmission(
      {
        userId: submission.user_id,
        content: submission.content,
        targets: submission.targets,
        grantAppId: auth.mode === 'app' ? auth.app.id : null,
      },
      { context: deps.context, constraints: deps.constraints, grants: deps.grants },
    );

    const scheduleAt =
      submission.schedule_at === undefined ? null : new Date(submission.schedule_at);

    const outcome = await deps.posts.submit(
      {
        appId: auth.app.id,
        userId: submission.user_id,
        externalRef: submission.external_ref ?? null,
        content: submission.content,
        scheduleAt,
        targets: resolved.targets,
        mediaByPart: resolved.mediaByPart,
        idempotencyKey: key,
        requestHash,
      },
      (postUuid, targets) =>
        ({
          post_id: encodeId('post', postUuid),
          state: 'scheduled',
          external_ref: submission.external_ref ?? null,
          schedule_at: scheduleAt === null ? null : scheduleAt.toISOString(),
          content: submission.content,
          created_at: new Date().toISOString(),
          targets: targets.map((target) => ({
            target_id: encodeId('target', target.id),
            connection_id: submission.targets[target.position]?.connection_id ?? '',
            platform_id: resolved.targets[target.position]?.platformId ?? '',
            state: 'scheduled',
            due_at: (scheduleAt ?? new Date()).toISOString(),
            position: target.position,
          })),
        }) satisfies Post,
    );

    if (outcome.kind === 'replay') {
      if (!outcome.stored.requestHash.equals(requestHash)) {
        throw new ApiError(
          'idempotency_conflict',
          'This Idempotency-Key was already used with a different request body',
        );
      }
      void reply.code(outcome.stored.responseStatus ?? 202);
      return outcome.stored.responseBody as Post;
    }

    void reply.code(202);
    return outcome.body as Post;
  });

  // ---------------------------------------------------------------------------
  // GET /v1/posts/{post_id}
  // ---------------------------------------------------------------------------
  app.get('/v1/posts/:post_id', async (request): Promise<PostDetail> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    const userId = auth.userId;
    if (userId === null) {
      throw ApiError.invalidRequest('user_id is required to read a post in app mode');
    }

    const found = await deps.posts.find(scopeFor(auth, postUuidFrom(request), userId));
    if (found === undefined) throw ApiError.notFound('No such post');
    return postDetail(found.post, found.targets);
  });

  // ---------------------------------------------------------------------------
  // PATCH /v1/posts/{post_id}
  // ---------------------------------------------------------------------------
  app.patch('/v1/posts/:post_id', async (request): Promise<PostDetail> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    const userId = auth.userId;
    if (userId === null) {
      throw ApiError.invalidRequest('user_id is required to edit a post in app mode');
    }

    const parsed = PatchPostRequest.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.invalidRequest(
        `Invalid request body: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }

    const postUuid = postUuidFrom(request);
    const scope = scopeFor(auth, postUuid, userId);
    const found = await deps.posts.find(scope);
    if (found === undefined) throw ApiError.notFound('No such post');

    // Once anything has left the pre-dispatch states the content may already be
    // on its way, so an edit is refused rather than silently ignored (§6).
    if (found.targets.some((target) => !EDITABLE.has(target.state))) {
      throw new ApiError('too_late', 'A target has already begun dispatching');
    }

    const content = parsed.data.content ?? found.post.content;
    const targets =
      parsed.data.targets ??
      found.targets.map((target) => ({
        connection_id: encodeId('connection', target.connection_id),
      }));
    const scheduleAt =
      parsed.data.schedule_at === undefined
        ? found.post.schedule_at
        : parsed.data.schedule_at === null
          ? null
          : new Date(parsed.data.schedule_at);

    // Edits re-validate (FR-13): the same path a submission takes.
    const resolved = await resolveSubmission(
      {
        userId,
        content,
        targets,
        grantAppId: auth.mode === 'app' ? auth.app.id : null,
      },
      { context: deps.context, constraints: deps.constraints, grants: deps.grants },
    );

    await deps.posts.replace(scope, {
      content,
      scheduleAt,
      targets: resolved.targets,
      mediaByPart: resolved.mediaByPart,
    });

    const updated = await deps.posts.find(scope);
    if (updated === undefined) throw ApiError.notFound('No such post');
    return postDetail(updated.post, updated.targets);
  });

  // ---------------------------------------------------------------------------
  // POST /v1/posts/{post_id}/cancel
  // ---------------------------------------------------------------------------
  app.post('/v1/posts/:post_id/cancel', async (request): Promise<CancelPostResponse> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    const userId = auth.userId;
    if (userId === null) {
      throw ApiError.invalidRequest('user_id is required to cancel a post in app mode');
    }

    const postUuid = postUuidFrom(request);
    const scope = scopeFor(auth, postUuid, userId);
    const before = await deps.posts.find(scope);
    if (before === undefined) throw ApiError.notFound('No such post');

    const alreadyCanceled = before.targets.every((target) => target.state === 'canceled');
    const result = await deps.posts.cancel(scope);

    if (result.canceledTargetIds.length === 0 && !alreadyCanceled) {
      // Nothing was cancellable: every target is dispatching or already finished.
      throw new ApiError('too_late', 'Dispatch has already begun for every target');
    }

    const after = await deps.posts.find(scope);
    return {
      post_id: encodeId('post', postUuid),
      state: (after?.post.state ?? 'canceled') as PostState,
      canceled_target_ids: result.canceledTargetIds.map((id) => encodeId('target', id)),
    };
  });
}
