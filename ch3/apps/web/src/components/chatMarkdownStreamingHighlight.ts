/**
 * Throttle for Shiki highlighting of a code block that is still streaming in.
 *
 * While deltas arrive, a full tokenization pass runs at most once per
 * `STREAMING_HIGHLIGHT_MIN_INTERVAL_MS`; between passes the previously
 * highlighted HTML is reused and the not-yet-highlighted tail is spliced in as
 * escaped plain text, so a token delta costs a string splice instead of
 * re-tokenizing the whole block. `UncachedShikiCodeBlock` holds one state per
 * mounted block and drops it when streaming ends, falling through to the
 * cached full highlight.
 */

export const STREAMING_HIGHLIGHT_MIN_INTERVAL_MS = 150;

export interface StreamingHighlightState {
  readonly code: string;
  readonly html: string;
  readonly highlightedAt: number;
}

export interface StreamingHighlightResult {
  readonly state: StreamingHighlightState;
  readonly html: string;
  readonly highlighted: boolean;
}

const SHIKI_CLOSING_TAGS = "</code></pre>";

function escapeHtmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Splice a plain-text tail into highlighted HTML just before Shiki's closing
 * `</code></pre>`, so the tail renders inside the same block and continues the
 * last highlighted line.
 */
export function appendPlainTailToHighlightedHtml(html: string, tail: string): string {
  if (tail.length === 0) {
    return html;
  }
  const closingIndex = html.lastIndexOf(SHIKI_CLOSING_TAGS);
  if (closingIndex === -1) {
    return `${html}${escapeHtmlText(tail)}`;
  }
  return `${html.slice(0, closingIndex)}${escapeHtmlText(tail)}${html.slice(closingIndex)}`;
}

/**
 * Decide whether this delta warrants a full highlight pass. Reuses the
 * previous pass while the code only grew and the interval has not elapsed; a
 * rewritten block (previous code no longer a prefix) re-highlights
 * immediately so stale tokens never linger.
 */
export function nextStreamingHighlight(
  previous: StreamingHighlightState | null,
  input: {
    readonly code: string;
    readonly now: number;
    readonly highlight: (code: string) => string;
  },
): StreamingHighlightResult {
  if (
    previous !== null &&
    input.code.startsWith(previous.code) &&
    input.now - previous.highlightedAt < STREAMING_HIGHLIGHT_MIN_INTERVAL_MS
  ) {
    return {
      state: previous,
      html: appendPlainTailToHighlightedHtml(previous.html, input.code.slice(previous.code.length)),
      highlighted: false,
    };
  }
  const html = input.highlight(input.code);
  return {
    state: { code: input.code, html, highlightedAt: input.now },
    html,
    highlighted: true,
  };
}
