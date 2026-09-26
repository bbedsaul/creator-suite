/**
 * Media upload (contract §5, FR-07).
 *
 * Two paths on one route, chosen by Content-Type (D-061). Large video gets a
 * signed URL so the bytes never pass through the API process; small files are
 * taken directly because a round trip for a 200 KB image is not worth the state.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  MediaKind,
  SignedUploadRequest,
  encodeId,
  tryDecodeId,
  type Media,
  type SignedUploadResponse,
} from '@suite/poster-contract';
import type { RateLimiter } from '@suite/server-core';
import { ApiError } from '../errors.js';
import { enforceAppLimit } from '../plugins/rate-limit.js';
import type { MediaRow, MediaStore } from '../../db/media.js';
import { MediaProbeError, type MediaProber } from '../../media/prober.js';
import type { MediaStorage } from '../../media/storage.js';

export interface MediaRouteDeps {
  readonly media: MediaStore;
  readonly storage: MediaStorage;
  readonly prober: MediaProber;
  readonly rateLimiter: RateLimiter;
  readonly maxDirectUploadBytes: number;
  readonly signedUrlTtlS: number;
}

function toMedia(row: MediaRow): Media {
  return {
    media_id: encodeId('media', row.id),
    status: row.status,
    kind: row.kind,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    duration_s: row.duration_ms === null ? null : row.duration_ms / 1000,
    width: row.width,
    height: row.height,
    created_at: row.created_at.toISOString(),
  };
}

/** Kind is derived from the MIME type, not taken on trust from the client. */
function kindFor(mimeType: string): 'image' | 'video' {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  throw ApiError.invalidRequest(`Unsupported media type: ${mimeType}`);
}

function storagePathFor(userId: string, mediaUuid: string, mimeType: string): string {
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
  return `${userId}/${mediaUuid}.${extension}`;
}

/**
 * A successful probe is not the same as usable media.
 *
 * ffprobe exits 0 on a text file renamed .png: it prints "Invalid PNG signature"
 * to stderr, reports a png stream, and gives width and height of 0 (D-069). Exit
 * code is therefore not a validity signal, so the probe result has to be checked
 * for the facts the constraint engine will need.
 */
function assertUsable(
  kind: 'image' | 'video',
  probe: { durationS: number | null; width: number | null; height: number | null },
): void {
  if (probe.width === null || probe.height === null) {
    throw ApiError.invalidRequest(
      'The uploaded file has no readable dimensions; it is probably not the type it claims to be',
    );
  }
  if (kind === 'video' && probe.durationS === null) {
    throw ApiError.invalidRequest('The uploaded video has no readable duration');
  }
}

/** Probes bytes by writing them to a temp file, because ffprobe reads paths. */
async function probeBytes(
  prober: MediaProber,
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ durationS: number | null; width: number | null; height: number | null }> {
  const directory = await mkdtemp(join(tmpdir(), 'poster-probe-'));
  const file = join(directory, `upload.${mimeType.split('/')[1] ?? 'bin'}`);
  try {
    await writeFile(file, bytes);
    return await prober.probe(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function registerMediaRoutes(app: FastifyInstance, deps: MediaRouteDeps): void {
  app.post('/v1/media', async (request, reply): Promise<Media | SignedUploadResponse> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    return request.isMultipart()
      ? directUpload(request, reply, auth.app.id, deps)
      : signedUpload(request, reply, auth.app.id, deps);
  });

  app.post('/v1/media/:media_id/complete', async (request): Promise<Media> => {
    const auth = await app.authenticate(request);
    enforceAppLimit(deps.rateLimiter, request, auth.app);

    const { media_id: publicId } = request.params as { media_id?: string };
    const mediaUuid = publicId === undefined ? undefined : tryDecodeId('media', publicId);
    if (mediaUuid === undefined) throw ApiError.notFound('No such media');

    const userId = auth.userId;
    if (userId === null) {
      throw ApiError.invalidRequest('user_id is required to complete an upload in app mode');
    }

    const row = await deps.media.find(userId, mediaUuid);
    if (row === undefined) throw ApiError.notFound('No such media');
    if (row.status === 'ready') return toMedia(row);

    const directory = await mkdtemp(join(tmpdir(), 'poster-complete-'));
    const file = join(directory, 'upload');
    try {
      const present = await deps.storage.downloadTo(row.storage_path, file);
      if (!present) {
        throw ApiError.invalidRequest('No object has been uploaded to the signed URL yet');
      }

      const probe = await deps.prober.probe(file);
      assertUsable(row.kind, probe);
      return toMedia(await deps.media.markReady(mediaUuid, { ...probe, sizeBytes: null }));
    } catch (error) {
      if (error instanceof MediaProbeError || (error instanceof ApiError && error.status === 400)) {
        // The upload is unusable, and saying so beats leaving it pending forever.
        await deps.media.markFailed(mediaUuid);
        throw error instanceof ApiError
          ? error
          : ApiError.invalidRequest('The uploaded file could not be read as media');
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function directUpload(
  request: FastifyRequest,
  reply: { code: (status: number) => unknown },
  appId: string,
  deps: MediaRouteDeps,
): Promise<Media> {
  const part = await request.file({ limits: { fileSize: deps.maxDirectUploadBytes } });
  if (part === undefined) throw ApiError.invalidRequest('Expected a file part named "file"');

  const userId = (part.fields['user_id'] as { value?: unknown } | undefined)?.value;
  if (typeof userId !== 'string') {
    throw ApiError.invalidRequest('Expected a user_id field alongside the file');
  }
  if (request.auth?.userId !== null && request.auth?.userId !== userId) {
    throw ApiError.forbiddenUser();
  }

  const bytes = await part.toBuffer();
  if (part.file.truncated) {
    throw ApiError.invalidRequest(
      `File exceeds the direct upload limit of ${String(deps.maxDirectUploadBytes)} bytes; request a signed URL instead`,
    );
  }

  const mimeType = part.mimetype;
  const kind = kindFor(mimeType);
  const mediaUuid = randomUUID();
  const path = storagePathFor(userId, mediaUuid, mimeType);

  let probe: { durationS: number | null; width: number | null; height: number | null };
  try {
    probe = await probeBytes(deps.prober, bytes, mimeType);
  } catch (error) {
    if (error instanceof MediaProbeError) {
      throw ApiError.invalidRequest('The uploaded file could not be read as media');
    }
    throw error;
  }
  assertUsable(kind, probe);

  // Stored only after it is known to be usable, so a rejected upload leaves no
  // orphan object behind.
  await deps.storage.put(path, bytes, mimeType);

  const row = await deps.media.create({
    id: mediaUuid,
    userId,
    appId,
    kind: MediaKind.parse(kind),
    status: 'ready',
    storagePath: path,
    mimeType,
    sizeBytes: bytes.byteLength,
    durationS: probe.durationS,
    width: probe.width,
    height: probe.height,
  });

  void reply.code(201);
  return toMedia(row);
}

async function signedUpload(
  request: FastifyRequest,
  reply: { code: (status: number) => unknown },
  appId: string,
  deps: MediaRouteDeps,
): Promise<SignedUploadResponse> {
  const parsed = SignedUploadRequest.safeParse(request.body);
  if (!parsed.success) {
    throw ApiError.invalidRequest(
      'Send multipart/form-data to upload directly, or JSON with user_id, kind, mime_type and size_bytes to get a signed URL',
    );
  }
  const details = parsed.data;

  if (request.auth?.userId !== null && request.auth?.userId !== details.user_id) {
    throw ApiError.forbiddenUser();
  }
  // Derived, not trusted: a client claiming "image" for a video would produce a
  // media row the constraint engine reasons about incorrectly.
  if (kindFor(details.mime_type) !== details.kind) {
    throw ApiError.invalidRequest(`mime_type ${details.mime_type} is not a ${details.kind}`);
  }

  const mediaUuid = randomUUID();
  const path = storagePathFor(details.user_id, mediaUuid, details.mime_type);
  const signed = await deps.storage.createSignedUpload(path);

  await deps.media.create({
    id: mediaUuid,
    userId: details.user_id,
    appId,
    kind: details.kind,
    status: 'pending_upload',
    storagePath: path,
    mimeType: details.mime_type,
    sizeBytes: details.size_bytes,
    durationS: null,
    width: null,
    height: null,
  });

  void reply.code(202);
  return {
    media_id: encodeId('media', mediaUuid),
    status: 'pending_upload',
    upload_url: signed.url,
    expires_at: signed.expiresAt.toISOString(),
  };
}
