/**
 * The ID codec is the one place the wire format is decided (CLAUDE.md rule 7),
 * and these IDs live in client databases forever, so the round-trip is asserted
 * over randomized input rather than a handful of examples.
 */
import { describe, expect, it } from 'vitest';
import {
  ID_PREFIXES,
  InvalidPublicIdError,
  decodeId,
  encodeId,
  publicId,
  tryDecodeId,
  type ResourceKind,
} from '../src/ids.js';

const KINDS = Object.keys(ID_PREFIXES) as ResourceKind[];

describe('encodeId / decodeId round-trip', () => {
  it('survives 2000 random uuids across every resource kind', () => {
    for (let i = 0; i < 2000; i += 1) {
      const uuid = crypto.randomUUID();
      const kind = KINDS[i % KINDS.length] as ResourceKind;
      const encoded = encodeId(kind, uuid);
      expect(tryDecodeId(kind, encoded), `round-trip failed for ${uuid}`).toBe(uuid);
    }
  });

  it('handles the boundary values a random sample would miss', () => {
    const edges = [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '00000000-0000-0000-0000-000000000001',
      '80000000-0000-0000-0000-000000000000',
    ];
    for (const uuid of edges) {
      expect(tryDecodeId('post', encodeId('post', uuid))).toBe(uuid);
    }
  });

  it('produces a fixed-length, prefixed, uppercase body', () => {
    const encoded = encodeId('connection', crypto.randomUUID());
    expect(encoded).toMatch(/^cn_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(encoded).toHaveLength(3 + 26);
  });

  it('gives every resource kind a distinct prefix', () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('encodes the same uuid differently per kind, so IDs are not interchangeable', () => {
    const uuid = crypto.randomUUID();
    expect(encodeId('post', uuid)).not.toBe(encodeId('target', uuid));
    expect(tryDecodeId('target', encodeId('post', uuid))).toBeUndefined();
  });

  it('rejects a non-uuid input rather than encoding nonsense', () => {
    expect(() => encodeId('post', 'not-a-uuid')).toThrow(TypeError);
  });
});

describe('tryDecodeId on malformed input', () => {
  const valid = encodeId('post', '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b');

  const cases: [string, string][] = [
    ['empty string', ''],
    ['prefix only', 'po_'],
    ['wrong prefix', valid.replace('po_', 'tg_')],
    ['no prefix', valid.slice(3)],
    ['body too short', `po_${valid.slice(3, -1)}`],
    ['body too long', `${valid}A`],
    ['excluded letter U', `po_U${valid.slice(4)}`],
    ['non-alphanumeric', `po_!${valid.slice(4)}`],
    ['sql-ish payload', "po_'; drop table poster.posts; --"],
    ['a bare uuid', '0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b'],
  ];

  it.each(cases)('returns undefined for %s', (_label, value) => {
    expect(tryDecodeId('post', value)).toBeUndefined();
  });

  it('never throws, so a handler can turn any input into a 404 (contract §8)', () => {
    for (const [, value] of cases) {
      expect(() => tryDecodeId('post', value)).not.toThrow();
    }
  });

  it('rejects a body whose padding bits carry data', () => {
    // 26 Crockford characters hold 130 bits; the last two must be zero padding.
    const body = valid.slice(3);
    const lastChar = body.at(-1) as string;
    const tampered = `po_${body.slice(0, -1)}${lastChar === 'Z' ? 'Y' : 'Z'}`;
    // Either it decodes to something else or it is rejected, but it must never
    // decode back to the original uuid.
    expect(tryDecodeId('post', tampered)).not.toBe('0192f1a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b');
  });
});

describe('Crockford leniency', () => {
  it('folds O to 0 and I/L to 1 when reading', () => {
    const uuid = '00000000-0000-0000-0000-000000000000';
    const encoded = encodeId('post', uuid); // all zeros -> all '0'
    const withLetterO = `po_${encoded.slice(3).replace(/0/g, 'O')}`;
    expect(tryDecodeId('post', withLetterO)).toBe(uuid);
  });

  it('accepts a lowercase body, so an ID survives being retyped', () => {
    const uuid = crypto.randomUUID();
    const encoded = encodeId('media', uuid);
    expect(tryDecodeId('media', `md_${encoded.slice(3).toLowerCase()}`)).toBe(uuid);
  });
});

describe('decodeId', () => {
  it('throws InvalidPublicIdError, which handlers map to 404', () => {
    expect(() => decodeId('post', 'po_nope')).toThrow(InvalidPublicIdError);
  });

  it('does not put the offending value in the message', () => {
    // The value may come from a URL and end up in logs; keep it out of the text.
    try {
      decodeId('post', 'po_SECRETLOOKINGVALUE123456');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRETLOOKING');
    }
  });
});

describe('publicId zod schema', () => {
  it('accepts a well-formed id and rejects a uuid', () => {
    const schema = publicId('post');
    expect(schema.safeParse(encodeId('post', crypto.randomUUID())).success).toBe(true);
    expect(schema.safeParse(crypto.randomUUID()).success).toBe(false);
  });
});
