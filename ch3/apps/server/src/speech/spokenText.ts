/**
 * Turn a reply's markdown into something worth listening to.
 *
 * The old external engine did this cleaning itself; going native moved the
 * responsibility here. The rules are aimed at what a voice ruins: code read
 * character by character, URLs spelled out, table pipes and heading markers
 * pronounced as words. Content survives — only the notation goes.
 */

/** What the listener hears in place of a code block, in the reply's own language. */
const CODE_BLOCK_CUES = {
  en: "Code block omitted.",
  es: "Bloque de código omitido.",
} as const;

export type SpokenTextLanguage = keyof typeof CODE_BLOCK_CUES;

/**
 * Remove code blocks by walking lines rather than by regex.
 *
 * A fence only counts when it OPENS a line, exactly as markdown renders it —
 * a ``` mentioned mid-sentence is prose about fences, not a fence, and must
 * not swallow the rest of the reply. Both fence characters are honoured, an
 * unterminated fence swallows to the end (matching how it would render), and
 * a run of three or more indented lines is treated as an indented code block
 * unless the lines are list items.
 */
function stripCodeBlocks(text: string, cue: string): string {
  const kept: Array<string> = [];
  let openFence: string | null = null;
  let indentRun: Array<string> = [];
  const flushIndentRun = () => {
    if (indentRun.length >= 3) kept.push(cue);
    else kept.push(...indentRun);
    indentRun = [];
  };
  for (const line of text.split("\n")) {
    if (openFence) {
      if (line.trimStart().startsWith(openFence)) {
        openFence = null;
        kept.push(cue);
      }
      continue;
    }
    const opened = /^\s*(```|~~~)/.exec(line);
    if (opened) {
      flushIndentRun();
      openFence = opened[1] ?? "```";
      continue;
    }
    if (/^(?: {4,}|\t)(?![-*+] |\d+\. )\S/.test(line)) {
      indentRun.push(line);
      continue;
    }
    flushIndentRun();
    kept.push(line);
  }
  if (openFence) kept.push(cue);
  else flushIndentRun();
  return kept.join("\n");
}

/** Terminal colour and cursor sequences, which replies quoting command output carry. */
const ANSI_PATTERN = new RegExp(
  // eslint-disable-next-line no-control-regex
  "\\x1b\\[[0-9;]*[A-Za-z]|\\x1b\\][^\\x07]*(?:\\x07|\\x1b\\\\)|\\x1b[()][AB012]",
  "g",
);
/** Control characters XML cannot represent at all; they only garble the markup. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** A markdown table row: reads as its cells, separated by the pause a comma buys. */
function speakTableRow(row: string): string {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(", ");
}

export function prepareSpokenText(text: string, language: SpokenTextLanguage = "en"): string {
  const cue = CODE_BLOCK_CUES[language];
  const escapedCue = cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    stripCodeBlocks(text, cue)
      .replace(ANSI_PATTERN, "")
      // Images before links: an image is a link with a `!` in front, so the
      // link rule alone would leave the `!` behind. Reference-style links
      // keep their text the same way inline ones do.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      // A URL is for clicking, not for hearing.
      .replace(/(^|\s)https?:\/\/\S+/g, "$1")
      // Inline code keeps its content, minus the backticks.
      .replace(/`([^`\n]+)`/g, "$1")
      // HTML tags and <autolinks> say nothing; their content already speaks.
      .replace(/<\/?[A-Za-z][^>\n]*>/g, "")
      // Lines that are only notation — table separators, horizontal rules,
      // box-drawing decoration — say nothing.
      .replace(/^[\s|:\-─━═+=_*#~<>•·…\\/]+$/gm, "")
      // Blockquote markers come off BEFORE headings, or a quoted heading
      // would keep its hash marks under the stripped `>`.
      .replace(/^\s*>\s?/gm, "")
      .replace(/^#{1,6}\s+/gm, "")
      // Only lines shaped like table rows get the row treatment; a pipe in
      // ordinary prose — shell pipelines, `a || b` — is left alone rather
      // than becoming a false pause.
      .replace(/^\s*\|.*\|\s*$/gm, speakTableRow)
      // Emphasis only where markdown would render it: delimiters hugging the
      // text with a boundary outside. `2*3*4` and `snake_case_names` carry
      // no emphasis and must not lose their characters.
      .replace(/(?<=^|[\s([{])(\*\*|__)([^*_\n]+?)\1(?=$|[\s)\]}.,;:!?])/gm, "$2")
      .replace(/(?<=^|[\s([{])([*_])([^*_\n]+?)\1(?=$|[\s)\]}.,;:!?])/gm, "$2")
      .replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/^(\s*)[-*+]\s+/gm, "$1")
      // A line that is just a file path (with optional line numbers) sounds
      // like someone reading a barcode.
      .replace(/^\s*(?:[A-Za-z]:)?(?:[/\\][\w.-]+){2,}(?::\d+(?::\d+)?)?\s*$/gm, "")
      .replace(CONTROL_CHARACTER_PATTERN, "")
      // Adjacent code blocks collapse into one cue: hearing the cue five
      // times in a row carries no more information than hearing it once, and
      // a reply that is mostly fences must not multiply into a longer
      // utterance than the reply itself.
      .replace(new RegExp(`(?:${escapedCue}\\s*){2,}`, "g"), `${cue}\n`)
      // Every removal above leaves a gap where the notation was; close them up
      // so the voice does not pause over holes in the sentence.
      .replace(/[^\S\n]{2,}/g, " ")
      .replace(/[^\S\n]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
