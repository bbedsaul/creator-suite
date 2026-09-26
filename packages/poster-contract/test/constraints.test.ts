/**
 * The constraint engine (FR-06, contract §8).
 *
 * Table-driven across every violation code, because the engine's job is to be
 * exhaustive: a code that can never fire is a rule nobody is enforcing, and a
 * code that fires for the wrong reason misinforms a client switching on it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_VIOLATION_CODES,
  PlatformConstraintSpec,
  measureText,
  validateTarget,
  type MediaFacts,
  type PlatformConstraintSpec as Spec,
  type TargetValidationInput,
} from '../src/constraints.js';

// ---------------------------------------------------------------------------
// A permissive baseline spec, narrowed per test. Nothing here is a real platform
// limit; these are test fixtures (the real ones live in supabase/seed-data).
// ---------------------------------------------------------------------------
const BASE: Spec = {
  provisional: false,
  text: { max_length: 100, unit: 'characters' },
  media: {
    kinds: ['image', 'video'],
    mime_types: ['video/mp4', 'image/jpeg'],
    min_count: 0,
    max_count: 4,
  },
  video: { max_duration_s: 60, max_duration_is_per_account: false },
  aspect_ratio: { min: 0.5, max: 2, tolerance: 0.01 },
  threads: { supported: false },
  sources: [{ url: 'https://example.test/fixture', retrieved: '2026-09-26' }],
};

const video = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  media_id: 'md_TESTMEDIA0000000000000001',
  kind: 'video',
  mime_type: 'video/mp4',
  duration_s: 10,
  width: 1080,
  height: 1920,
  ...over,
});

const clean: TargetValidationInput = { text: 'hello', media: [video()] };

describe('measureText', () => {
  // The unit is the whole point: these three disagree on the same string.
  const emoji = 'a👍b'; // 4 UTF-16 units, 6 UTF-8 bytes, 3 code points
  const accented = 'café'; // 4 UTF-16 units, 5 UTF-8 bytes, 4 code points

  it('counts UTF-16 code units, which is what TikTok calls runes', () => {
    expect(measureText(emoji, 'utf16_code_units')).toBe(4);
    expect(measureText(accented, 'utf16_code_units')).toBe(4);
  });

  it('counts UTF-8 bytes, which is what a YouTube description is budgeted in', () => {
    expect(measureText(emoji, 'utf8_bytes')).toBe(6);
    expect(measureText(accented, 'utf8_bytes')).toBe(5);
  });

  it('counts code points, so an emoji is one character not two', () => {
    expect(measureText(emoji, 'characters')).toBe(3);
    expect(measureText(accented, 'characters')).toBe(4);
  });

  it('agrees on plain ASCII, which is why the distinction is easy to miss', () => {
    for (const unit of ['utf16_code_units', 'utf8_bytes', 'characters'] as const) {
      expect(measureText('plain ascii', unit)).toBe(11);
    }
  });
});

describe('a clean target', () => {
  it('produces no violations', () => {
    expect(validateTarget(clean, BASE)).toEqual([]);
  });

  it('is unaffected by absent optional sections of the spec', () => {
    const minimal: Spec = {
      provisional: false,
      text: { max_length: 100, unit: 'characters' },
      media: { kinds: ['video'], mime_types: ['video/mp4'], min_count: 0, max_count: 1 },
      threads: { supported: true },
      sources: BASE.sources,
    };
    expect(validateTarget(clean, minimal)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One table row per violation code.
// ---------------------------------------------------------------------------
interface Case {
  readonly code: (typeof CONSTRAINT_VIOLATION_CODES)[number];
  readonly label: string;
  readonly spec: Spec;
  readonly input: TargetValidationInput;
  readonly expect?: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    code: 'text_too_long',
    label: 'caption over the budget in its own unit',
    spec: { ...BASE, text: { max_length: 5, unit: 'characters' } },
    input: { ...clean, text: 'far too long' },
    expect: { field: 'text', max_length: 5, unit: 'characters', actual_length: 12 },
  },
  {
    code: 'text_too_long',
    label: 'title measured separately from the caption',
    spec: { ...BASE, title: { max_length: 3, unit: 'characters' } },
    input: { ...clean, title: 'long title' },
    expect: { field: 'title', max_length: 3 },
  },
  {
    code: 'text_invalid_characters',
    label: 'characters the platform refuses outright',
    spec: {
      ...BASE,
      text: { max_length: 100, unit: 'characters', forbidden_characters: ['<', '>'] },
    },
    input: { ...clean, text: 'a <script> tag' },
    expect: { field: 'text', forbidden_characters: ['<', '>'] },
  },
  {
    code: 'video_too_long',
    label: 'video beyond the duration ceiling',
    spec: { ...BASE, video: { max_duration_s: 5, max_duration_is_per_account: false } },
    input: { ...clean, media: [video({ duration_s: 12 })] },
    expect: { max_duration_s: 5, actual_duration_s: 12, per_account_limit: false },
  },
  {
    code: 'video_too_long',
    label: 'and says when the ceiling is per-account',
    spec: { ...BASE, video: { max_duration_s: 5, max_duration_is_per_account: true } },
    input: { ...clean, media: [video({ duration_s: 12 })] },
    expect: { per_account_limit: true },
  },
  {
    code: 'media_unsupported_format',
    label: 'a MIME type the platform does not accept',
    spec: BASE,
    input: { ...clean, media: [video({ mime_type: 'video/x-matroska' })] },
    expect: { actual_mime_type: 'video/x-matroska' },
  },
  {
    code: 'media_unsupported_format',
    label: 'a media kind the platform does not accept at all',
    spec: { ...BASE, media: { ...BASE.media, kinds: ['video'] } },
    input: { ...clean, media: [video({ kind: 'image', mime_type: 'image/jpeg' })] },
    expect: { accepted_kinds: ['video'], actual_kind: 'image' },
  },
  {
    code: 'aspect_ratio_invalid',
    label: 'dimensions outside the accepted ratio range',
    spec: { ...BASE, aspect_ratio: { min: 0.9, max: 1.1, tolerance: 0.01 } },
    input: { ...clean, media: [video({ width: 1920, height: 1080 })] },
    expect: { min_ratio: 0.9, max_ratio: 1.1, width: 1920, height: 1080 },
  },
  {
    code: 'thread_not_supported',
    label: 'a thread on a platform without threads',
    spec: BASE,
    input: { ...clean, thread_parts: 3 },
    expect: { thread_parts: 3 },
  },
  {
    code: 'thread_not_supported',
    label: 'a thread longer than the platform allows',
    spec: { ...BASE, threads: { supported: true, max_parts: 2 } },
    input: { ...clean, thread_parts: 5 },
    expect: { max_parts: 2, thread_parts: 5 },
  },
  {
    code: 'too_many_media',
    label: 'more attachments than the platform accepts',
    spec: { ...BASE, media: { ...BASE.media, max_count: 1 } },
    input: { ...clean, media: [video(), video({ media_id: 'md_TESTMEDIA0000000000000002' })] },
    expect: { max_count: 1, actual_count: 2 },
  },
  {
    code: 'media_required',
    label: 'no media on a platform that cannot post text alone',
    spec: { ...BASE, media: { ...BASE.media, min_count: 1 } },
    input: { text: 'words only', media: [] },
    expect: { min_count: 1, actual_count: 0 },
  },
];

describe('violation codes', () => {
  it.each(CASES.map((c) => [c.code, c.label, c] as const))('%s: %s', (code, _label, testCase) => {
    const violations = validateTarget(testCase.input, testCase.spec);
    const match = violations.find((violation) => violation.code === code);
    expect(match, `expected a ${code} violation, got ${JSON.stringify(violations)}`).toBeDefined();
    if (testCase.expect !== undefined) {
      expect(match?.constraint).toMatchObject(testCase.expect);
    }
  });

  it('exercises every declared code, so none is unreachable', () => {
    const covered = new Set(CASES.map((testCase) => testCase.code));
    const missing = CONSTRAINT_VIOLATION_CODES.filter((code) => !covered.has(code));
    expect(missing, `no table row produces: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('violation reporting', () => {
  it('returns every violation, so a post can be fixed in one pass', () => {
    const spec: Spec = {
      ...BASE,
      text: { max_length: 3, unit: 'characters' },
      media: { ...BASE.media, max_count: 1 },
      video: { max_duration_s: 5, max_duration_is_per_account: false },
    };
    const violations = validateTarget(
      {
        text: 'much too long',
        thread_parts: 2,
        media: [video({ duration_s: 30 }), video({ media_id: 'md_TESTMEDIA0000000000000002' })],
      },
      spec,
    );

    expect(new Set(violations.map((violation) => violation.code))).toEqual(
      new Set(['text_too_long', 'too_many_media', 'video_too_long', 'thread_not_supported']),
    );
  });

  it('names the offending media item so a client can point at it', () => {
    const violations = validateTarget(
      { ...clean, media: [video({ media_id: 'md_GUILTY00000000000000000001', duration_s: 999 })] },
      BASE,
    );
    expect(violations[0]?.media_id).toBe('md_GUILTY00000000000000000001');
  });

  it('reports one violation, not two, for a media item of a rejected kind', () => {
    // Its MIME type is also absent from the list, but "wrong kind" already
    // explains the rejection; two entries would read as two problems.
    const spec: Spec = { ...BASE, media: { ...BASE.media, kinds: ['video'] } };
    const violations = validateTarget(
      { ...clean, media: [video({ kind: 'image', mime_type: 'image/tiff' })] },
      spec,
    );
    expect(violations).toHaveLength(1);
  });

  it('skips duration and ratio checks when the facts are unknown', () => {
    // A media row probed before ffprobe ran has nulls; that is not a violation.
    const violations = validateTarget(
      { ...clean, media: [video({ duration_s: null, width: null, height: null })] },
      BASE,
    );
    expect(violations).toEqual([]);
  });

  it('accepts a ratio just outside the range but inside the tolerance', () => {
    // 1079x1920 is 9:16 in practice; rejecting it for one pixel would be absurd.
    const spec: Spec = { ...BASE, aspect_ratio: { min: 0.5625, max: 0.5625, tolerance: 0.01 } };
    expect(
      validateTarget({ ...clean, media: [video({ width: 1079, height: 1920 })] }, spec),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real seeded specs must satisfy the schema, or the API serves nonsense.
// ---------------------------------------------------------------------------
describe('the committed platform specs', () => {
  const directory = fileURLToPath(
    new URL('../../../supabase/seed-data/platform-constraints/', import.meta.url),
  );
  const files = readdirSync(directory).filter((name) => name.endsWith('.json'));

  it('includes the two M1 launch platforms (OQ-2)', () => {
    expect(files.sort()).toEqual(['tiktok.json', 'youtube.json']);
  });

  it.each(files)('%s parses against the spec schema', (name) => {
    const raw = JSON.parse(readFileSync(`${directory}${name}`, 'utf8')) as { spec: unknown };
    expect(() => PlatformConstraintSpec.parse(raw.spec)).not.toThrow();
  });

  it.each(files)('%s cites a source for its numbers', (name) => {
    const raw = JSON.parse(readFileSync(`${directory}${name}`, 'utf8')) as { spec: unknown };
    const spec = PlatformConstraintSpec.parse(raw.spec);
    expect(spec.sources.length).toBeGreaterThan(0);
    for (const source of spec.sources) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('marks both specs provisional until the aggregator is chosen (OQ-1, S09)', () => {
    for (const name of files) {
      const raw = JSON.parse(readFileSync(`${directory}${name}`, 'utf8')) as { spec: unknown };
      expect(PlatformConstraintSpec.parse(raw.spec).provisional).toBe(true);
    }
  });

  it('applies the real TikTok caption limit in UTF-16 runes', () => {
    const raw = JSON.parse(readFileSync(`${directory}tiktok.json`, 'utf8')) as { spec: unknown };
    const spec = PlatformConstraintSpec.parse(raw.spec);

    // A caption of emoji hits the rune limit at half the visible characters,
    // which is exactly the bug that picking the wrong unit would hide.
    const atLimit = '👍'.repeat(spec.text.max_length / 2);
    expect(validateTarget({ text: atLimit, media: [video()] }, spec)).toEqual([]);

    const overLimit = `${atLimit}👍`;
    const violations = validateTarget({ text: overLimit, media: [video()] }, spec);
    expect(violations.map((violation) => violation.code)).toContain('text_too_long');
  });
});
