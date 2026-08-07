/* eslint-disable no-control-regex -- This file exists to parse terminal escape
   sequences: the patterns below match ESC and other control bytes on purpose,
   so they can be interpreted or stripped instead of rendered as garbage. */
import { cn } from "../../lib/utils";

/**
 * A minimal SGR interpreter. Status line scripts emit colored text, so the
 * output has to be parsed rather than printed — but they are decoration, not a
 * terminal: cursor movement, scroll regions, and alternate buffers have no
 * meaning in a single-line badge and are dropped.
 *
 * Rather than pull in a full terminal emulator or an ANSI-to-HTML dependency
 * for two lines of text, this handles the subset scripts actually use: the
 * 16 basic colors, 256-color (`38;5;n`), truecolor (`38;2;r;g;b`), bold, dim,
 * italic, underline, and reset.
 */

const ANSI_PATTERN = /\u001b\[([0-9;]*)m/g;
// Everything else that can appear in a $(tput ...)-heavy script: strip, do not render.
const OTHER_ESCAPES_PATTERN =
  /\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-B0-2]|\u001b[=>]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

const BASIC_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
] as const;

const BRIGHT_COLORS = [
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
] as const;

/** xterm 256-color cube → hex, so `38;5;n` renders the color the script chose. */
function color256(index: number): string {
  if (index < 8) {
    return BASIC_COLORS[index] ?? "#e5e5e5";
  }
  if (index < 16) {
    return BRIGHT_COLORS[index - 8] ?? "#e5e5e5";
  }
  if (index < 232) {
    const offset = index - 16;
    const steps = [0, 95, 135, 175, 215, 255] as const;
    const r = steps[Math.floor(offset / 36) % 6] ?? 0;
    const g = steps[Math.floor(offset / 6) % 6] ?? 0;
    const b = steps[offset % 6] ?? 0;
    return `rgb(${r}, ${g}, ${b})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

interface SpanStyle {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecoration?: "underline";
  opacity?: number;
}

function applySgr(style: SpanStyle, codes: ReadonlyArray<number>): SpanStyle {
  const next: SpanStyle = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) {
      // Reset clears everything, including the dim/bold pair.
      for (const key of Object.keys(next) as Array<keyof SpanStyle>) {
        delete next[key];
      }
    } else if (code === 1) {
      next.fontWeight = "bold";
    } else if (code === 2) {
      next.opacity = 0.65;
    } else if (code === 3) {
      next.fontStyle = "italic";
    } else if (code === 4) {
      next.textDecoration = "underline";
    } else if (code === 22) {
      delete next.fontWeight;
      delete next.opacity;
    } else if (code === 23) {
      delete next.fontStyle;
    } else if (code === 24) {
      delete next.textDecoration;
    } else if (code >= 30 && code <= 37) {
      next.color = BASIC_COLORS[code - 30] ?? "#e5e5e5";
    } else if (code >= 90 && code <= 97) {
      next.color = BRIGHT_COLORS[code - 90] ?? "#ffffff";
    } else if (code >= 40 && code <= 47) {
      next.backgroundColor = BASIC_COLORS[code - 40] ?? "#000000";
    } else if (code >= 100 && code <= 107) {
      next.backgroundColor = BRIGHT_COLORS[code - 100] ?? "#666666";
    } else if (code === 39) {
      delete next.color;
    } else if (code === 49) {
      delete next.backgroundColor;
    } else if (code === 38 || code === 48) {
      const isForeground = code === 38;
      const mode = codes[index + 1];
      if (mode === 5) {
        const value = color256(codes[index + 2] ?? 7);
        if (isForeground) {
          next.color = value;
        } else {
          next.backgroundColor = value;
        }
        index += 2;
      } else if (mode === 2) {
        const value = `rgb(${codes[index + 2] ?? 0}, ${codes[index + 3] ?? 0}, ${codes[index + 4] ?? 0})`;
        if (isForeground) {
          next.color = value;
        } else {
          next.backgroundColor = value;
        }
        index += 4;
      }
    }
  }
  return next;
}

interface AnsiSpan {
  readonly text: string;
  readonly style: SpanStyle;
}

export function parseAnsiSpans(input: string): ReadonlyArray<AnsiSpan> {
  const spans: Array<AnsiSpan> = [];
  let style: SpanStyle = {};
  let cursor = 0;
  ANSI_PATTERN.lastIndex = 0;
  let match = ANSI_PATTERN.exec(input);
  while (match !== null) {
    if (match.index > cursor) {
      spans.push({ text: input.slice(cursor, match.index), style });
    }
    const codes = (match[1] ?? "")
      .split(";")
      .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)))
      .filter((value) => Number.isFinite(value));
    style = applySgr(style, codes.length === 0 ? [0] : codes);
    cursor = match.index + match[0].length;
    match = ANSI_PATTERN.exec(input);
  }
  if (cursor < input.length) {
    spans.push({ text: input.slice(cursor), style });
  }
  return spans
    .map((span) => ({ ...span, text: span.text.replace(OTHER_ESCAPES_PATTERN, "") }))
    .filter((span) => span.text.length > 0);
}

export function ClaudeStatusLine({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const lines = text.split("\n");
  return (
    <div
      data-claude-status-line="true"
      className={cn(
        "min-w-0 overflow-hidden font-mono text-[11px] leading-[1.45] whitespace-pre",
        className,
      )}
    >
      {/* oxlint-disable react/no-array-index-key -- spans and lines are derived
          purely from the text, hold no state, and are re-parsed on every
          change, so position is the only meaningful identity. */}
      {lines.map((line, lineIndex) => (
        <div key={lineIndex} className="truncate">
          {parseAnsiSpans(line).map((span, spanIndex) => (
            <span key={spanIndex} style={span.style}>
              {span.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
