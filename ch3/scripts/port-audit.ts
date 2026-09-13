/**
 * What this fork left behind, measured rather than remembered.
 *
 * CH3 was ported from a further-along fork ("BauDex") that shared a common
 * ancestor with it. Every check that ran during that port — typecheck, 6,800
 * tests, a blind QA pass — read the diff that exists. An absent feature leaves
 * no line in a diff, so none of them could see one, and three features were
 * found missing only because a person asked about them by name.
 *
 * This runs the comparison from the other fork's side, which is the only
 * direction that can see an absence:
 *
 * - **File axis.** Every path the other fork tracks that does not exist here.
 * - **Symbol axis.** For every path both forks carry, every name the other fork
 *   exports that this one does not. That catches a file taken in part — a
 *   component deleted from a module that was otherwise ported.
 *
 * Both axes are mechanical and neither is sufficient: a behaviour deleted from
 * inside a function that still exports its name is invisible to both. What they
 * guarantee is that no whole file and no exported surface goes missing unnoticed.
 *
 * The verdicts live in `docs/internals/baudex-port-audit.md`, not here. This
 * prints the current state so that file can be checked against it; a row that
 * appears here and not there is an unanswered question.
 *
 * Usage: `node scripts/port-audit.ts [--json]`
 *
 * Requires the comparison refs, fetched into this repository so they survive a
 * reboot (the original scratch clone lived in /tmp):
 *
 *   refs/port/base     the common ancestor
 *   refs/port/baudex   the other fork
 *   refs/port/ch3-pre  this fork before the port
 *
 * @module scripts/port-audit
 */
// @effect-diagnostics nodeBuiltinImport:off - A host-side git reader: it shells out to git and reads the working tree, with no Effect runtime to provide.
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const THEIRS_REF = "refs/port/baudex";
const REPO_SUBDIR = "ch3";

/** Directories whose contents are generated or vendored, so absence means nothing. */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "_generated",
  ".git",
  "release",
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx"]);

function git(args: ReadonlyArray<string>, cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 256 });
}

function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
}

function theirFiles(root: string): ReadonlyArray<string> {
  return git(["ls-tree", "-r", "--name-only", THEIRS_REF], root)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.split("/").some((segment) => IGNORED_SEGMENTS.has(segment)));
}

function theirText(root: string, path: string): string {
  try {
    return git(["show", `${THEIRS_REF}:${path}`], root);
  } catch {
    return "";
  }
}

/**
 * Exported names, read with a regex on purpose.
 *
 * A real parse would be exact and would also mean a TypeScript program per
 * file for a list of identifiers. The two forms below cover every export this
 * repository writes; a name this misses shows up as a false "missing", which
 * costs one look, while the failure that matters — a missing name reported as
 * present — needs the regex to match text that is not there.
 */
const DECLARED =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const BRACED = /^export\s*\{([^}]*)\}/gm;

function exportedNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(DECLARED)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of text.matchAll(BRACED)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name =
        part
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

export interface PortAuditReport {
  readonly theirFileCount: number;
  readonly absentFiles: ReadonlyArray<string>;
  readonly absentSymbols: ReadonlyArray<{
    readonly file: string;
    readonly names: ReadonlyArray<string>;
  }>;
}

export function runPortAudit(): PortAuditReport {
  const root = repoRoot();
  const here = NodePath.join(root, REPO_SUBDIR);
  const paths = theirFiles(root);

  const absentFiles: string[] = [];
  const absentSymbols: { file: string; names: string[] }[] = [];

  for (const path of paths) {
    const local = NodePath.join(here, path);
    if (!NodeFS.existsSync(local)) {
      absentFiles.push(path);
      continue;
    }
    if (!CODE_EXTENSIONS.has(NodePath.extname(path))) continue;
    const theirs = exportedNames(theirText(root, path));
    if (theirs.size === 0) continue;
    const ours = exportedNames(NodeFS.readFileSync(local, "utf8"));
    const names = [...theirs].filter((name) => !ours.has(name)).sort();
    if (names.length > 0) absentSymbols.push({ file: path, names });
  }

  absentFiles.sort();
  absentSymbols.sort((left, right) => right.names.length - left.names.length);
  return { theirFileCount: paths.length, absentFiles, absentSymbols };
}

// Piping this into `head` or `grep -m1` closes stdout early, and an unhandled
// EPIPE turns a normal read into a stack trace that looks like the audit failed.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

const report = runPortAudit();

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const symbolCount = report.absentSymbols.reduce((total, row) => total + row.names.length, 0);
  process.stdout.write(
    `Compared against ${THEIRS_REF}: ${report.theirFileCount} files.\n` +
      `${report.absentFiles.length} files absent here, ` +
      `${symbolCount} exported names absent across ${report.absentSymbols.length} shared files.\n\n`,
  );
  for (const path of report.absentFiles) {
    process.stdout.write(`FILE    ${path}\n`);
  }
  for (const row of report.absentSymbols) {
    process.stdout.write(`SYMBOL  ${row.file}: ${row.names.join(", ")}\n`);
  }
  process.stdout.write(
    `\nEvery line above must have a verdict in docs/internals/baudex-port-audit.md.\n`,
  );
}
