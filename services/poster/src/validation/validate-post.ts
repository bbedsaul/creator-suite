/**
 * Turns a submission into either "valid" or the §8 422 envelope.
 *
 * This is the single place validation happens. `POST /v1/posts/validate` calls it
 * today and `POST /v1/posts` will call the same function in S05 (contract §5:
 * "Constraint validation runs at submission... Nothing is partially accepted"),
 * so the dry run and the real thing cannot disagree.
 */
import {
  validateTarget,
  type ErrorDetail,
  type MediaFacts,
  type PlatformConstraintSpec,
  type PostContent,
  type TargetValidationInput,
  type ValidatePostRequest,
} from '@suite/poster-contract';
import { ApiError } from '../api/errors.js';
import type { ResolvedConnection } from '../db/validation-context.js';

export interface ValidationDeps {
  /** Connections that exist for this user, keyed by public id. */
  readonly connections: Map<string, ResolvedConnection>;
  /** Media that exists for this user, keyed by public id. */
  readonly media: Map<string, MediaFacts>;
  /** Specs for enabled platforms, keyed by platform_id. */
  readonly specs: Map<string, PlatformConstraintSpec>;
}

export interface ValidatedTarget {
  readonly target_index: number;
  readonly connection_id: string;
  readonly platform_id: string;
}

export interface ValidationOutcome {
  readonly targets: ValidatedTarget[];
  /** Empty when everything passed. One entry per violation, not per target. */
  readonly details: ErrorDetail[];
}

/**
 * Collects the media for one part of the post, in the order the client listed it.
 * An id the user does not own has already been rejected as 404 by the caller, so
 * anything missing here would be a bug rather than bad input.
 */
function mediaFor(
  ids: readonly string[] | undefined,
  media: Map<string, MediaFacts>,
): MediaFacts[] {
  return (ids ?? []).flatMap((id) => {
    const facts = media.get(id);
    return facts === undefined ? [] : [facts];
  });
}

/** Every media id mentioned anywhere in the content, including thread parts. */
export function mediaIdsIn(content: PostContent): string[] {
  return [...(content.media ?? []), ...(content.thread ?? []).flatMap((part) => part.media ?? [])];
}

export function validatePost(
  request: ValidatePostRequest,
  deps: ValidationDeps,
): ValidationOutcome {
  const targets: ValidatedTarget[] = [];
  const details: ErrorDetail[] = [];

  request.targets.forEach((target, index) => {
    const connection = deps.connections.get(target.connection_id);
    if (connection === undefined) {
      // Unknown or not this user's. The caller turns this into 404 rather than
      // 422: it is not a content problem, and saying which is not our business.
      throw ApiError.notFound('No such connection');
    }

    const spec = deps.specs.get(connection.platformId);
    if (spec === undefined) {
      // Enabled platform with no spec, or a connection to a platform that is not
      // launched. Accepting it would mean dispatching content we never checked.
      throw new ApiError(
        'internal_error',
        `No constraint spec is published for platform ${connection.platformId}`,
      );
    }

    targets.push({
      target_index: index,
      connection_id: target.connection_id,
      platform_id: connection.platformId,
    });

    // Overrides replace the default content for this target only (§5).
    const text = target.overrides?.text ?? request.content.text;
    const title = target.overrides?.title ?? request.content.title;
    const thread = request.content.thread;

    const input: { -readonly [K in keyof TargetValidationInput]: TargetValidationInput[K] } = {
      media: mediaFor(mediaIdsIn(request.content), deps.media),
    };
    if (text !== undefined) input.text = text;
    if (title !== undefined) input.title = title;
    if (thread !== undefined) input.thread_parts = thread.length;

    for (const violation of validateTarget(input, spec)) {
      details.push({
        target_index: index,
        connection_id: target.connection_id,
        code: violation.code,
        constraint: violation.constraint,
      });
    }
  });

  return { targets, details };
}

/** The 422 the contract requires when any target fails (§5, §8). */
export function constraintViolationError(details: ErrorDetail[], targetCount: number): ApiError {
  const failing = new Set(details.map((detail) => detail.target_index)).size;
  return new ApiError(
    'constraint_violation',
    `${String(failing)} of ${String(targetCount)} targets failed validation`,
    details,
  );
}
