/**
 * Resolves the public ids in a submission to the facts the validator needs.
 *
 * Scoped to one user throughout: a connection or media row belonging to someone
 * else must read as "does not exist", never as a permission error, so the API
 * cannot be used to probe what other accounts own.
 */
import type { Sql } from 'postgres';
import { encodeId, tryDecodeId, type MediaFacts } from '@suite/poster-contract';

export interface ResolvedConnection {
  readonly publicId: string;
  readonly platformId: string;
}

export interface ValidationContextStore {
  resolveConnections(
    userId: string,
    publicIds: readonly string[],
  ): Promise<Map<string, ResolvedConnection>>;
  resolveMedia(userId: string, publicIds: readonly string[]): Promise<Map<string, MediaFacts>>;
}

export function createValidationContextStore(sql: Sql): ValidationContextStore {
  return {
    async resolveConnections(userId, publicIds) {
      const uuids = publicIds
        .map((id) => tryDecodeId('connection', id))
        .filter((id): id is string => id !== undefined);
      if (uuids.length === 0) return new Map();

      const rows = await sql<{ id: string; platform_id: string }[]>`
        select id, platform_id from poster.connections
         where user_id = ${userId}
           and disconnected_at is null
           and id = any(${sql.array(uuids)}::uuid[])`;

      return new Map(
        rows.map((row) => {
          const publicId = encodeId('connection', row.id);
          return [publicId, { publicId, platformId: row.platform_id }];
        }),
      );
    },

    async resolveMedia(userId, publicIds) {
      const uuids = publicIds
        .map((id) => tryDecodeId('media', id))
        .filter((id): id is string => id !== undefined);
      if (uuids.length === 0) return new Map();

      const rows = await sql<
        {
          id: string;
          kind: 'image' | 'video';
          mime_type: string;
          duration_ms: number | null;
          width: number | null;
          height: number | null;
        }[]
      >`
        select id, kind, mime_type, duration_ms, width, height
          from poster.media
         where user_id = ${userId}
           and id = any(${sql.array(uuids)}::uuid[])`;

      return new Map(
        rows.map((row) => {
          const publicId = encodeId('media', row.id);
          return [
            publicId,
            {
              media_id: publicId,
              kind: row.kind,
              mime_type: row.mime_type,
              // The column is milliseconds; specs are in seconds.
              duration_s: row.duration_ms === null ? null : row.duration_ms / 1000,
              width: row.width,
              height: row.height,
            } satisfies MediaFacts,
          ];
        }),
      );
    },
  };
}
