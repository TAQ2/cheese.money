/**
 * Creating and removing the skills Claude Code loads.
 *
 * The read side already exists — `discoverClaudeSkills` scans the config
 * directory for the `$` picker. This is the write side, and it exists because
 * "see what skills I have" is only half a feature: adding one otherwise means
 * leaving the app, remembering where the CLI reads from, and getting YAML
 * frontmatter right by hand.
 *
 * ## One store, every account
 *
 * Writes go to `~/.claude/skills` — the DEFAULT config directory — whatever
 * account is currently selected. Every numbered profile has its `skills`
 * symlinked there by {@link shareClaudeAssetDirectory}, so one write is
 * visible to all of them at once, which is what a person means by "my skills".
 * Writing into the active profile instead would install a skill for one
 * account and hide it from the others, and the active account moves on its own
 * when failover fires — so the skill would appear to vanish.
 *
 * That sharing is verified rather than assumed: a profile whose `skills` is a
 * real directory instead of a link is reported, because on such a machine this
 * module's promise is false and silence would be the worst answer.
 *
 * ## Frontmatter is parsed before it is written
 *
 * A skill whose frontmatter does not parse is not a skill — Claude Code skips
 * it, and the failure is silent. The single most common way to produce one is
 * a `: ` inside an unquoted description, which turns one YAML value into a
 * mapping. So the block this module writes is built with the description
 * quoted and escaped, then parsed with the same YAML reader the discovery side
 * uses, and the write is abandoned if what came back is not what went in.
 *
 * @module provider/Drivers/ClaudeSkillStore
 */
import type {
  ClaudeSkillCreateInput,
  ClaudeSkillCreateResult,
  ClaudeSkillDeleteInput,
  ClaudeSkillDeleteResult,
} from "@ch3tools/contracts";
import { ClaudeSkillError } from "@ch3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { defaultClaudeConfigDirPath } from "./ClaudeHome.ts";

const DEFAULT_DESCRIPTION = "What this skill does, and when Claude should use it.";

const fail = (reason: ClaudeSkillError["reason"], message: string) =>
  Effect.fail(new ClaudeSkillError({ reason, message }));

/**
 * The one directory this module writes to: the default config directory's
 * `skills`, which every profile shares.
 */
export const claudeSkillStorePath = Effect.fn("claudeSkillStorePath")(
  function* (): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    return path.join(yield* defaultClaudeConfigDirPath(), "skills");
  },
);

/**
 * A `SKILL.md` whose frontmatter is known to parse.
 *
 * `JSON.stringify` is the quoting: YAML double-quoted scalars take the same
 * escapes, so a description carrying `: `, a `#`, a newline or a quote comes
 * back as one string instead of silently becoming a mapping — the trap that
 * deletes a skill without an error anywhere.
 */
export function buildSkillMarkdown(input: { name: string; description: string }): string {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    "---",
    "",
    `# ${input.name}`,
    "",
    "Replace this with what the skill should do. Everything below the",
    "frontmatter is the instruction Claude follows when the skill is used.",
    "",
  ].join("\n");
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Whether the frontmatter in `markdown` parses back to the name and
 * description that went into it. Run before the write, never after: a file
 * that fails this was never created, so there is nothing to clean up.
 */
export function skillFrontmatterRoundTrips(
  markdown: string,
  expected: { name: string; description: string },
): boolean {
  const block = FRONTMATTER_PATTERN.exec(markdown)?.[1];
  if (block === undefined) return false;
  try {
    const parsed: unknown = parseYamlDocument(block);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return record["name"] === expected.name && record["description"] === expected.description;
  } catch {
    return false;
  }
}

/**
 * Profiles whose `skills` is a real directory rather than a link to the shared
 * store, so a caller can say which accounts a write will NOT reach.
 *
 * `readLink` is the test rather than `stat`, which follows links and reports a
 * shared store as an ordinary directory.
 */
export const unsharedClaudeSkillProfiles = Effect.fn("unsharedClaudeSkillProfiles")(
  function* (): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* claudeSkillStorePath();
    const home = path.dirname(yield* defaultClaudeConfigDirPath());
    const entries = yield* fs.readDirectory(home).pipe(Effect.orElseSucceed((): string[] => []));

    const unshared: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(".claude-")) continue;
      const profileStore = path.join(home, entry, "skills");
      const exists = yield* fs.exists(profileStore).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const link = yield* fs.readLink(profileStore).pipe(Effect.orElseSucceed(() => ""));
      if (link === "" || path.resolve(link) !== path.resolve(store)) unshared.push(profileStore);
    }
    return unshared;
  },
);

/**
 * `storePath` exists for tests, which must not write into the real home
 * directory. Production never passes it — the default IS the contract, and a
 * caller free to choose the directory is a caller free to break the sharing
 * this module promises.
 */
export const createClaudeSkill = Effect.fn("createClaudeSkill")(function* (
  input: ClaudeSkillCreateInput,
  storePath?: string,
): Effect.fn.Return<ClaudeSkillCreateResult, ClaudeSkillError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = storePath ?? (yield* claudeSkillStorePath());
  const directory = path.join(store, input.name);
  const skillPath = path.join(directory, "SKILL.md");

  // An existing skill is never overwritten. The directory is the person's
  // work, and "create" answering by replacing it is the one outcome nobody
  // asks for.
  if (yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false))) {
    return yield* fail("exists", `A skill named "${input.name}" is already installed.`);
  }

  const description = input.description?.trim() || DEFAULT_DESCRIPTION;
  const markdown = buildSkillMarkdown({ name: input.name, description });
  if (!skillFrontmatterRoundTrips(markdown, { name: input.name, description })) {
    return yield* fail(
      "failed",
      "The description could not be written as valid YAML frontmatter, so nothing was created.",
    );
  }

  const made = yield* fs.makeDirectory(directory, { recursive: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!made) {
    return yield* fail("not-shared", `CH3 could not create ${directory}.`);
  }

  const written = yield* fs.writeFileString(skillPath, markdown).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!written) {
    // The empty directory would read as a broken skill in every picker.
    yield* fs.remove(directory, { recursive: true }).pipe(Effect.orElseSucceed(() => {}));
    return yield* fail("failed", `CH3 could not write ${skillPath}.`);
  }

  return { name: input.name, path: skillPath };
});

/** `storePath` is the test seam described on {@link createClaudeSkill}. */
export const deleteClaudeSkill = Effect.fn("deleteClaudeSkill")(function* (
  input: ClaudeSkillDeleteInput,
  storePath?: string,
): Effect.fn.Return<ClaudeSkillDeleteResult, ClaudeSkillError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = storePath ?? (yield* claudeSkillStorePath());
  const directory = path.join(store, input.name);

  // The name is schema-checked to a single lowercase segment, so this can only
  // fail if that check is ever loosened. Cheap, and the failure it prevents is
  // a recursive delete outside the store.
  if (path.dirname(path.resolve(directory)) !== path.resolve(store)) {
    return yield* fail("failed", `"${input.name}" does not name a skill in ${store}.`);
  }

  if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) {
    return { name: input.name, removed: false };
  }

  const removed = yield* fs.remove(directory, { recursive: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!removed) {
    return yield* fail("failed", `CH3 could not remove ${directory}.`);
  }
  return { name: input.name, removed: true };
});
