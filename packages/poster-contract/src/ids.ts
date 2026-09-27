/**
 * Prefixed public IDs (CLAUDE.md rule 7).
 *
 * The database stores UUIDs; the wire carries `po_…`, `tg_…` and friends. This
 * is the one encode/decode module, and it lives in the contract package rather
 * than in the service because the format is part of the published API: clients
 * store these strings and echo them back.
 *
 * Encoding is **Crockford base32** of the UUID's 16 bytes (D-043), giving a
 * fixed 26-character body. Crockford was chosen over base58 or base64url
 * because it is case-insensitive and excludes I, L, O and U, so an ID survives
 * being read aloud, retyped from a support ticket, or double-clicked in a
 * terminal. IDs are externally visible forever, so the format is effectively
 * permanent.
 */
import { z } from 'zod';

/** One prefix per resource type. Adding a resource type means adding a prefix. */
export const ID_PREFIXES = {
  post: 'po',
  target: 'tg',
  connection: 'cn',
  media: 'md',
  event: 'ev',
  scope_request: 'sr',
  // Added in v1.5: grant.updated webhooks reference a grant, and rule 7 says a new
  // resource type on the wire needs a registered prefix rather than a bare uuid.
  grant: 'gr',
} as const;

export type ResourceKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[ResourceKind];

/** Crockford base32: no I, L, O or U, so there is nothing to confuse with 1 or 0. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_BODY_LENGTH = 26;

/** Decoding map, including the characters Crockford says to fold. */
const DECODE = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) {
  const char = ALPHABET[i];
  if (char !== undefined) DECODE.set(char, i);
}
DECODE.set('O', 0);
DECODE.set('I', 1);
DECODE.set('L', 1);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** 128 bits padded to 130 (26 × 5), most significant bit first. */
function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 0b11111];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 0b11111];
  return out;
}

function decodeBase32(body: string): Uint8Array | undefined {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const char of body.toUpperCase()) {
    const value = DECODE.get(char);
    if (value === undefined) return undefined;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  // 26 characters carry 130 bits; the trailing 2 must be padding, not data.
  if (bytes.length !== 16) return undefined;
  if ((buffer & ((1 << bits) - 1)) !== 0) return undefined;
  return Uint8Array.from(bytes);
}

export class InvalidPublicIdError extends Error {
  constructor(
    readonly value: string,
    readonly expected: ResourceKind,
  ) {
    super(`not a valid ${ID_PREFIXES[expected]}_ id`);
    this.name = 'InvalidPublicIdError';
  }
}

/** Encodes a database UUID as the public ID for that resource kind. */
export function encodeId(kind: ResourceKind, uuid: string): string {
  if (!UUID_RE.test(uuid)) {
    throw new TypeError(`encodeId expected a uuid, received: ${uuid}`);
  }
  return `${ID_PREFIXES[kind]}_${encodeBase32(uuidToBytes(uuid))}`;
}

/**
 * Decodes a public ID back to its UUID, or returns undefined if it is not a
 * well-formed ID of that kind. Callers turn undefined into a 404 envelope —
 * a malformed ID is "no such thing", never a 500 (contract §8).
 */
export function tryDecodeId(kind: ResourceKind, value: string): string | undefined {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return undefined;
  const body = value.slice(prefix.length);
  if (body.length !== ID_BODY_LENGTH) return undefined;
  const bytes = decodeBase32(body);
  return bytes === undefined ? undefined : bytesToUuid(bytes);
}

/** Throwing form, for places where a caller has already validated the shape. */
export function decodeId(kind: ResourceKind, value: string): string {
  const uuid = tryDecodeId(kind, value);
  if (uuid === undefined) throw new InvalidPublicIdError(value, kind);
  return uuid;
}

/** A zod schema that accepts only well-formed public IDs of one kind. */
export function publicId(kind: ResourceKind): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-Za-z]{${ID_BODY_LENGTH}}$`),
      `must be a ${ID_PREFIXES[kind]}_ id`,
    )
    .describe(`Public ${kind} id, e.g. ${encodeId(kind, '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b')}`);
}

export const PostId = publicId('post');
export const TargetId = publicId('target');
export const ConnectionId = publicId('connection');
export const MediaId = publicId('media');
export const EventId = publicId('event');
export const ScopeRequestId = publicId('scope_request');
export const GrantId = publicId('grant');
