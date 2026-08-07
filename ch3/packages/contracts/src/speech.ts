import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Read a reply aloud.
 *
 * The server synthesizes and returns BYTES rather than playing the audio
 * itself: the machine running the server is often not the machine the person
 * is sitting at, and playback control (pause, restart) belongs to the client
 * anyway.
 */
/**
 * Ceiling on one read-aloud request.
 *
 * Chosen from the OUTPUT side, not the input side: the engine emits 48 kbps
 * constant-bitrate mp3, and the audio travels back as base64 inside a single
 * websocket frame on the same socket that carries live thread streaming. At
 * 40,000 characters that frame measured about 19 MB, which monopolises the
 * socket and forces the client to hold the string, the bytes and the blob at
 * once. 6,000 characters is roughly a minute of speech and a frame under
 * 1 MB — a reply longer than that is one to read, not listen to.
 */
export const SPEECH_MAX_TEXT_CHARS = 6_000;

/**
 * Ceiling on the RAW text a client may send. Wider than the spoken ceiling
 * because the server strips code blocks, tables and markdown notation before
 * speaking — a reply can carry twice the characters and still clean down to
 * under a minute of audio. The spoken ceiling above is enforced server-side
 * on what remains after cleaning, which is what actually sizes the frame.
 */
export const SPEECH_MAX_RAW_TEXT_CHARS = 12_000;

export const SpeechSynthesizeInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(SPEECH_MAX_RAW_TEXT_CHARS)),
  /**
   * An engine voice id, e.g. `en-GB-RyanNeural`.
   *
   * Format-checked HERE so a voice can only ever be a voice: the value lands
   * inside the SSML the server sends to the speech service, and pinning its
   * shape at the boundary means no quoting, markup or flag-shaped string can
   * ride in through it.
   */
  voice: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z]{2,3}(-[A-Za-z]+)+Neural$/)),
  ),
  /**
   * The voice used when the text turns out to be Spanish.
   *
   * The server, not the client, decides which voice speaks: it detects the
   * language of `text` and answers with `voice` for English or this one for
   * Spanish. Sent alongside rather than resolved client-side so the detection
   * lives next to the text it judges. Same format check as `voice`, for the
   * same reason.
   */
  spanishVoice: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z]{2,3}(-[A-Za-z]+)+Neural$/)),
  ),
  /** Rate adjustment, exactly as the engine expects it: `+20%`, `-10%`. */
  rate: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^[+-]\d{1,3}%$/))),
});
export type SpeechSynthesizeInput = typeof SpeechSynthesizeInput.Type;

export const SpeechSynthesizeResult = Schema.Struct({
  /** Base64 mp3. Sent inline because a spoken reply is a few hundred kilobytes
      at most, and a second round trip for a URL would delay playback. */
  audioBase64: Schema.String,
  mimeType: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
  /** True when this came from the cache, so a replay costs nothing. */
  cached: Schema.Boolean,
});
export type SpeechSynthesizeResult = typeof SpeechSynthesizeResult.Type;

export class SpeechSynthesizeError extends Schema.TaggedErrorClass<SpeechSynthesizeError>()(
  "SpeechSynthesizeError",
  {
    message: TrimmedNonEmptyString,
    detail: Schema.optional(TrimmedNonEmptyString),
  },
) {}
