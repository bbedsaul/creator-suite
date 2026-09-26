/**
 * Post submission and lifecycle (contract §5 and §6, FR-05, FR-13, FR-14).
 *
 * A logical post fans out to one target per connection. Validation runs at
 * submission and nothing is partially accepted: either every target is created or
 * the request is rejected with per-target reasons.
 */
import { z } from 'zod';
import { PostContent, TargetOverrides } from './constraints.js';

export const TARGET_STATES = [
  'accepted',
  'scheduled',
  'dispatching',
  'posted',
  'failed',
  'paused',
  'canceled',
] as const;

export const TargetState = z
  .enum(TARGET_STATES)
  .describe('Per-target state (§6). State lives per target, never per post.');
export type TargetState = z.infer<typeof TargetState>;

/** Derived logical-post state (§6): `partial` when targets disagree. */
export const POST_STATES = [...TARGET_STATES, 'partial'] as const;
export const PostState = z
  .enum(POST_STATES)
  .describe('Derived from the targets: posted when all posted, partial when mixed.');
export type PostState = z.infer<typeof PostState>;

export const REASON_CLASSES = [
  'transient_exhausted',
  'platform_rejected',
  'token_revoked_expired',
  'grant_revoked',
  'rendition_failed',
  'dispatch_outcome_unknown',
] as const;
export const ReasonClass = z.enum(REASON_CLASSES);
export type ReasonClass = z.infer<typeof ReasonClass>;

export const SubmitTarget = z
  .object({
    connection_id: z.string().describe('Public connection id, e.g. cn_…'),
    overrides: TargetOverrides.optional(),
  })
  .describe('One target: which account, and what to change for it.');
export type SubmitTarget = z.infer<typeof SubmitTarget>;

export const SubmitPostRequest = z
  .object({
    user_id: z.string().uuid(),
    external_ref: z
      .string()
      .max(255)
      .optional()
      .describe('The client’s own id, echoed on every webhook for this post.'),
    content: PostContent,
    targets: z.array(SubmitTarget).min(1),
    schedule_at: z
      .string()
      .datetime()
      .optional()
      .describe('ISO 8601 UTC. Omitted means dispatch as soon as the post is ready.'),
  })
  .describe('A post to publish to one or more connected accounts.');
export type SubmitPostRequest = z.infer<typeof SubmitPostRequest>;

export const PostTargetSummary = z
  .object({
    target_id: z.string(),
    connection_id: z.string(),
    platform_id: z.string(),
    state: TargetState,
    due_at: z.string(),
    position: z.number().int().nonnegative().describe('Matches target_index in §8 details.'),
  })
  .describe('One created target.');
export type PostTargetSummary = z.infer<typeof PostTargetSummary>;

export const Post = z
  .object({
    post_id: z.string(),
    state: PostState,
    external_ref: z.string().nullable(),
    schedule_at: z.string().nullable(),
    content: PostContent,
    created_at: z.string(),
    targets: z.array(PostTargetSummary),
  })
  .describe('A logical post and its targets.');
export type Post = z.infer<typeof Post>;

export const PostTargetDetail = PostTargetSummary.extend({
  permalink: z.string().nullable(),
  platform_post_id: z.string().nullable(),
  reason_class: ReasonClass.nullable(),
  platform_message: z.string().nullable(),
  attempt_count: z.number().int().nonnegative(),
  posted_at: z.string().nullable(),
}).describe('Everything known about one target, including how it ended.');
export type PostTargetDetail = z.infer<typeof PostTargetDetail>;

export const PostDetail = Post.extend({
  targets: z.array(PostTargetDetail),
}).describe('GET /v1/posts/{id}.');
export type PostDetail = z.infer<typeof PostDetail>;

export const PatchPostRequest = z
  .object({
    content: PostContent.optional(),
    targets: z
      .array(SubmitTarget)
      .min(1)
      .optional()
      .describe('Replaces the target list wholesale. Omit to leave targets alone.'),
    schedule_at: z.string().datetime().nullable().optional().describe('null clears the schedule.'),
  })
  .describe('An edit before dispatch. Re-validates constraints (FR-13).');
export type PatchPostRequest = z.infer<typeof PatchPostRequest>;

export const CancelPostResponse = z
  .object({
    post_id: z.string(),
    state: PostState,
    canceled_target_ids: z
      .array(z.string())
      .describe('Targets this call moved to canceled. Empty when it was already canceled.'),
  })
  .describe('The outcome of a cancel.');
export type CancelPostResponse = z.infer<typeof CancelPostResponse>;
