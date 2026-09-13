import { OPENABLE_FILE_EXTENSIONS } from "../../openableFileExtensions";

/**
 * An absolute path written in ordinary prose, so it can be drawn as a file
 * chip instead of left as a wall of raw text.
 *
 * Backticked and linked paths were already chips; a path pasted into a
 * sentence was not, which is how most people actually hand one over — "review
 * this one: /Users/me/Notes/brief.md and tell me what you think".
 */
export interface ProseFilePathMatch {
  /** Index of the first character of the path within the scanned text. */
  readonly start: number;
  /** Index one past the last character, which is always the extension's end. */
  readonly end: number;
  readonly path: string;
}

/** Beyond this a "path" is a paragraph that happens to contain a slash. */
const MAX_PROSE_PATH_LENGTH = 400;

/**
 * An extension that ends a word. `[A-Za-z0-9]` only, so `.tar.gz` anchors on
 * `gz` and a version like `v1.2` cannot anchor at all.
 */
const EXTENSION_PATTERN = /\.([A-Za-z0-9]+)/g;

/**
 * Where a path may begin: a `/` or `~/` that starts the line, or follows
 * whitespace, an opening bracket or a quote — `(/tmp/notes.md)` is how people
 * write an aside.
 *
 * What is deliberately NOT in that set is a colon or another slash, and that
 * is what keeps URLs out without a special case for them. In
 * `https://example.com/notes.md` the `//` follows a colon and the inner `/`
 * follows `m`, so neither can open a path, and the whole URL is left to the
 * link handling that already owns it.
 */
const PATH_START_PATTERN = /(?:^|[\s([{"'])(~?\/)/g;

/**
 * Absolute paths written in prose, in the order they appear, non-overlapping.
 *
 * Anchored on the extension and scanned BACKWARDS to the nearest opening
 * slash, because that is the only way to admit the directory names people
 * actually have: `/Users/me/CH3 Repos/iOS Alt-Data Program — CCRs/brief.md`
 * has spaces and an em dash in it, so a forward scan has no way to know where
 * the path stops and the sentence resumes. The extension does know.
 *
 * The allowlist is `OPENABLE_FILE_EXTENSIONS`, the same set that decides
 * whether an inline-code span names a file, so prose and backticks cannot
 * disagree about what a file is.
 */
export function detectProseFilePaths(text: string): ReadonlyArray<ProseFilePathMatch> {
  const matches: ProseFilePathMatch[] = [];
  let consumedUpTo = 0;

  for (const extensionMatch of text.matchAll(EXTENSION_PATTERN)) {
    const extension = extensionMatch[1];
    const matchIndex = extensionMatch.index;
    if (extension === undefined || matchIndex === undefined) continue;
    if (!OPENABLE_FILE_EXTENSIONS.has(extension.toLowerCase())) continue;

    const end = matchIndex + extensionMatch[0].length;
    // A further path character means this was a directory (`/a/b.md/c.txt`)
    // or a longer word, not the end of a filename.
    const following = text[end];
    if (following !== undefined && /[A-Za-z0-9/]/.test(following)) continue;

    // The nearest opening slash before the extension wins. Nearest, not
    // first: `see /tmp/a.md or /tmp/b.md` has two paths, and the second must
    // not swallow the prose between them.
    let start: number | null = null;
    PATH_START_PATTERN.lastIndex = 0;
    for (const startMatch of text.matchAll(PATH_START_PATTERN)) {
      const candidate =
        (startMatch.index ?? 0) + (startMatch[0].length - (startMatch[1]?.length ?? 0));
      if (candidate >= matchIndex) break;
      if (candidate < consumedUpTo) continue;
      start = candidate;
    }
    if (start === null) continue;

    const path = text.slice(start, end);
    if (path.length > MAX_PROSE_PATH_LENGTH) continue;
    // A path cannot span lines, and a filename cannot contain a slash-free
    // newline — either way the backward scan crossed into a different
    // sentence and the match is not real.
    if (/[\n\r]/.test(path)) continue;

    matches.push({ start, end, path });
    consumedUpTo = end;
  }

  return matches;
}
