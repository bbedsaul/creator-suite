/**
 * The single error envelope, from contract §8.
 *
 * Every non-2xx response in the API has this shape. `details` is per-target so a
 * client can fix exactly the platform that failed (FR-06), and `request_id` is
 * on every envelope so a failure can be traced without guessing (added in
 * contract v1.2, additive — D-044).
 */
import { z } from 'zod';

/** Error codes from the contract §8 table. Clients must tolerate unknown codes. */
export const ERROR_CODES = [
  'invalid_request',
  'invalid_token',
  'forbidden_user',
  'grant_missing',
  'not_found',
  'idempotency_conflict',
  'too_late',
  'constraint_violation',
  'rate_limited',
  'internal_error',
] as const;

export const ErrorCode = z.enum(ERROR_CODES).describe('Machine-readable error code.');
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Per-platform validation failure codes (extensible; clients ignore unknown ones). */
export const CONSTRAINT_CODES = [
  'text_too_long',
  'video_too_long',
  'media_unsupported_format',
  'aspect_ratio_invalid',
  'thread_not_supported',
  'too_many_media',
] as const;

export const ConstraintCode = z.enum(CONSTRAINT_CODES);
export type ConstraintCode = z.infer<typeof ConstraintCode>;

export const ErrorDetail = z
  .object({
    target_index: z
      .number()
      .int()
      .min(0)
      .describe('Index of the failing target in the submitted targets array.'),
    connection_id: z.string().optional().describe('Public id of the target connection.'),
    code: z.string().describe('Constraint code; see the contract §8 list.'),
    constraint: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('The limit that was exceeded and the actual value, as data.'),
  })
  .describe('One per failing target, so a client can fix exactly what broke.');
export type ErrorDetail = z.infer<typeof ErrorDetail>;

export const ErrorEnvelope = z
  .object({
    error: z.object({
      code: ErrorCode,
      message: z.string().describe('Human-readable summary. Never used for control flow.'),
      details: z.array(ErrorDetail).optional(),
      request_id: z
        .string()
        .describe('Echoes the X-Request-Id response header. Quote it in support requests.'),
    }),
  })
  .describe('The single error envelope used by every non-2xx response.');
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** HTTP status for each code, so handlers cannot drift from the §8 table. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_token: 401,
  forbidden_user: 403,
  grant_missing: 403,
  not_found: 404,
  idempotency_conflict: 409,
  too_late: 409,
  constraint_violation: 422,
  rate_limited: 429,
  internal_error: 500,
};
