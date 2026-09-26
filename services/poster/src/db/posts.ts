/**
 * Post submission, read, edit and cancel (contract §5, FR-13, FR-14).
 *
 * The idempotency design is the table comment's, and the mechanism is worth being
 * explicit about: the `insert into idempotency_keys` is a **plain insert, not
 * `on conflict do nothing`**. A concurrent duplicate then *blocks* on the primary
 * key until the first transaction commits, and only afterwards sees the unique
 * violation — at which point the stored response is committed and readable. With
 * `on conflict do nothing` the loser would return immediately and read a row its
 * snapshot cannot see, and both requests would create a post (D-063).
 */
import type { Sql, TransactionSql } from 'postgres';
import { createHash } from 'node:crypto';
import type { PostContent, TargetState } from '@suite/poster-contract';

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

export interface SubmitTargetRow {
  readonly connectionUuid: string;
  readonly platformId: string;
  readonly overrides: Record<string, unknown>;
}

export interface SubmitPostParams {
  readonly appId: string;
  readonly userId: string;
  readonly externalRef: string | null;
  readonly content: PostContent;
  readonly scheduleAt: Date | null;
  readonly targets: readonly SubmitTargetRow[];
  /** Media uuids per thread part, in order. Part 0 is a non-thread post. */
  readonly mediaByPart: readonly (readonly string[])[];
  readonly idempotencyKey: string | null;
  readonly requestHash: Buffer;
}

export interface StoredIdempotentResponse {
  readonly requestHash: Buffer;
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
}

export type SubmitOutcome =
  | { readonly kind: 'created'; readonly postId: string; readonly body: unknown }
  | { readonly kind: 'replay'; readonly stored: StoredIdempotentResponse };

/** Builds the response body from ids only known inside the transaction. */
export type BuildResponse = (
  postUuid: string,
  targets: readonly { readonly id: string; readonly position: number }[],
) => unknown;

/** Canonical JSON: stable key order, so key equality does not depend on field order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function hashRequest(value: unknown): Buffer {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest();
}

export interface PostRow {
  post_id: string;
  user_id: string;
  app_id: string;
  external_ref: string | null;
  schedule_at: Date | null;
  content: PostContent;
  created_at: Date;
  state: string;
}

export interface TargetRow {
  target_id: string;
  connection_id: string;
  platform_id: string;
  state: TargetState;
  due_at: Date;
  position: number;
  permalink: string | null;
  platform_post_id: string | null;
  reason_class: string | null;
  platform_message: string | null;
  attempt_count: number;
  posted_at: Date | null;
}

export interface PostStore {
  submit(params: SubmitPostParams, buildResponse: BuildResponse): Promise<SubmitOutcome>;
  readStoredResponse(appId: string, key: string): Promise<StoredIdempotentResponse | undefined>;
  find(scope: PostScope): Promise<{ post: PostRow; targets: TargetRow[] } | undefined>;
  cancel(scope: PostScope): Promise<{ canceledTargetIds: string[]; cancellable: number }>;
  replace(scope: PostScope, params: ReplaceParams): Promise<void>;
}

/** Who is allowed to see a post. App mode is additionally scoped to its own app. */
export interface PostScope {
  readonly postUuid: string;
  readonly userId: string;
  /** null in user mode: the post belongs to the user regardless of which app made it. */
  readonly appId: string | null;
}

export interface ReplaceParams {
  readonly content: PostContent;
  readonly scheduleAt: Date | null;
  readonly targets: readonly SubmitTargetRow[];
  readonly mediaByPart: readonly (readonly string[])[];
}

/** States a target may be cancelled from (§6: until dispatch begins). */
const CANCELLABLE: readonly TargetState[] = ['accepted', 'scheduled', 'paused'];

async function insertMedia(
  tx: TransactionSql,
  postUuid: string,
  userId: string,
  mediaByPart: readonly (readonly string[])[],
): Promise<void> {
  for (const [part, ids] of mediaByPart.entries()) {
    for (const [position, mediaUuid] of ids.entries()) {
      await tx`
        insert into poster.post_media (post_id, user_id, part, position, media_id)
        values (${postUuid}, ${userId}, ${part}, ${position}, ${mediaUuid})`;
    }
  }
}

async function insertTargets(
  tx: TransactionSql,
  postUuid: string,
  params: { userId: string; scheduleAt: Date | null; targets: readonly SubmitTargetRow[] },
): Promise<{ id: string; position: number }[]> {
  const created: { id: string; position: number }[] = [];
  for (const [position, target] of params.targets.entries()) {
    // Inserted straight to `scheduled`: D-016 reserves `accepted` for targets
    // awaiting a per-platform rendition, and M1 has no transcode step.
    // `due_at` falls back to now(), which is what an omitted schedule_at means (§5).
    const rows = await tx<{ id: string }[]>`
      insert into poster.post_targets
        (post_id, user_id, connection_id, platform_id, position, overrides, state, due_at)
      values (${postUuid}, ${params.userId}, ${target.connectionUuid}, ${target.platformId},
              ${position}, ${tx.json(target.overrides as never)}, 'scheduled',
              coalesce(${params.scheduleAt}::timestamptz, now()))
      returning id`;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('target insert returned no id');
    created.push({ id, position });
  }
  return created;
}

export function createPostStore(sql: Sql): PostStore {
  return {
    async submit(params, buildResponse) {
      try {
        const created = await sql.begin(async (tx) => {
          if (params.idempotencyKey !== null) {
            // Plain insert on purpose. See the module comment: this is the lock.
            await tx`
              insert into poster.idempotency_keys (app_id, key, request_hash)
              values (${params.appId}, ${params.idempotencyKey}, ${params.requestHash})`;
          }

          const inserted = await tx<{ id: string }[]>`
            insert into poster.posts (user_id, app_id, external_ref, content, schedule_at)
            values (${params.userId}, ${params.appId}, ${params.externalRef},
                    ${tx.json(params.content as never)}, ${params.scheduleAt})
            returning id`;
          const postUuid = inserted[0]?.id;
          if (postUuid === undefined) throw new Error('post insert returned no id');

          await insertMedia(tx, postUuid, params.userId, params.mediaByPart);
          const targets = await insertTargets(tx, postUuid, params);
          const body = buildResponse(postUuid, targets);

          if (params.idempotencyKey !== null) {
            // The response is stored in the SAME transaction that creates the
            // post. Storing it afterwards would leave a window in which a
            // concurrent duplicate sees the committed key row with a null body
            // and has nothing to replay.
            await tx`
              update poster.idempotency_keys
                 set post_id = ${postUuid}, response_status = 202,
                     response_body = ${tx.json(body as never)}
               where app_id = ${params.appId} and key = ${params.idempotencyKey}`;
          }

          return { postUuid, body };
        });

        return { kind: 'created', postId: created.postUuid, body: created.body };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === UNIQUE_VIOLATION && params.idempotencyKey !== null) {
          // The winner has committed by now, so its row is visible.
          const stored = await this.readStoredResponse(params.appId, params.idempotencyKey);
          if (stored !== undefined) return { kind: 'replay', stored };
        }
        throw error;
      }
    },

    async readStoredResponse(appId, key) {
      const rows = await sql<
        { request_hash: Buffer; response_status: number | null; response_body: unknown }[]
      >`
        select request_hash, response_status, response_body
          from poster.idempotency_keys
         where app_id = ${appId} and key = ${key}`;
      const row = rows[0];
      return row === undefined
        ? undefined
        : {
            requestHash: row.request_hash,
            responseStatus: row.response_status,
            responseBody: row.response_body,
          };
    },

    async find(scope) {
      const posts = await sql<PostRow[]>`
        select p.id as post_id, p.user_id, p.app_id, p.external_ref, p.schedule_at,
               p.content, p.created_at, coalesce(s.state, 'accepted') as state
          from poster.posts p
          left join poster.post_status s on s.post_id = p.id
         where p.id = ${scope.postUuid}
           and p.user_id = ${scope.userId}
           and (${scope.appId}::uuid is null or p.app_id = ${scope.appId})`;
      const post = posts[0];
      if (post === undefined) return undefined;

      const targets = await sql<TargetRow[]>`
        select id as target_id, connection_id, platform_id, state, due_at, position,
               permalink, platform_post_id, reason_class, platform_message,
               attempt_count, posted_at
          from poster.post_targets
         where post_id = ${scope.postUuid}
         order by position`;

      return { post, targets };
    },

    async cancel(scope) {
      return sql.begin(async (tx) => {
        const owned = await tx<{ id: string }[]>`
          select id from poster.posts
           where id = ${scope.postUuid} and user_id = ${scope.userId}
             and (${scope.appId}::uuid is null or app_id = ${scope.appId})`;
        if (owned.length === 0) return { canceledTargetIds: [], cancellable: -1 };

        // Cancel is one of the two state changes the API layer may make directly
        // (CLAUDE.md rule 2); the trigger still enforces that each move is legal.
        const canceled = await tx<{ id: string }[]>`
          update poster.post_targets set state = 'canceled'
           where post_id = ${scope.postUuid}
             and state = any(${tx.array(CANCELLABLE as unknown as string[])}::poster.target_state[])
          returning id`;

        return { canceledTargetIds: canceled.map((row) => row.id), cancellable: canceled.length };
      });
    },

    async replace(scope, params) {
      await sql.begin(async (tx) => {
        await tx`
          update poster.posts
             set content = ${tx.json(params.content as never)}, schedule_at = ${params.scheduleAt}
           where id = ${scope.postUuid}`;

        // Replacing the target list wholesale: the previous targets are removed
        // and recreated, which is only safe because nothing has dispatched (the
        // route refuses otherwise) and no attempt rows can exist yet.
        await tx`delete from poster.post_targets where post_id = ${scope.postUuid}`;
        await tx`delete from poster.post_media where post_id = ${scope.postUuid}`;

        await insertMedia(tx, scope.postUuid, scope.userId, params.mediaByPart);
        await insertTargets(tx, scope.postUuid, {
          userId: scope.userId,
          scheduleAt: params.scheduleAt,
          targets: params.targets,
        });
      });
    },
  };
}
