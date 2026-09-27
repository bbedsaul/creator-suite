/**
 * The generated MP4.
 *
 * Structure only — that it is *readable* by ffprobe is proven where it matters,
 * by the demo's upload step against the real API, and by the contract test.
 * Testing the byte layout here is what makes a regression in the builder show up
 * as a clear failure rather than as a mysterious 400 from `POST /v1/media`.
 */
import { describe, expect, it } from 'vitest';
import { buildFixtureVideo } from '../src/fixture-video.js';

/**
 * Finds the `avc1` sample entry.
 *
 * Not `indexOf('avc1')`: the `ftyp` brand list contains the literal
 * `isomiso2avc1mp41`, so a naive search lands in the file header and reads
 * zeroes. The sample entry is the first `avc1` after `stsd`.
 */
function avc1Offset(file: Buffer): number {
  const stsd = file.indexOf(Buffer.from('stsd', 'latin1'));
  expect(stsd).toBeGreaterThan(0);
  const offset = file.indexOf(Buffer.from('avc1', 'latin1'), stsd);
  expect(offset).toBeGreaterThan(stsd);
  return offset;
}

/** Walks the top-level box list. */
function topLevelBoxes(file: Buffer): { type: string; size: number }[] {
  const boxes: { type: string; size: number }[] = [];
  let offset = 0;
  while (offset + 8 <= file.length) {
    const size = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString('latin1');
    boxes.push({ type, size });
    if (size < 8) break;
    offset += size;
  }
  return boxes;
}

describe('buildFixtureVideo', () => {
  it('produces ftyp, moov and mdat, in that order, with no trailing bytes', () => {
    const file = buildFixtureVideo();
    const boxes = topLevelBoxes(file);

    expect(boxes.map((box) => box.type)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(boxes.reduce((total, box) => total + box.size, 0)).toBe(file.length);
  });

  it('declares the requested dimensions in the avc1 sample entry', () => {
    const file = buildFixtureVideo({ width: 720, height: 1280 });
    const avc1 = avc1Offset(file);

    // avc1 payload: 6 reserved + 2 data_reference_index + 16 pre_defined/reserved,
    // then width and height as 16-bit values.
    expect(file.readUInt16BE(avc1 + 4 + 24)).toBe(720);
    expect(file.readUInt16BE(avc1 + 4 + 26)).toBe(1280);
  });

  it('defaults to a vertical 1080x1920 frame', () => {
    const file = buildFixtureVideo();
    const avc1 = avc1Offset(file);
    expect(file.readUInt16BE(avc1 + 4 + 24)).toBe(1080);
    expect(file.readUInt16BE(avc1 + 4 + 26)).toBe(1920);
  });

  it('encodes the duration in the movie header timescale', () => {
    const file = buildFixtureVideo({ durationS: 7 });
    const mvhd = file.indexOf(Buffer.from('mvhd', 'latin1'));
    // mvhd payload: version/flags, creation, modification, timescale, duration.
    expect(file.readUInt32BE(mvhd + 4 + 12)).toBe(1000);
    expect(file.readUInt32BE(mvhd + 4 + 16)).toBe(7000);
  });

  it('points the chunk offset at the sample inside mdat', () => {
    const file = buildFixtureVideo();
    const stco = file.indexOf(Buffer.from('stco', 'latin1'));
    const offset = file.readUInt32BE(stco + 12);
    const mdat = file.indexOf(Buffer.from('mdat', 'latin1'));

    // The offset must land just past the mdat header, inside the file.
    expect(offset).toBe(mdat + 4);
    expect(offset).toBeLessThan(file.length);
  });

  it('stays small enough to be a fixture rather than a payload', () => {
    expect(buildFixtureVideo().length).toBeLessThan(2048);
  });
});
