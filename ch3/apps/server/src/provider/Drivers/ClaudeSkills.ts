/**
 * ClaudeSkills — filesystem discovery of the Claude Code config directory for
 * the pickers the Agent SDK init handshake cannot fill on its own: skills for
 * the `$` picker, and response styles for the composer chip.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The Agent SDK init handshake surfaces
 * skills only as slash commands without their filesystem paths, so the
 * provider snapshot scans the same locations directly, mirroring how the
 * Codex app-server reports its skills.
 *
 * Response styles are a `<config dir>/output-styles/<file>.md` each, and are
 * scanned for the harder reason that the handshake stopped reporting them at
 * all — see `discoverClaudeOutputStyles`.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@ch3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillFrontmatter =
  /** No `---` block at all. */
  | { readonly kind: "missing" }
  /**
   * The block is not valid YAML. `name` is whatever a line-wise read could
   * still recover, because the CLI's own reader is lenient where `yaml.parse`
   * is strict — see `recoverFrontmatterField`.
   */
  | { readonly kind: "malformed"; readonly name?: string }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

/**
 * Read one `key: value` line out of a frontmatter block that failed to parse.
 *
 * A bare `: ` inside an unquoted value ("Levels: lite, full, ultra") is the
 * common way these blocks break, and it takes the whole document down with it
 * even though every other line is fine. Claude Code still loads such a file
 * (verified against CLI 2.1.263), so refusing to read anything out of it makes
 * CH3 hide assets that work. Only top-level, unindented keys are considered.
 */
function recoverFrontmatterField(block: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
  const raw = pattern.exec(block)?.[1]?.trim();
  if (!raw) {
    return undefined;
  }
  // Strip a surrounding quote pair; anything else is taken verbatim.
  const unquoted = /^(["'])([\s\S]*)\1$/.exec(raw);
  const value = (unquoted?.[2] ?? raw).trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The `name` and `description` a skill declares, or why they could not be read.
 *
 * Exported because the skills catalogue answers the same question about the
 * same file shape, and two parsers for one frontmatter would disagree the day
 * one of them learned something.
 */
export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const block = match[1] ?? "";
  const malformed = (): SkillFrontmatter => {
    const recovered = recoverFrontmatterField(block, "name");
    return { kind: "malformed", ...(recovered ? { name: recovered } : {}) };
  };

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(block);
  } catch {
    return malformed();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return malformed();
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Enumerate Claude Code skills from the user config dir and the workspace.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot. On name
 * collisions the project-scoped skill wins, matching Claude Code's
 * most-specific-wins resolution.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);

  const userSkillsDirectory = path.join(configDirPath, "skills");
  const projectSkillsDirectory = cwd ? path.join(cwd, ".claude", "skills") : undefined;
  // The project root contributes nothing when it resolves to the same
  // directory as the user root — most commonly when `cwd` is the home
  // directory itself. Without this, that second pass over the identical
  // directory re-set every name the first pass had already found, and
  // `scope: "project"` (iterated second, `Map.set` last-write-wins) silently
  // overwrote `scope: "user"` for every skill in the shared store. Compared
  // as resolved absolute paths, not the join()'d strings as given, so a
  // trailing slash or a relative `cwd` can't defeat the check.
  const rootsCollide =
    projectSkillsDirectory !== undefined &&
    path.resolve(projectSkillsDirectory) === path.resolve(userSkillsDirectory);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: userSkillsDirectory, scope: "user" },
    ...(projectSkillsDirectory !== undefined && !rootsCollide
      ? [{ directory: projectSkillsDirectory, scope: "project" as const }]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter does NOT stop Claude Code from loading the
      // skill: CLI 2.1.263 registers it under its DIRECTORY name, ignoring
      // whatever `name:` the broken block claims. Skipping it here (as this
      // did) hid working skills from the `$` picker, so mirror the CLI and
      // fall back to the directory name — the same thing an absent
      // frontmatter block already does.
      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/**
 * Response styles the CLI compiles into its own binary.
 *
 * Listed first so the discovered order matches what `available_output_styles`
 * used to report, and `default` is present for the same reason the composer
 * chip needs it: it is the CLI's own no-style style, the entry the chip shows
 * when the thread has picked nothing. The other three are filtered out by the
 * web layer's `HIDDEN_OUTPUT_STYLES`, but reporting them keeps that array the
 * single place that decides what the menu hides.
 */
const BUILT_IN_CLAUDE_OUTPUT_STYLES: ReadonlyArray<string> = [
  "default",
  "Explanatory",
  "Learning",
  "Proactive",
];

/**
 * Enumerate Claude Code response styles from `<config dir>/output-styles`.
 *
 * The SDK init handshake carried these in `available_output_styles`, and CLI
 * 2.1.263 no longer sends the field at all (verified against the shipped
 * binary and through the SDK's own `initializationResult()`). The provider
 * treated an absent list as "no styles", which hides the composer's style chip
 * outright — so every style the user wrote silently disappeared from CH3 while
 * still working perfectly in the CLI. Scanning the directory the CLI itself
 * reads is what makes the picker independent of a field the CLI may or may not
 * send.
 *
 * A style is identified by its frontmatter `name`, NOT by its filename: the
 * CLI resolves `outputStyle: "Simplified Technical English"` and rejects
 * `simplified-technical-english` for the same file. Files without a usable
 * name fall back to the filename stem, matching how skills fall back to their
 * directory name. Discovery is best-effort — an unreadable directory yields
 * the built-ins alone rather than failing the snapshot.
 */
export const discoverClaudeOutputStyles = Effect.fn("discoverClaudeOutputStyles")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const stylesDirectory = path.join(configDirPath, "output-styles");

  const entries = yield* fileSystem
    .readDirectory(stylesDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  // The CLI matches style names case-insensitively, so a file whose name only
  // differs in case from one already taken is that same style, not a second
  // entry offering it twice.
  const seen = new Set<string>(BUILT_IN_CLAUDE_OUTPUT_STYLES.map((style) => style.toLowerCase()));
  const discovered: Array<string> = [];
  for (const entry of [...entries].sort()) {
    if (!entry.toLowerCase().endsWith(".md")) {
      continue;
    }
    const contents = yield* fileSystem
      .readFileString(path.join(stylesDirectory, entry))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    // Unlike skills, a style with a broken block keeps its declared name —
    // CLI 2.1.263 resolves `outputStyle: "ZZ Probe Colon"` for a file whose
    // YAML does not parse, and never accepts the filename stem in its place.
    // So take the recovered name first and only then the stem.
    const frontmatter = parseSkillFrontmatter(contents);
    const name =
      (frontmatter.kind === "missing" ? undefined : frontmatter.name) ?? entry.slice(0, -3).trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    discovered.push(name);
  }

  return [...BUILT_IN_CLAUDE_OUTPUT_STYLES, ...discovered];
});
