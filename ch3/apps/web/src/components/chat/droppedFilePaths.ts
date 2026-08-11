/**
 * Turning dropped non-image files into composer text.
 *
 * Dragging a document onto the composer used to answer "Unsupported file type
 * … Please attach image files only." — a refusal, when the only thing the
 * reader wanted was the path they had just dragged in. Only images can travel
 * as attachments (the provider turn caps at image bytes), but a path costs
 * nothing to type and is what an agent actually needs to open the file itself.
 *
 * @module droppedFilePaths
 */

/**
 * Paths from a drop, in the order the files were dropped, de-duplicated.
 *
 * Two independent sources, because neither covers every case:
 *
 *   `getPathForFile` — Electron's `webUtils`, exact and per-File. Absent in a
 *   browser build, and returns null for a File with no path on disk.
 *
 *   `uriList` — the drag's own `text/uri-list`, which Chromium fills with
 *   `file://` URLs for a Finder drag. The fallback when the bridge is absent,
 *   and the reason a browser build is not simply broken here.
 *
 * Files whose path cannot be established are reported separately rather than
 * silently dropped: the caller still owes the reader an explanation for those.
 */
export function resolveDroppedFilePaths(input: {
  readonly files: ReadonlyArray<File>;
  readonly uriList?: string | undefined;
  readonly getPathForFile?: ((file: File) => string | null) | undefined;
}): { readonly paths: ReadonlyArray<string>; readonly unresolved: ReadonlyArray<string> } {
  const fromUriList = parseFileUriList(input.uriList);
  const paths: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  // A drag can carry file URLs while exposing no File objects at all — a drop
  // out of an app that publishes only `text/uri-list`, or one Chromium
  // declines to materialise. The URLs are the whole answer in that case, and
  // requiring a matching File turned the drop into a silent no-op.
  if (input.files.length === 0) {
    for (const path of fromUriList) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
    return { paths, unresolved };
  }

  input.files.forEach((file, index) => {
    // The bridge call is wrapped because it crosses Electron's context
    // isolation boundary with a DOM object. When that boundary refuses to
    // clone a File it throws HERE, in the renderer, before the preload's own
    // try/catch is ever reached — and an exception thrown inside a React drop
    // handler aborts it silently: no path, no error, nothing at all. That is
    // exactly what a drop looked like after the bridge was introduced.
    let bridgePath: string | null = null;
    try {
      bridgePath = input.getPathForFile?.(file) ?? null;
    } catch {
      bridgePath = null;
    }
    // The uri-list entries arrive in drop order, so index alignment holds; the
    // name check keeps a mismatched list (a drag carrying unrelated URLs) from
    // attributing the wrong path to a file.
    const listed = fromUriList[index];
    const candidate =
      bridgePath ??
      (listed !== undefined && (file.name.length === 0 || endsWithFileName(listed, file.name))
        ? listed
        : null);
    if (candidate === null || candidate.length === 0) {
      unresolved.push(file.name.length > 0 ? file.name : "file");
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    paths.push(candidate);
  });

  return { paths, unresolved };
}

/**
 * Does a uri-list path end with this file's name?
 *
 * Normalised on both sides: macOS stores filenames decomposed (NFD) while the
 * name Chromium hands to the renderer can be composed (NFC), so a plain
 * comparison fails on any accented character — and fails by claiming the file
 * has no path, which is the worst of the available answers.
 */
function endsWithFileName(path: string, name: string): boolean {
  return path.normalize("NFC").endsWith(name.normalize("NFC"));
}

/** Absolute paths from a `text/uri-list` payload; non-`file://` entries are ignored. */
function parseFileUriList(uriList: string | undefined): ReadonlyArray<string> {
  if (!uriList || uriList.trim().length === 0) return [];
  return (
    uriList
      .split(/\r?\n/)
      // "#" starts a comment line in the uri-list format.
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .flatMap((line) => {
        const path = fileUriToPath(line);
        return path === null ? [] : [path];
      })
  );
}

/**
 * `file:///Users/x/My%20Book.epub` → `/Users/x/My Book.epub`.
 *
 * Percent-decoding is the whole point: a path pasted still encoded would fail
 * every subsequent `open`, and the files that need this most are exactly the
 * ones with spaces and parentheses in their names.
 */
export function fileUriToPath(uri: string): string | null {
  if (!uri.toLowerCase().startsWith("file://")) return null;
  const withoutScheme = uri.slice("file://".length);
  // file://host/path — a UNC-style host is not a local path we can hand over.
  const pathPart = withoutScheme.startsWith("/")
    ? withoutScheme
    : withoutScheme.slice(withoutScheme.indexOf("/"));
  if (!pathPart.startsWith("/")) return null;
  try {
    return decodeURIComponent(pathPart);
  } catch {
    // A malformed escape decodes to nothing useful; the raw form would be
    // worse than admitting we could not read it.
    return null;
  }
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * A path as it should appear in the composer: bare when it is already safe to
 * paste into a shell, single-quoted when it is not.
 *
 * Quoting is not cosmetic. These paths get handed to agents that run commands
 * with them, and the common case — "Mary Beard - Women & Power_ A Manifesto
 * (2017, Liveright).epub" — carries spaces, parentheses and an ampersand, every
 * one of which changes the meaning of an unquoted word.
 */
export function formatPathForComposer(path: string): string {
  if (SHELL_SAFE.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The text a drop contributes to the composer, one path per line. */
export function composerTextForDroppedPaths(paths: ReadonlyArray<string>): string {
  return paths.map(formatPathForComposer).join("\n");
}
