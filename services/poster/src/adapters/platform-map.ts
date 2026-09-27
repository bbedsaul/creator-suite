/**
 * Our platform ids to each provider's spelling.
 *
 * `poster.platforms` is the authority for our side (`x`, `facebook_pages`, …);
 * the providers each chose their own names. Mapping in one table per provider
 * keeps the difference in a single readable place instead of scattered string
 * literals, and makes "this provider has no name for that platform" an explicit
 * `undefined` rather than a request that silently posts nowhere.
 *
 * Note that a mapping is **not** a claim that the platform works: adapters
 * declare their verified platforms separately (D-083). This table only says how
 * to spell one if we do send it.
 */

/** Upload-Post platform names (`platform[]` on POST /api/upload). */
export const UPLOAD_POST_PLATFORMS: Readonly<Record<string, string>> = {
  tiktok: 'tiktok',
  youtube: 'youtube',
  instagram: 'instagram',
  linkedin: 'linkedin',
  x: 'x',
  facebook_pages: 'facebook',
};

/** Ayrshare platform names (`platforms` on POST /post). */
export const AYRSHARE_PLATFORMS: Readonly<Record<string, string>> = {
  tiktok: 'tiktok',
  youtube: 'youtube',
  instagram: 'instagram',
  linkedin: 'linkedin',
  x: 'twitter',
  facebook_pages: 'facebook',
};

/** Reverses a map so a provider's response can be matched back to our id. */
export function invertPlatformMap(
  map: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [ours, theirs] of Object.entries(map)) out[theirs] = ours;
  return out;
}
