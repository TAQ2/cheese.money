import { OPENABLE_FILE_EXTENSIONS } from "../../openableFileExtensions";

/**
 * What an inline code span is, when it is something the user can open.
 *
 * Most backticked text in a chat is an identifier, a flag, or a fragment of
 * code, and an affordance offered on those is noise. So this is deliberately
 * a *precision* filter, not a recall one: everything here has to be evidence
 * strong enough that a wrong guess would be surprising.
 *
 * Spans that already read unambiguously as paths (`src/main.ts`,
 * `./notes.md:12`, `/Users/me/x.py`) are NOT decided here —
 * `resolveInlineCodeFileLinkMeta` in `markdown-links.ts` owns those. This
 * module adds the two shapes that resolver deliberately refuses because they
 * cannot be settled by looking at the text alone:
 *
 *   - a web URL, which is not a file at all;
 *   - a path that only the project can confirm — a bare filename with no
 *     directory (`policy_definitions.py`), or a path whose directories
 *     contain spaces (`change requests/2026-08-04-notes.md`).
 *
 * The second kind produces a *probe*, not a target. Nothing is offered to
 * the user until the project's own file index says the file is there, since
 * an arrow that opens nothing is worse than no arrow.
 */

const POSITION_SUFFIX_PATTERN = /:(\d+)(?::(\d+))?$/;
/**
 * Characters that mark a span as code rather than a path: shell syntax,
 * expression syntax, quoting. A real filename can legally contain some of
 * these, and losing those few is the price of never lighting up
 * `SCORE_BUCKETS["idx2".."idx5"]`.
 */
const CODE_PUNCTUATION_PATTERN = /[`<>|&$"'*?{}()[\]=;:,!@#^~+]/;
const MAX_PROBE_LENGTH = 240;
const MAX_PROBE_WORDS = 10;

export interface InlineCodeUrlTarget {
  readonly kind: "url";
  readonly href: string;
}

export interface InlineCodeFileProbe {
  /** The path as written: forward slashes, no position suffix, no `./`. */
  readonly path: string;
  readonly fileName: string;
  /** False when the span named a file and nothing about where it lives. */
  readonly hasDirectory: boolean;
  readonly line?: number;
  readonly column?: number;
}

/**
 * A web URL, or null. Only http and https qualify: those are the schemes a
 * browser can be handed safely, and every other scheme in a code span
 * (`file:`, `data:`, `mailto:`, a custom protocol) is either a security
 * question or not a link at all.
 */
export function detectInlineCodeUrl(codeText: string): InlineCodeUrlTarget | null {
  // Taken exactly as written. Inside backticks the delimiter IS the
  // backtick, so there is no sentence punctuation to shed — and trimming a
  // trailing ")" here would quietly break every Wikipedia-style URL that
  // legitimately ends in one.
  const candidate = codeText.trim();
  if (candidate.length === 0 || /\s/.test(candidate)) return null;
  if (!/^https?:\/\//i.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  // "https://" alone parses, with an empty host.
  if (parsed.hostname.length === 0) return null;
  return { kind: "url", href: parsed.href };
}

/**
 * A span that might name a file in this project, to be confirmed against the
 * file index before anything is offered. Returns null for everything that
 * can be ruled out from the text alone.
 */
export function detectInlineCodeFileProbe(codeText: string): InlineCodeFileProbe | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROBE_LENGTH) return null;
  if (/[\n\r\t]/.test(trimmed)) return null;
  if (trimmed.startsWith("-")) return null;

  const withoutPosition = trimmed.replace(POSITION_SUFFIX_PATTERN, "");
  const positionMatch = POSITION_SUFFIX_PATTERN.exec(trimmed);
  const candidate = withoutPosition.replaceAll("\\", "/").replace(/^\.\//, "");
  if (candidate.length === 0) return null;
  if (CODE_PUNCTUATION_PATTERN.test(candidate)) return null;
  if (candidate.includes("//")) return null;
  // A whole sentence that happens to end in a filename is prose, not a path.
  if (candidate.trim().split(/\s+/).length > MAX_PROBE_WORDS) return null;

  const fileName = candidate.slice(candidate.lastIndexOf("/") + 1);
  // A real directory name can hold spaces, a filename effectively never
  // does — and without this, `python manage.py` becomes a "filename" of
  // `python manage.py`, which is then sent to the file index as a query
  // that cannot possibly match anything.
  if (/\s/.test(fileName)) return null;
  const dotIndex = fileName.lastIndexOf(".");
  // A leading dot is the whole name of a dotfile (`.gitignore`), not an
  // extension boundary.
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return null;
  if (!OPENABLE_FILE_EXTENSIONS.has(fileName.slice(dotIndex + 1).toLowerCase())) return null;

  const line = positionMatch?.[1] ? Number.parseInt(positionMatch[1], 10) : Number.NaN;
  const column = positionMatch?.[2] ? Number.parseInt(positionMatch[2], 10) : Number.NaN;
  return {
    path: candidate,
    fileName,
    hasDirectory: candidate.includes("/"),
    ...(Number.isFinite(line) ? { line } : {}),
    ...(Number.isFinite(column) ? { column } : {}),
  };
}

/**
 * Picks the project file a probe refers to, or null when the project cannot
 * answer without guessing.
 *
 * Ambiguity is refused on purpose. Three `index.ts` in a repo means the span
 * did not identify a file, and an arrow that opens one of the three at
 * random is worse than no arrow: the user cannot tell it went somewhere
 * wrong until they are already reading the wrong file.
 */
export function resolveInlineCodeProbeEntry(
  probe: InlineCodeFileProbe,
  entries: ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }>,
): string | null {
  const files = entries.filter((entry) => entry.kind === "file");
  const wanted = probe.path.toLowerCase();
  const suffixMatches = files.filter((entry) => {
    const normalized = entry.path.replaceAll("\\", "/").toLowerCase();
    return normalized === wanted || normalized.endsWith(`/${wanted}`);
  });
  if (suffixMatches.length === 1) return suffixMatches[0]?.path ?? null;
  // More than one file sits under a path that ends this way — the span did
  // not say which.
  if (suffixMatches.length > 1) return null;
  // A span carrying directories that match nothing named a place this
  // project does not have; only a bare filename may be looked up by name.
  if (probe.hasDirectory) return null;

  const wantedName = probe.fileName.toLowerCase();
  const nameMatches = files.filter((entry) => {
    const normalized = entry.path.replaceAll("\\", "/").toLowerCase();
    return normalized.slice(normalized.lastIndexOf("/") + 1) === wantedName;
  });
  return nameMatches.length === 1 ? (nameMatches[0]?.path ?? null) : null;
}
