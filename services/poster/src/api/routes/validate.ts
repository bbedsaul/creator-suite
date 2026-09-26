/**
 * POST /v1/posts/validate — run the submission checks without creating anything.
 *
 * Added in v1.3 (D-057). It exists so the composer can show per-platform warnings
 * before submitting; the alternative was reimplementing every platform rule in
 * frontend TypeScript, which rule 9 forbids. It shares its implementation with
 * the real submission path, so a dry run cannot disagree with POST /v1/posts.
 */
import type { FastifyInstance } from 'fastify';
import { ValidatePostRequest, type ValidatePostResponse } from '@suite/poster-contract';
import type { RateLimiter } from '@suite/server-core';
import { ApiError } from '../errors.js';
import { enforceAppLimit } from '../plugins/rate-limit.js';
import type { PlatformConstraintStore } from '../../db/platform-constraints.js';
import type { ValidationContextStore } from '../../db/validation-context.js';
import {
  constraintViolationError,
  mediaIdsIn,
  validatePost,
} from '../../validation/validate-post.js';

export interface ValidateRouteDeps {
  readonly constraints: PlatformConstraintStore;
  readonly context: ValidationContextStore;
  readonly rateLimiter: RateLimiter;
}

export function registerValidateRoute(app: FastifyInstance, deps: ValidateRouteDeps): void {
  app.post('/v1/posts/validate', async (request): Promise<ValidatePostResponse> => {
    // Authenticate first: the auth layer reads user_id from the body, so user
    // mode is confined to its own user before any lookup happens (D-023).
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    const parsed = ValidatePostRequest.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.invalidRequest(
        `Invalid request body: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
      );
    }
    const submission = parsed.data;

    if (auth.userId !== null && auth.userId !== submission.user_id) {
      throw ApiError.forbiddenUser();
    }

    const mediaIds = mediaIdsIn(submission.content);
    const [connections, media, specs] = await Promise.all([
      deps.context.resolveConnections(
        submission.user_id,
        submission.targets.map((target) => target.connection_id),
      ),
      deps.context.resolveMedia(submission.user_id, mediaIds),
      deps.constraints.specsByPlatform(),
    ]);

    // A media id the user does not own reads as "no such media", the same as one
    // that never existed: the API must not confirm other people's ids.
    const unknownMedia = mediaIds.filter((id) => !media.has(id));
    if (unknownMedia.length > 0) {
      throw ApiError.notFound(`No such media: ${unknownMedia.join(', ')}`);
    }

    const outcome = validatePost(submission, { connections, media, specs });

    if (outcome.details.length > 0) {
      throw constraintViolationError(outcome.details, submission.targets.length);
    }

    return { valid: true, targets: outcome.targets };
  });
}
