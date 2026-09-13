/**
 * The response styles CH3 ships with.
 *
 * Claude Code discovers output styles by reading markdown files out of its
 * config directory and advertising them as `available_output_styles`. CH3
 * does not own that list and cannot inject into it — so "shipping a style"
 * means writing the file where the CLI will find it, and letting the existing
 * discovery do the rest.
 *
 * Where it lands: `~/.claude/output-styles/`, the *default* config directory,
 * never a per-account profile. `ensureSharedClaudeUserAssets` already symlinks
 * every profile's `output-styles` at that one directory, so writing once makes
 * the styles visible to every Claude account CH3 manages — and to the user's
 * own terminal, which is the same directory they would have used anyway.
 *
 * **Write-if-missing, never overwrite.** These files live in the user's home
 * beside styles they wrote themselves, and someone who edits a shipped style
 * has edited it on purpose. An app that silently restored its own copy on
 * every launch would be unusable for exactly the person most likely to care.
 * The cost is that an improved style in a later build does not reach a machine
 * that already has that filename; deleting the file is how you ask for the new
 * one.
 *
 * Everything else in that directory is untouched and still discovered — the
 * shipped set is a floor, not a replacement.
 *
 * @module BundledOutputStyles
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { defaultClaudeConfigDirPath } from "./ClaudeHome.ts";
import bundledOutputStyles from "./bundledOutputStyles.json" with { type: "json" };

/**
 * The style every conversation starts on, matched against the CLI's advertised
 * names verbatim. Must equal the `name:` in `assets/output-styles/caveman.md`.
 */
export const DEFAULT_OUTPUT_STYLE = "Caveman";

/** The display names CH3 ships, in the order the styles are bundled. */
export const BUNDLED_OUTPUT_STYLE_NAMES: ReadonlyArray<string> = bundledOutputStyles.styles.map(
  (style) => readStyleName(style.contents) ?? style.fileName.replace(/\.md$/, ""),
);

/**
 * Pull `name:` out of a style's frontmatter — the string Claude Code advertises
 * and the `outputStyle` setting matches on, which is not derivable from the
 * filename (`simplified-technical-english.md` → "Simplified Technical English").
 */
function readStyleName(contents: string): string | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(contents);
  if (!match?.[1]) return null;
  const nameLine = /^name:\s*(.+)$/m.exec(match[1]);
  return nameLine?.[1]?.trim() ?? null;
}

/**
 * Write any shipped style the user does not already have.
 *
 * Total and best-effort: a directory that cannot be created or a file that
 * cannot be written leaves the style undiscovered, which costs the user a menu
 * entry. Failing a provider's startup over it would cost them the provider.
 */
export const ensureBundledClaudeOutputStyles = Effect.fn("ensureBundledClaudeOutputStyles")(
  function* (
    /**
     * Where the styles go. Defaults to the CLI's own config directory, which is
     * what production wants; tests pass a temp directory so this never writes
     * into the developer's real home.
     */
    configDirPath?: string,
  ): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stylesDir = path.join(
      configDirPath ?? (yield* defaultClaudeConfigDirPath()),
      "output-styles",
    );

    const made = yield* fs.makeDirectory(stylesDir, { recursive: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!made) return;

    for (const style of bundledOutputStyles.styles) {
      const target = path.join(stylesDir, style.fileName);
      // `exists` follows links, which is what we want: a profile pointed at a
      // style the user keeps elsewhere still counts as present.
      const present = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => true));
      if (present) continue;
      yield* fs.writeFileString(target, style.contents).pipe(Effect.orElseSucceed(() => {}));
    }
  },
);
