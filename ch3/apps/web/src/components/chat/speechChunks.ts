import { SPEECH_MAX_RAW_TEXT_CHARS, SPEECH_MAX_TEXT_CHARS } from "@ch3tools/contracts";
import { maxSpokenLength } from "@ch3tools/shared/spokenText";

/**
 * Cutting a long document into pieces the speech service will accept.
 *
 * The server refuses anything over {@link SPEECH_MAX_TEXT_CHARS}, which is the
 * right rule for one synthesis request and the wrong answer for the reader: an
 * evidence pack is fifty thousand characters and is exactly the thing somebody
 * wants read to them on a drive. So the text is split and the parts are spoken
 * in order.
 *
 * Two ceilings bind, and only one of them is about characters the client can
 * count. {@link SPEECH_MAX_RAW_TEXT_CHARS} caps what may travel in a request.
 * {@link SPEECH_MAX_TEXT_CHARS} caps what the server will actually speak, and
 * it is measured AFTER cleaning — so the part has to be sized against
 * `maxSpokenLength`, the same rules the server runs, not against its own raw
 * length. Sizing against the raw ceiling was silently wrong for ordinary prose,
 * where cleaning removes almost nothing: a 12,000-character reply arrived as
 * 9,666 speakable characters and was refused.
 *
 * Where it cuts, in descending order of preference: a blank line, the end of a
 * sentence, a line break, a space. A cut mid-word is audible; a cut between
 * paragraphs is not. Only text with no break of any kind in a whole part — a
 * base64 blob, a minified line — is cut by length alone.
 *
 * @module speechChunks
 */

/** Break points, best first. Each is the character the part is allowed to end on. */
const BREAKS = ["\n\n", ". ", ".\n", "\n", " "] as const;

export interface SpeechSplitLimits {
  /** Characters one request may carry. Defaults to {@link SPEECH_MAX_RAW_TEXT_CHARS}. */
  readonly raw?: number;
  /** Characters one part may SPEAK as. Defaults to {@link SPEECH_MAX_TEXT_CHARS}. */
  readonly spoken?: number;
}

/**
 * Where to end a part that may be at most `window` characters long, preferring
 * the best break available. Always at least 1, so a split always advances.
 */
function cutOnBreak(rest: string, window: number): number {
  if (rest.length <= window) return rest.length;
  const head = rest.slice(0, window);
  for (const brk of BREAKS) {
    const at = head.lastIndexOf(brk);
    // Past the halfway mark, or it is not a break worth taking — a paragraph
    // boundary in the first 5% would leave a part almost entirely unused.
    if (at > window / 2) return at + brk.length;
  }
  return window;
}

/**
 * Where to end the next part so the server will accept it: within the request
 * ceiling, and within the spoken ceiling once cleaned.
 *
 * The window is aimed straight at the spoken ceiling rather than stepped down,
 * because cleaning removes a fairly stable fraction of any one reply — one
 * proportional guess usually lands, and the `window - 1` floor guarantees the
 * search ends.
 */
function cutForPart(rest: string, rawLimit: number, spokenLimit: number): number {
  let window = Math.min(rest.length, rawLimit);
  for (;;) {
    const cut = cutOnBreak(rest, window);
    const spoken = maxSpokenLength(rest.slice(0, cut));
    if (spoken <= spokenLimit) return cut;
    if (window <= 1) return 1;
    window = Math.min(Math.floor((window * spokenLimit) / spoken), window - 1);
    if (window < 1) return 1;
  }
}

/**
 * Split `text` into parts the speech service will accept, in reading order.
 *
 * A part with nothing left to say once code, paths and notation are stripped
 * is dropped rather than sent: the server would refuse it, and a refusal in
 * the middle of a document stops the reading dead. Text with nothing speakable
 * anywhere yields no parts at all, which is the signal to offer no button.
 */
export function splitForSpeech(
  text: string,
  limits: SpeechSplitLimits = {},
): ReadonlyArray<string> {
  const rawLimit = limits.raw ?? SPEECH_MAX_RAW_TEXT_CHARS;
  const spokenLimit = limits.spoken ?? SPEECH_MAX_TEXT_CHARS;

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const parts: Array<string> = [];
  let rest = trimmed;
  while (rest.length > 0) {
    const cut = cutForPart(rest, rawLimit, spokenLimit);
    const part = rest.slice(0, cut).trim();
    if (part.length > 0 && maxSpokenLength(part) > 0) parts.push(part);
    rest = rest.slice(cut);
  }
  return parts;
}
