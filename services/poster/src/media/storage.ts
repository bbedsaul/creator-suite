/**
 * Object storage for uploaded media.
 *
 * Supabase Storage behind an interface, so tests can run without it and so the
 * bucket can be swapped for S3 later without touching a route. `@supabase/supabase-js`
 * is used for storage only; database access remains postgres.js as service_role
 * (CLAUDE.md stack rules, D-019).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SignedUpload {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface MediaStorage {
  /** Stores bytes the API received directly. */
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Issues a URL the client can PUT to without going through the API. */
  createSignedUpload(path: string): Promise<SignedUpload>;
  /** Downloads to a local file so ffprobe can read it. Returns false if absent. */
  downloadTo(path: string, filePath: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export interface SupabaseStorageOptions {
  readonly url: string;
  readonly serviceRoleKey: string;
  readonly bucket: string;
  /** Seconds a signed upload URL stays valid. */
  readonly signedUrlTtlS: number;
}

export function createSupabaseStorage(options: SupabaseStorageOptions): MediaStorage {
  const client: SupabaseClient = createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = client.storage.from(options.bucket);

  return {
    async put(path, bytes, contentType) {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: true });
      if (error !== null) throw new Error(`storage upload failed: ${error.message}`);
    },

    async createSignedUpload(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error !== null || data === null) {
        throw new Error(`could not sign an upload url: ${error?.message ?? 'no data'}`);
      }
      return {
        url: data.signedUrl,
        expiresAt: new Date(Date.now() + options.signedUrlTtlS * 1000),
      };
    },

    async downloadTo(path, filePath) {
      const { data, error } = await bucket.download(path);
      if (error !== null || data === null) return false;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, new Uint8Array(await data.arrayBuffer()));
      return true;
    },

    async remove(path) {
      await bucket.remove([path]);
    },
  };
}

/** Ensures the bucket exists. Called once at startup; idempotent. */
export async function ensureBucket(options: SupabaseStorageOptions): Promise<void> {
  const client = createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await client.storage.getBucket(options.bucket);
  if (data === null) {
    await client.storage.createBucket(options.bucket, { public: false });
  }
}
