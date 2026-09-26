/**
 * Media rows (FR-07). Uploaded once, referenced by id from any number of posts.
 */
import type { Sql } from 'postgres';
import type { MediaKind, MediaStatus } from '@suite/poster-contract';

export interface MediaRow {
  id: string;
  user_id: string;
  kind: MediaKind;
  status: MediaStatus;
  storage_path: string;
  mime_type: string;
  size_bytes: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  created_at: Date;
}

export interface CreateMediaParams {
  /** Chosen by the caller: the storage path and the signed URL embed it. */
  readonly id: string;
  readonly userId: string;
  readonly appId: string;
  readonly kind: MediaKind;
  readonly status: MediaStatus;
  readonly storagePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly durationS: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface MediaStore {
  create(params: CreateMediaParams): Promise<MediaRow>;
  find(userId: string, mediaUuid: string): Promise<MediaRow | undefined>;
  markReady(
    mediaUuid: string,
    probe: {
      durationS: number | null;
      width: number | null;
      height: number | null;
      sizeBytes: number | null;
    },
  ): Promise<MediaRow>;
  markFailed(mediaUuid: string): Promise<void>;
}

export function createMediaStore(sql: Sql): MediaStore {
  return {
    async create(params) {
      const rows = await sql<MediaRow[]>`
        insert into poster.media
          (id, user_id, app_id, kind, status, storage_path, mime_type, size_bytes,
           duration_ms, width, height)
        values (${params.id}, ${params.userId}, ${params.appId}, ${params.kind}, ${params.status},
                ${params.storagePath}, ${params.mimeType}, ${params.sizeBytes},
                ${params.durationS === null ? null : Math.round(params.durationS * 1000)},
                ${params.width}, ${params.height})
        returning *`;
      const row = rows[0];
      if (row === undefined) throw new Error('media insert returned no row');
      return row;
    },

    async find(userId, mediaUuid) {
      const rows = await sql<MediaRow[]>`
        select * from poster.media where id = ${mediaUuid} and user_id = ${userId}`;
      return rows[0];
    },

    async markReady(mediaUuid, probe) {
      const rows = await sql<MediaRow[]>`
        update poster.media
           set status      = 'ready',
               duration_ms = ${probe.durationS === null ? null : Math.round(probe.durationS * 1000)},
               width       = ${probe.width},
               height      = ${probe.height},
               size_bytes  = coalesce(${probe.sizeBytes}, size_bytes)
         where id = ${mediaUuid}
        returning *`;
      const row = rows[0];
      if (row === undefined) throw new Error('media row vanished while completing upload');
      return row;
    },

    async markFailed(mediaUuid) {
      await sql`update poster.media set status = 'failed' where id = ${mediaUuid}`;
    },
  };
}
