---
name: media-pipeline
description: How to build the shared Creator Suite media pipeline (packages/media-pipeline) used by the Podcast Clipper and later the Trainer — ingest, audio extraction, Whisper transcription and chunk stitching, structured-output LLM passes, FFmpeg cutting, 9:16 cropping, burned captions, audiograms, and job orchestration. Use this whenever you work on ingestion, transcripts, clip selection, rendering, ffmpeg commands, caption files, or pipeline jobs, even for a single step.
---

# Media pipeline

The pipeline is shared: the Clipper builds it first (D-006), and the Trainer later extends it with Zoom ingest and GPU renders. Design every step so the Trainer can add to it without rewriting it.

## Job model

- Each episode/recording runs as a sequence of **steps**: `ingest → extract_audio → transcribe → analyze (LLM) → render → publish_handoff`. Each step is a pg-boss job keyed by `(source_id, step, input_hash)`.
- Steps are **idempotent and resumable** (Clipper FR-09, NFR-03): a step first checks for its own completed output and returns it; outputs go to storage under deterministic paths (`<source_id>/<step>/<input_hash>/…`) and are recorded in the DB only after the upload succeeds.
- Every source reaches a terminal state: `completed`, `failed` with a reason, or `canceled`. A step that exhausts retries marks the source failed with the step name and error. Nothing is dropped silently.
- Renders run in a worker pool separate from API workers. Clip-length renders are CPU; leave the GPU pool as a configuration of the same worker, not a separate code path.

## Audio extraction for transcription

Compress before sending to Whisper: mono, 16 kHz, low bitrate is plenty for speech and keeps files under the API size limit.

```bash
ffmpeg -hide_banner -y -i input.mp4 -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k audio.ogg
```

## Transcription and stitching

- Request **word-level timestamps** (verbose JSON with word granularity).
- Chunk long audio into ~10-minute segments **with ~2 s overlap**, cut on silence where possible (`silencedetect`) rather than at fixed offsets.
- Stitch: add each chunk's start offset to every word timestamp, then drop words from the overlap of the later chunk whose (offset-corrected) start falls before the previous chunk's last kept word end. Test stitching with a fixture where a word straddles a boundary.
- Store the transcript as words `{ text, start, end }` plus sentence boundaries derived from punctuation; sentence boundaries drive clip snapping (Clipper FR-10).

## Structured-output LLM passes

One pass per source for selection (Clipper FR-06), same pattern for Trainer chapters and quizzes:

1. Define the output with a zod schema in the pipeline package; derive the JSON schema for the model from it.
2. Send the transcript with sentence indices, not raw timestamps; the model picks sentence ranges, and code converts to times. Models are bad at timestamps and good at choosing sentences.
3. Validate in two layers: **schema** (zod parse) and **semantic** (start < end, 30–75 s clip length, ranges within transcript, no overlapping clips, character limits per post type).
4. On failure, retry with the validation errors appended to the prompt. **Max 3 attempts**, then fail the step with the last error.
5. Log token counts and cost per pass for COGS tracking (Clipper NFR-02, Trainer NFR-07).

## FFmpeg recipes

Cut at absolute timestamps with frame-accurate re-encode (don't stream-copy clips; keyframes make cuts drift):

```bash
ffmpeg -hide_banner -y -ss 754.320 -to 812.960 -i input.mp4 \
  -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 128k -movflags +faststart clip.mp4
```

Crop to 9:16 (center crop; a later speaker-tracking step can replace the x offset):

```bash
-vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920"
```

Burned word-timed captions: generate an `.ass` file from word timings (grouping 2–5 words per line, highlighting the active word with `\k` karaoke tags), then:

```bash
-vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920,subtitles=captions.ass"
```

Caption timings in the `.ass` file must be **relative to the clip start**, not the episode. This is the most common bug; test it.

Audiogram for audio-only sources (Clipper FR-08): waveform over episode art.

```bash
ffmpeg -hide_banner -y -loop 1 -i art.jpg -ss 754.320 -to 812.960 -i episode.mp3 \
  -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg];\
[1:a]showwaves=s=1080x300:mode=cline:colors=white[w];\
[bg][w]overlay=0:1300,subtitles=captions.ass[v]" \
  -map "[v]" -map 1:a -c:v libx264 -preset veryfast -crf 22 -c:a aac -shortest -movflags +faststart clip.mp4
```

Always: `-hide_banner`, explicit codecs, `+faststart` for web playback, and capture ffmpeg stderr into the job log on failure.

## Handoff to publishing

The pipeline never publishes directly. Approved items go to the Poster through `@suite/poster-client` in app mode (D-023), with an `Idempotency-Key` derived from `(source_id, item_id, version)` and `external_ref` set so webhooks map back without a lookup table.

## Testing

- Fixtures: a 3-minute speech clip (video) and a 3-minute audio-only clip, committed under `packages/media-pipeline/fixtures/` (keep them small).
- Unit tests: stitching across boundaries, sentence snapping, `.ass` generation relative to clip start, semantic validation rules.
- Integration: full pipeline on each fixture, with the LLM mocked by a recorded response and a second run with an invalid response to prove the retry loop.
- Idempotency: run a step twice; the second run must do no work.
