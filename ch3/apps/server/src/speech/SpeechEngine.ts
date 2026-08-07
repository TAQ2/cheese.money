// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SPEECH_MAX_RAW_TEXT_CHARS, SPEECH_MAX_TEXT_CHARS } from "@ch3tools/contracts";

import { synthesizeWithEdgeTts } from "./EdgeTtsClient.ts";
import type { SpeechLanguage } from "./speechLanguage.ts";
import { prepareSpokenText } from "./spokenText.ts";

/**
 * Text to speech, synthesized natively by this server.
 *
 * Synthesis speaks Microsoft's Edge text-to-speech protocol directly (see
 * `EdgeTtsClient.ts`) — no external engine, interpreter or install step. Any
 * machine this server runs on can read replies aloud, network permitting.
 *
 * Audio still lands in a FILE-backed cache rather than being re-synthesized
 * per press: replaying a reply you are working through must be instant, and
 * the service round trip is the expensive part.
 */

/**
 * How long a synthesized clip is kept. Long enough that replaying a reply you
 * are still working through is instant, short enough that the directory does
 * not grow without bound. Anything evicted is regenerated on demand.
 */
export const SPEECH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse oversized inputs before connecting anywhere.
 *
 * Mirrors the contract's own limit rather than restating a number: the client
 * is rejected by the schema first, and this is the server's own backstop for
 * anything that reaches it another way.
 */
export const SPEECH_MAX_INPUT_CHARS = SPEECH_MAX_RAW_TEXT_CHARS;

/**
 * Ceiling on one synthesis. The service streams the audio over the network;
 * without this a stalled stream holds the request and the client's spinner
 * open forever. Generous enough that a long reply finishes — a maximum-length
 * one measured just under three minutes on the old engine.
 */
export const SPEECH_SYNTHESIS_TIMEOUT_MS = 4 * 60 * 1000;

export interface SynthesizedSpeech {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  /** True when the clip came from the cache rather than the service. */
  readonly cached: boolean;
}

/**
 * Cache key: everything that changes the audio, and nothing that does not.
 *
 * Text, voice and rate all alter the output, so all three are hashed. The key
 * is a digest rather than the text itself because the text is arbitrarily long
 * and lands in a filename.
 */
function speechCacheKey(input: {
  readonly text: string;
  readonly voice: string;
  readonly rate: string;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(`${input.voice} ${input.rate} ${input.text}`)
    .digest("hex");
}

/**
 * Delete clips older than the retention window.
 *
 * Age is read from the file's own mtime and never refreshed on a hit, so a
 * clip expires a fixed time after it was MADE rather than living forever
 * because it is replayed. Failures are swallowed: a cache that cannot be
 * pruned must not take speech down with it.
 */
export const pruneSpeechCache = Effect.fn("pruneSpeechCache")(function* (
  cacheDir: string,
  now: number,
  ttlMs: number = SPEECH_CACHE_TTL_MS,
): Effect.fn.Return<number, never, Path.Path | FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(cacheDir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  let removed = 0;
  for (const entry of entries) {
    // Clips AND the wreckage of interrupted runs: `<hash>.mp3.part` from a
    // kill mid-write, and `<hash>.mp3.txt` staging files the old external
    // engine left behind, which hold verbatim reply text. Sweeping only
    // `.mp3` would leave conversation text on disk indefinitely.
    if (!entry.endsWith(".mp3") && !entry.endsWith(".part") && !entry.endsWith(".txt")) {
      continue;
    }
    const entryPath = path.join(cacheDir, entry);
    // `node:fs` is used for the timestamp rather than the Effect filesystem
    // service because it reports `mtimeMs` as a plain number; the service
    // hands back a date-like value that Effect code is not allowed to convert.
    const modifiedMs = yield* Effect.sync(() => {
      try {
        return NodeFS.statSync(entryPath).mtimeMs;
      } catch {
        return Number.NaN;
      }
    });
    // An unreadable timestamp is treated as expired rather than immortal.
    if (!Number.isNaN(modifiedMs) && now - modifiedMs < ttlMs) continue;
    const deleted = yield* fs.remove(entryPath).pipe(Effect.result);
    if (deleted._tag === "Success") removed += 1;
  }
  return removed;
});

/**
 * Sweep the cache against the clock, for callers that just want it swept.
 *
 * Wrapped so the server's startup and shutdown paths do not have to reach for
 * a clock or the retention constant, and so a failure here can never take
 * either path down — an unswept cache is a disk-space problem, not a reason to
 * refuse to start or to hang on the way out.
 */
export const pruneSpeechCacheNow = Effect.fn("pruneSpeechCacheNow")(function* (
  cacheDir: string,
): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const removed = yield* pruneSpeechCache(cacheDir, now).pipe(Effect.orElseSucceed(() => 0));
  if (removed > 0) {
    yield* Effect.logDebug("Pruned expired speech clips.", { removed });
  }
});

export class SpeechSynthesisError extends Error {
  readonly _tag = "SpeechSynthesisError";
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

/**
 * Speak `text`, returning mp3 bytes.
 *
 * A cache hit returns immediately without touching the network, which is what
 * makes replaying the same reply feel instant. The text is cleaned for
 * listening first — code blocks, URLs and markdown notation do not survive
 * into the audio.
 */
export const synthesizeSpeech = Effect.fn("synthesizeSpeech")(function* (input: {
  readonly cacheDir: string;
  readonly text: string;
  readonly voice: string;
  readonly rate: string;
  /** The detected language of `text`; spoken cues (like the code-block one) follow it. */
  readonly language?: SpeechLanguage;
  readonly now: number;
}): Effect.fn.Return<SynthesizedSpeech, SpeechSynthesisError, Path.Path | FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const text = input.text.trim();
  if (text.length === 0) {
    return yield* Effect.fail(new SpeechSynthesisError("There is nothing to read aloud."));
  }
  if (text.length > SPEECH_MAX_INPUT_CHARS) {
    return yield* Effect.fail(
      new SpeechSynthesisError(
        `That reply is too long to read aloud (${text.length} characters, limit ${SPEECH_MAX_INPUT_CHARS}).`,
      ),
    );
  }

  yield* fs.makeDirectory(input.cacheDir, { recursive: true }).pipe(Effect.orElseSucceed(() => {}));
  // Prune before serving, so a machine left running for weeks still clears out.
  yield* pruneSpeechCache(input.cacheDir, input.now);

  // Keyed on the RAW text: cleaning is deterministic, so one reply is one
  // clip, and the key never depends on cleaning rules staying frozen.
  const cachePath = path.join(
    input.cacheDir,
    `${speechCacheKey({ text, voice: input.voice, rate: input.rate })}.mp3`,
  );
  const cached = yield* fs.readFile(cachePath).pipe(Effect.result);
  if (cached._tag === "Success" && cached.success.length > 0) {
    return { audio: cached.success, mimeType: "audio/mpeg", cached: true };
  }

  const spoken = prepareSpokenText(text, input.language ?? "en");
  if (spoken.length === 0) {
    return yield* Effect.fail(
      new SpeechSynthesisError("Nothing is left to read once code and paths are removed."),
    );
  }
  // The spoken ceiling binds AFTER cleaning: what was stripped was never
  // going to become audio, so it must not count against the reply.
  if (spoken.length > SPEECH_MAX_TEXT_CHARS) {
    return yield* Effect.fail(
      new SpeechSynthesisError(
        `That reply is too long to read aloud (${spoken.length} speakable characters, limit ${SPEECH_MAX_TEXT_CHARS}).`,
      ),
    );
  }

  const outcome = yield* Effect.result(
    Effect.tryPromise({
      try: (signal) =>
        synthesizeWithEdgeTts({
          text: spoken,
          voice: input.voice,
          rate: input.rate,
          nowMs: input.now,
          signal,
        }),
      catch: (cause) =>
        new SpeechSynthesisError(
          "The speech service could not read this reply.",
          cause instanceof Error ? cause.message : String(cause),
        ),
    }).pipe(Effect.timeoutOption(SPEECH_SYNTHESIS_TIMEOUT_MS)),
  );
  if (outcome._tag === "Failure") {
    return yield* Effect.fail(outcome.failure);
  }
  if (outcome.success._tag === "None") {
    return yield* Effect.fail(
      new SpeechSynthesisError("The speech service did not finish in time. Try again."),
    );
  }
  const audio = outcome.success.value;
  if (audio.length === 0) {
    return yield* Effect.fail(new SpeechSynthesisError("The speech service produced no audio."));
  }

  // The bytes arrive complete in memory, but promotion to the cache path still
  // goes through a side file: rename is atomic within a directory, so a reader
  // either misses or reads a whole clip, never a half-written one. The side
  // file carries a PER-CALL suffix — two concurrent requests for the same
  // reply would otherwise interleave writes into one shared file, and the
  // loser's bytes would be published under the winner's rename for the whole
  // retention window. The suffix still ends in `.part`, so the prune sweeps
  // any orphan an interrupted request leaves behind.
  const partialPath = `${cachePath}.${NodeCrypto.randomBytes(6).toString("hex")}.part`;
  const wrote = yield* fs.writeFile(partialPath, audio).pipe(Effect.result);
  if (wrote._tag === "Success") {
    yield* fs.rename(partialPath, cachePath).pipe(Effect.orElseSucceed(() => {}));
  }
  return { audio, mimeType: "audio/mpeg", cached: false };
});
