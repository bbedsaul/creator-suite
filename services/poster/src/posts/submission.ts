/**
 * The shared work behind creating or editing a post (contract §5).
 *
 * `POST /v1/posts`, `PATCH /v1/posts/{id}` and `POST /v1/posts/validate` all run
 * this, so a dry run, a submission and an edit cannot disagree about what is
 * acceptable. The order matters and is the contract's: resolve, then authorize,
 * then validate — a caller with no grant should be told that rather than being
 * handed a list of caption problems for a connection it may not use.
 */
import {
  tryDecodeId,
  type ErrorDetail,
  type MediaFacts,
  type PostContent,
  type SubmitTarget,
} from '@suite/poster-contract';
import { ApiError } from '../api/errors.js';
import type { GrantStore } from '../db/grants.js';
import type { PlatformConstraintStore } from '../db/platform-constraints.js';
import type { SubmitTargetRow } from '../db/posts.js';
import type { ValidationContextStore } from '../db/validation-context.js';
import { constraintViolationError, mediaIdsIn, validatePost } from '../validation/validate-post.js';

export interface SubmissionDeps {
  readonly context: ValidationContextStore;
  readonly constraints: PlatformConstraintStore;
  readonly grants: GrantStore;
}

export interface SubmissionInput {
  readonly userId: string;
  readonly content: PostContent;
  readonly targets: readonly SubmitTarget[];
  /** The app whose grants are checked, or null to skip (user mode — §2.2). */
  readonly grantAppId: string | null;
}

export interface ResolvedSubmission {
  readonly targets: SubmitTargetRow[];
  /** Media uuids per thread part, in submission order. */
  readonly mediaByPart: string[][];
}

/**
 * Splits content media into thread parts.
 *
 * `content.media` and `content.thread` are mutually exclusive (D-065): the
 * `post_media.part` column indexes the thread part, so allowing both would make
 * part 0 mean two different things. Rejecting it is clearer than picking one.
 */
export function mediaByPart(content: PostContent): string[][] {
  if (content.thread !== undefined && content.thread.length > 0) {
    if (content.media !== undefined && content.media.length > 0) {
      throw ApiError.invalidRequest(
        'content.media and content.thread are mutually exclusive; put each part’s media on that part',
      );
    }
    return content.thread.map((part) => [...(part.media ?? [])]);
  }
  return [[...(content.media ?? [])]];
}

function decodeMedia(publicIds: readonly string[]): string[] {
  return publicIds.map((id) => {
    const uuid = tryDecodeId('media', id);
    if (uuid === undefined) throw ApiError.notFound(`No such media: ${id}`);
    return uuid;
  });
}

export async function resolveSubmission(
  input: SubmissionInput,
  deps: SubmissionDeps,
): Promise<ResolvedSubmission> {
  const partsPublic = mediaByPart(input.content);
  const allMediaIds = mediaIdsIn(input.content);

  const [connections, media, specs] = await Promise.all([
    deps.context.resolveConnections(
      input.userId,
      input.targets.map((target) => target.connection_id),
    ),
    deps.context.resolveMedia(input.userId, allMediaIds),
    deps.constraints.specsByPlatform(),
  ]);

  // Absent, or someone else's: both read as "no such thing" so the API cannot be
  // used to discover what other accounts own.
  const unknownConnections = input.targets
    .map((target) => target.connection_id)
    .filter((id) => !connections.has(id));
  if (unknownConnections.length > 0) {
    throw ApiError.notFound(`No such connection: ${unknownConnections.join(', ')}`);
  }

  const unknownMedia = allMediaIds.filter((id) => !media.has(id));
  if (unknownMedia.length > 0) {
    throw ApiError.notFound(`No such media: ${unknownMedia.join(', ')}`);
  }

  // Authorization before validation: "app credentials alone never authorize
  // publishing" (§2.1).
  if (input.grantAppId !== null) {
    const connectionUuids = input.targets.map((target) => {
      const uuid = tryDecodeId('connection', target.connection_id);
      if (uuid === undefined) throw ApiError.notFound('No such connection');
      return uuid;
    });
    const ungranted = await deps.grants.findUngranted(input.grantAppId, connectionUuids);
    if (ungranted.length > 0) {
      throw new ApiError(
        'grant_missing',
        `${String(ungranted.length)} of ${String(connectionUuids.length)} connections have no live grant for this app`,
      );
    }
  }

  const outcome = validatePost(
    { user_id: input.userId, content: input.content, targets: [...input.targets] },
    { connections, media, specs },
  );
  if (outcome.details.length > 0) {
    throw constraintViolationError(outcome.details, input.targets.length);
  }

  const targets: SubmitTargetRow[] = input.targets.map((target) => {
    const resolved = connections.get(target.connection_id);
    if (resolved === undefined) throw ApiError.notFound('No such connection');
    const uuid = tryDecodeId('connection', target.connection_id);
    if (uuid === undefined) throw ApiError.notFound('No such connection');
    return {
      connectionUuid: uuid,
      platformId: resolved.platformId,
      overrides: target.overrides ?? {},
    };
  });

  return { targets, mediaByPart: partsPublic.map(decodeMedia) };
}

/** Re-exported so routes do not need to reach into the validation module. */
export type { ErrorDetail, MediaFacts };
