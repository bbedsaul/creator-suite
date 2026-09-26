/**
 * Platform constraint specs and the validator that applies them (FR-06, §8).
 *
 * Two rules shape this file:
 *
 *   * **Limits are data** (CLAUDE.md rule 9). No number below is a platform
 *     limit; the specs live in JSON, are stored in `poster.platform_constraints`,
 *     and are served by `GET /v1/platforms/constraints`. This module only knows
 *     how to *apply* a spec.
 *   * **The validator is pure and lives in the contract package**, not in the
 *     service (D-055). That lets `apps/poster-web` validate live in the composer
 *     using specs it fetched from the API, so the browser shows the same
 *     violations the server would without a single limit being duplicated into
 *     frontend code.
 *
 * A length limit is meaningless without its unit: TikTok counts a caption in
 * UTF-16 runes, YouTube counts a description in UTF-8 bytes and a title in
 * characters. Getting that wrong silently rejects valid posts containing emoji
 * or non-Latin text, so `unit` is part of every text constraint.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Spec schema
// ---------------------------------------------------------------------------

export const TEXT_UNITS = ['utf16_code_units', 'utf8_bytes', 'characters'] as const;

export const TextUnit = z
  .enum(TEXT_UNITS)
  .describe(
    'How the platform counts length. utf16_code_units is what TikTok calls "runes"; ' +
      'utf8_bytes is a byte budget (YouTube descriptions); characters counts code points.',
  );
export type TextUnit = z.infer<typeof TextUnit>;

export const TextConstraint = z
  .object({
    max_length: z.number().int().positive(),
    unit: TextUnit,
    forbidden_characters: z
      .array(z.string())
      .optional()
      .describe('Characters the platform rejects outright, e.g. < and > on YouTube.'),
  })
  .describe('A length budget together with the unit it is measured in.');
export type TextConstraint = z.infer<typeof TextConstraint>;

export const MEDIA_KINDS = ['image', 'video'] as const;
export const MediaKind = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKind>;

/**
 * Upload lifecycle. Declared here rather than in media.ts because the validator
 * needs it, and the other direction would make the two modules circular.
 */
export const MEDIA_STATUSES = ['pending_upload', 'ready', 'failed'] as const;
export const MediaStatus = z
  .enum(MEDIA_STATUSES)
  .describe('pending_upload until the bytes arrive and are probed.');
export type MediaStatus = z.infer<typeof MediaStatus>;

export const MediaConstraint = z
  .object({
    kinds: z.array(MediaKind).describe('Media kinds this platform accepts at all.'),
    mime_types: z.array(z.string()).describe('Accepted MIME types.'),
    min_count: z.number().int().nonnegative(),
    max_count: z.number().int().nonnegative(),
  })
  .describe('What may be attached, and how much of it.');
export type MediaConstraint = z.infer<typeof MediaConstraint>;

export const VideoConstraint = z
  .object({
    max_duration_s: z.number().positive(),
    max_duration_is_per_account: z
      .boolean()
      .describe(
        'True when the platform’s real ceiling is per-account and only knowable at ' +
          'dispatch time (TikTok returns max_video_post_duration_sec per creator). The ' +
          'value here is then the optimistic platform maximum, and a target passing ' +
          'validation may still be rejected by the platform.',
      ),
  })
  .describe('Duration limits for video.');
export type VideoConstraint = z.infer<typeof VideoConstraint>;

export const AspectRatioConstraint = z
  .object({
    min: z.number().positive().describe('Minimum width/height, as a decimal.'),
    max: z.number().positive().describe('Maximum width/height, as a decimal.'),
    tolerance: z
      .number()
      .nonnegative()
      .describe('Slack on both ends, so 1079x1920 is not rejected for being one pixel off.'),
  })
  .describe('Accepted width/height range.');
export type AspectRatioConstraint = z.infer<typeof AspectRatioConstraint>;

export const ThreadConstraint = z
  .object({
    supported: z.boolean(),
    max_parts: z.number().int().positive().optional(),
  })
  .describe('Whether ordered multi-part posts are possible (FR-08).');
export type ThreadConstraint = z.infer<typeof ThreadConstraint>;

export const SpecSource = z
  .object({
    url: z.string().url(),
    retrieved: z.string().describe('ISO date the value was read from that page.'),
    note: z.string().optional(),
  })
  .describe('Where a number came from. Provenance travels with the data.');
export type SpecSource = z.infer<typeof SpecSource>;

export const PlatformConstraintSpec = z
  .object({
    text: TextConstraint.describe('The main caption or body.'),
    title: TextConstraint.optional().describe('Separate title field, where the platform has one.'),
    media: MediaConstraint,
    video: VideoConstraint.optional(),
    aspect_ratio: AspectRatioConstraint.optional(),
    threads: ThreadConstraint,
    sources: z.array(SpecSource).min(1).describe('Citations for every limit above.'),
    provisional: z
      .boolean()
      .describe(
        'True while the numbers come from platform documentation rather than the ' +
          'aggregator we actually post through. The aggregator is often stricter, so ' +
          'S09 replaces these (OQ-1).',
      ),
  })
  .describe('Everything needed to validate one target for one platform.');
export type PlatformConstraintSpec = z.infer<typeof PlatformConstraintSpec>;

export const PlatformConstraints = z
  .object({
    platform_id: z.string(),
    display_name: z.string(),
    supports_threads: z.boolean(),
    spec_version: z.number().int().positive(),
    updated_at: z.string(),
    spec: PlatformConstraintSpec,
  })
  .describe('One platform’s published constraints.');
export type PlatformConstraints = z.infer<typeof PlatformConstraints>;

export const PlatformConstraintsResponse = z
  .object({
    platforms: z.array(PlatformConstraints),
  })
  .describe('Published platform limits, so no client ever hard-codes them.');
export type PlatformConstraintsResponse = z.infer<typeof PlatformConstraintsResponse>;

// ---------------------------------------------------------------------------
// Validator input and output
// ---------------------------------------------------------------------------

/**
 * Media facts the validator needs. Deliberately not the media row: the caller
 * resolves `content.media` ids to these, which keeps the validator pure and
 * usable in a browser that has never seen the database.
 */
export const MediaFacts = z
  .object({
    media_id: z.string(),
    status: MediaStatus,
    kind: MediaKind,
    mime_type: z.string(),
    duration_s: z.number().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  })
  .describe('Resolved facts about one attached media item.');
export type MediaFacts = z.infer<typeof MediaFacts>;

export const TargetValidationInput = z
  .object({
    text: z.string().optional().describe('Effective caption after applying overrides.'),
    title: z.string().optional(),
    media: z.array(MediaFacts),
    thread_parts: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of parts when this is a thread; absent or 1 means a single post.'),
  })
  .describe('One target, with overrides already applied.');
export type TargetValidationInput = z.infer<typeof TargetValidationInput>;

/**
 * Constraint codes. The first six are contract §8. Two are additive (D-056),
 * both because reporting them under an existing code would misinform a client
 * switching on `code`: `media_required` for a platform that cannot post text
 * alone, `text_invalid_characters` for characters a platform rejects outright
 * (YouTube refuses < and > in titles and descriptions), and `media_not_ready` for
 * a referenced upload that has not finished (D-061) — the client's action there is
 * to wait, which is nothing like fixing content.
 */
export const CONSTRAINT_VIOLATION_CODES = [
  'text_too_long',
  'video_too_long',
  'media_unsupported_format',
  'aspect_ratio_invalid',
  'thread_not_supported',
  'too_many_media',
  'media_required',
  'text_invalid_characters',
  'media_not_ready',
] as const;

export const ConstraintViolationCode = z.enum(CONSTRAINT_VIOLATION_CODES);
export type ConstraintViolationCode = z.infer<typeof ConstraintViolationCode>;

export interface Violation {
  readonly code: ConstraintViolationCode;
  /** The limit and the actual value, as data a client can render. */
  readonly constraint: Record<string, unknown>;
  /** Which media item caused it, when it was one item's fault. */
  readonly media_id?: string;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** Length of `value` in the unit the platform actually counts in. */
export function measureText(value: string, unit: TextUnit): number {
  switch (unit) {
    case 'utf16_code_units':
      // A JS string *is* UTF-16 code units, so .length is exactly TikTok's rune count.
      return value.length;
    case 'utf8_bytes':
      return utf8.encode(value).length;
    case 'characters':
      // Code points, so an emoji counts once rather than as its surrogate pair.
      return [...value].length;
  }
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

function checkText(
  label: 'text' | 'title',
  value: string | undefined,
  constraint: TextConstraint | undefined,
): Violation[] {
  if (value === undefined || constraint === undefined) return [];

  const violations: Violation[] = [];
  const length = measureText(value, constraint.unit);

  if (length > constraint.max_length) {
    violations.push({
      code: 'text_too_long',
      constraint: {
        field: label,
        max_length: constraint.max_length,
        unit: constraint.unit,
        actual_length: length,
      },
    });
  }

  const forbidden = (constraint.forbidden_characters ?? []).filter((char) => value.includes(char));
  if (forbidden.length > 0) {
    violations.push({
      code: 'text_invalid_characters',
      constraint: { field: label, forbidden_characters: forbidden },
    });
  }

  return violations;
}

/**
 * Applies one platform spec to one target. Pure: same inputs, same violations,
 * no clock, no network, no database.
 *
 * Returns every violation rather than stopping at the first, so a client can fix
 * a post in one pass instead of playing whack-a-mole with the API.
 */
export function validateTarget(
  input: TargetValidationInput,
  spec: PlatformConstraintSpec,
): Violation[] {
  const violations: Violation[] = [
    ...checkText('text', input.text, spec.text),
    ...checkText('title', input.title, spec.title),
  ];

  // --- media count -------------------------------------------------------
  const count = input.media.length;
  if (count > spec.media.max_count) {
    violations.push({
      code: 'too_many_media',
      constraint: { max_count: spec.media.max_count, actual_count: count },
    });
  }
  if (count < spec.media.min_count) {
    violations.push({
      code: 'media_required',
      constraint: { min_count: spec.media.min_count, actual_count: count },
    });
  }

  // --- per-item readiness, kind, format, duration, aspect ratio ---------
  for (const item of input.media) {
    if (item.status !== 'ready') {
      // Its dimensions and duration are unknown until the upload completes, so
      // there is nothing else worth saying about this item.
      violations.push({
        code: 'media_not_ready',
        constraint: { status: item.status },
        media_id: item.media_id,
      });
      continue;
    }

    if (!spec.media.kinds.includes(item.kind)) {
      violations.push({
        code: 'media_unsupported_format',
        constraint: { accepted_kinds: spec.media.kinds, actual_kind: item.kind },
        media_id: item.media_id,
      });
    } else if (!spec.media.mime_types.includes(item.mime_type)) {
      // `else`: an unsupported kind already explains the rejection, and two
      // violations for one item would read as two separate problems.
      violations.push({
        code: 'media_unsupported_format',
        constraint: {
          accepted_mime_types: spec.media.mime_types,
          actual_mime_type: item.mime_type,
        },
        media_id: item.media_id,
      });
    }

    if (item.kind === 'video' && spec.video !== undefined && item.duration_s !== null) {
      if (item.duration_s > spec.video.max_duration_s) {
        violations.push({
          code: 'video_too_long',
          constraint: {
            max_duration_s: spec.video.max_duration_s,
            actual_duration_s: item.duration_s,
            // Tells a client this ceiling may be lower for their own account.
            per_account_limit: spec.video.max_duration_is_per_account,
          },
          media_id: item.media_id,
        });
      }
    }

    if (spec.aspect_ratio !== undefined && item.width !== null && item.height !== null) {
      const ratio = item.width / item.height;
      const { min, max, tolerance } = spec.aspect_ratio;
      if (ratio < min - tolerance || ratio > max + tolerance) {
        violations.push({
          code: 'aspect_ratio_invalid',
          constraint: {
            min_ratio: min,
            max_ratio: max,
            actual_ratio: Number(ratio.toFixed(4)),
            width: item.width,
            height: item.height,
          },
          media_id: item.media_id,
        });
      }
    }
  }

  // --- threads -----------------------------------------------------------
  const parts = input.thread_parts ?? 1;
  if (parts > 1) {
    if (!spec.threads.supported) {
      violations.push({
        code: 'thread_not_supported',
        constraint: { thread_parts: parts },
      });
    } else if (spec.threads.max_parts !== undefined && parts > spec.threads.max_parts) {
      violations.push({
        code: 'thread_not_supported',
        constraint: { max_parts: spec.threads.max_parts, thread_parts: parts },
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Validation request (POST /v1/posts/validate)
// ---------------------------------------------------------------------------

/**
 * The content half of a post submission, per contract §5. Defined here rather
 * than waiting for S05 so `POST /v1/posts/validate` and `POST /v1/posts` cannot
 * drift apart: S05 reuses these schemas rather than restating them.
 */
export const PostContent = z
  .object({
    text: z.string().optional().describe('Default caption for every target.'),
    title: z.string().optional().describe('Default title, for platforms that have one.'),
    media: z.array(z.string()).optional().describe('Public media ids, in order.'),
    thread: z
      .array(
        z.object({
          text: z.string(),
          media: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .describe('Ordered multi-part post (FR-08). Rejected on platforms without threads.'),
  })
  .describe('What to post, before per-target overrides.');
export type PostContent = z.infer<typeof PostContent>;

export const TargetOverrides = z
  .object({
    text: z.string().optional(),
    title: z.string().optional(),
  })
  .describe('Per-platform replacements for the default content.');
export type TargetOverrides = z.infer<typeof TargetOverrides>;

export const ValidateTargetRequest = z.object({
  connection_id: z.string().describe('Public connection id, e.g. cn_…'),
  overrides: TargetOverrides.optional(),
});
export type ValidateTargetRequest = z.infer<typeof ValidateTargetRequest>;

export const ValidatePostRequest = z
  .object({
    user_id: z.string().uuid().describe('The user whose connections and media these are.'),
    content: PostContent,
    targets: z.array(ValidateTargetRequest).min(1),
  })
  .describe('A post submission to check without creating anything.');
export type ValidatePostRequest = z.infer<typeof ValidatePostRequest>;

export const ValidatePostResponse = z
  .object({
    valid: z.literal(true),
    /** Echoed so a client can confirm which platform each target resolved to. */
    targets: z.array(
      z.object({
        target_index: z.number().int().nonnegative(),
        connection_id: z.string(),
        platform_id: z.string(),
      }),
    ),
  })
  .describe('Returned only when every target passes. Failures use the §8 422 envelope.');
export type ValidatePostResponse = z.infer<typeof ValidatePostResponse>;
