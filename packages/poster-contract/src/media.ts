/**
 * Media upload (contract §5, FR-07).
 *
 * Media is uploaded once and referenced by id; per-platform renditions are made
 * on demand later. Two upload paths, chosen by request Content-Type (D-061):
 *
 *   multipart/form-data  — the service takes the bytes, stores them, probes them,
 *                          and returns a ready media row. For small files.
 *   application/json     — the service returns a signed upload URL the client PUTs
 *                          to directly, then calls /complete. For large video,
 *                          which has no business flowing through the API process.
 */
import { z } from 'zod';
import { MediaKind, MediaStatus } from './constraints.js';

export { MEDIA_STATUSES, MediaStatus } from './constraints.js';

export const Media = z
  .object({
    media_id: z.string(),
    status: MediaStatus,
    kind: MediaKind,
    mime_type: z.string(),
    size_bytes: z.number().int().nonnegative().nullable(),
    /** Seconds, probed from the file. Null for images and un-probed uploads. */
    duration_s: z.number().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    created_at: z.string(),
  })
  .describe('A stored media item.');
export type Media = z.infer<typeof Media>;

export const SignedUploadRequest = z
  .object({
    user_id: z.string().uuid(),
    kind: MediaKind,
    mime_type: z.string().min(1),
    size_bytes: z
      .number()
      .int()
      .positive()
      .describe('Declared size, used to reject uploads the plan does not allow.'),
    filename: z.string().optional().describe('Only used to pick a storage extension.'),
  })
  .describe('Ask for a signed URL instead of sending the bytes through the API.');
export type SignedUploadRequest = z.infer<typeof SignedUploadRequest>;

export const SignedUploadResponse = z
  .object({
    media_id: z.string(),
    status: z.literal('pending_upload'),
    upload_url: z.string().url().describe('PUT the bytes here, then call /complete.'),
    expires_at: z.string(),
  })
  .describe('A one-shot upload target. Nothing is usable until /complete succeeds.');
export type SignedUploadResponse = z.infer<typeof SignedUploadResponse>;
