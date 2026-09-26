/**
 * Reads duration and dimensions out of an uploaded file.
 *
 * An interface with an ffprobe implementation, so the API's tests do not need a
 * media toolchain and the acceptance criteria that have nothing to do with
 * probing stay provable on a bare machine (D-062).
 *
 * Production resolves the binary from PATH, where the container image puts it via
 * `apk add ffmpeg`. Local development and CI point FFPROBE_PATH at the
 * `@ffprobe-installer/ffprobe` devDependency, because that package ships no musl
 * build and so cannot be the production path on Alpine.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface MediaProbe {
  /** Seconds, or null when the file has no duration (a still image). */
  readonly durationS: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface MediaProber {
  probe(filePath: string): Promise<MediaProbe>;
}

export class MediaProbeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MediaProbeError';
  }
}

interface FfprobeOutput {
  streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  format?: { duration?: string };
}

function firstNumber(...values: (string | number | undefined)[]): number | null {
  for (const value of values) {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export interface FfprobeOptions {
  /** Binary to run. Defaults to FFPROBE_PATH, then `ffprobe` on PATH. */
  readonly binary?: string;
  readonly timeoutMs?: number;
}

export function createFfprobeProber(options: FfprobeOptions = {}): MediaProber {
  const binary = options.binary ?? process.env['FFPROBE_PATH'] ?? 'ffprobe';
  const timeout = options.timeoutMs ?? 20_000;

  return {
    async probe(filePath) {
      let stdout: string;
      try {
        ({ stdout } = await run(
          binary,
          ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
          { timeout, maxBuffer: 8 * 1024 * 1024 },
        ));
      } catch (cause) {
        // A file we cannot read is a client problem, not a server fault: the
        // caller turns this into 400 rather than 500.
        throw new MediaProbeError(`ffprobe could not read the upload`, { cause });
      }

      let parsed: FfprobeOutput;
      try {
        parsed = JSON.parse(stdout) as FfprobeOutput;
      } catch (cause) {
        throw new MediaProbeError('ffprobe returned output that was not JSON', { cause });
      }

      const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
      return {
        durationS: firstNumber(parsed.format?.duration, video?.duration),
        width: firstNumber(video?.width),
        height: firstNumber(video?.height),
      };
    },
  };
}
