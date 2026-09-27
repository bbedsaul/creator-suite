/**
 * Builds a tiny but structurally valid MP4, in code rather than as a committed
 * binary.
 *
 * The demo has to upload a **video**: the TikTok and YouTube constraint specs
 * accept `kinds: ["video"]` only, and `POST /v1/media` reads duration and
 * dimensions from the file with ffprobe and refuses anything it cannot measure
 * (contract §5, v1.4). So a one-pixel PNG will not do.
 *
 * Why generate it:
 *   - no ffmpeg dependency, on a developer machine or in CI;
 *   - no opaque blob in git whose provenance and licence nobody can state;
 *   - the dimensions are a parameter, so a test can ask for a portrait file and a
 *     landscape one and watch the constraint engine treat them differently.
 *
 * What it is: `ftyp` + `moov` (one h264 video track whose `avc1` sample entry
 * carries the width and height ffprobe reports) + a stub `mdat`. The sample data
 * is not decodable, which is fine — nothing decodes it. ffprobe prints complaints
 * about the NAL units on **stderr**, exits 0, and emits correct JSON on stdout,
 * which is all the prober reads.
 */

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/** An ISO BMFF box: length, four-character type, payload. */
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
}

/** A FullBox: a box whose payload starts with a version byte and 24 flag bits. */
function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  return box(
    type,
    Buffer.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]),
    ...parts,
  );
}

/** The 3x3 transform every track carries. Identity. */
const UNITY_MATRIX = Buffer.concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

export interface FixtureVideoOptions {
  /** Pixels. Defaults to a 1080x1920 vertical frame, the shape short video wants. */
  readonly width?: number;
  readonly height?: number;
  /** Seconds. Defaults to 1; the specs allow far longer, and bytes cost nothing. */
  readonly durationS?: number;
}

export function buildFixtureVideo(options: FixtureVideoOptions = {}): Buffer {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const durationS = options.durationS ?? 1;

  const timescale = 1000;
  const duration = Math.round(durationS * timescale);

  const ftyp = box(
    'ftyp',
    Buffer.from('isom', 'latin1'),
    u32(0x200),
    Buffer.from('isomiso2avc1mp41', 'latin1'),
  );

  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0), // creation time
    u32(0), // modification time
    u32(timescale),
    u32(duration),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), // reserved
    UNITY_MATRIX,
    Buffer.alloc(24), // pre_defined
    u32(2), // next_track_ID
  );

  const tkhd = fullBox(
    'tkhd',
    0,
    3, // enabled | in movie
    u32(0),
    u32(0),
    u32(1), // track_ID
    u32(duration),
    Buffer.alloc(8), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume (0 for video)
    u16(0), // reserved
    UNITY_MATRIX,
    u32(width << 16), // 16.16 fixed point
    u32(height << 16),
  );

  const mdhd = fullBox(
    'mdhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(duration),
    u16(0x55c4), // language: und
    u16(0),
  );

  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    u32(0),
    Buffer.from('vide', 'latin1'),
    Buffer.alloc(12),
    Buffer.from('VideoHandler\0', 'latin1'),
  );

  const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

  // AVC decoder configuration: profile, level, and one SPS/PPS pair. The bytes
  // are a plausible baseline-profile shape rather than a real encode; ffprobe
  // reads the codec name from here and the frame size from `avc1` below.
  const avcC = box(
    'avcC',
    Buffer.from([
      0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e, 0x01, 0x00, 0x04,
      0x68, 0xce, 0x3c, 0x80,
    ]),
  );

  // The visual sample entry. `width` and `height` here are what ffprobe reports,
  // and therefore what the API stores and the constraint engine checks.
  const avc1 = box(
    'avc1',
    Buffer.alloc(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    u32(0),
    u32(0),
    u32(0), // pre_defined
    u16(width),
    u16(height),
    u32(0x00480000), // 72 dpi horizontal
    u32(0x00480000), // 72 dpi vertical
    u32(0), // reserved
    u16(1), // frame_count
    Buffer.alloc(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    avcC,
  );

  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), avc1),
    fullBox('stts', 0, 0, u32(1), u32(1), u32(duration)), // one sample, whole duration
    fullBox('stss', 0, 0, u32(1), u32(1)), // sample 1 is a sync sample
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(1), u32(4)), // one 4-byte sample
    fullBox('stco', 0, 0, u32(1), u32(0)), // chunk offset, patched below
  );

  const moov = box(
    'moov',
    mvhd,
    box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl))),
  );

  const mdat = box('mdat', Buffer.alloc(4));

  // `stco` holds an absolute file offset, so it can only be filled in once the
  // sizes of everything before `mdat` are known.
  const sampleOffset = ftyp.length + moov.length + 8;
  const stcoType = moov.indexOf(Buffer.from('stco', 'latin1'));
  if (stcoType === -1) throw new Error('stco box not found while patching the chunk offset');
  // type (4) + version/flags (4) + entry_count (4) → the single entry.
  moov.writeUInt32BE(sampleOffset, stcoType + 12);

  return Buffer.concat([ftyp, moov, mdat]);
}
