/**
 * Managing the skills Claude Code loads, from inside CH3.
 *
 * A skill is a directory holding a `SKILL.md` with YAML frontmatter, and
 * Claude Code reads them from the config directory of whichever account is in
 * use. CH3 already discovers them for the `$` picker; these two commands are
 * the other half — seeing what is installed is only useful if a new one can be
 * added without leaving the app for a terminal.
 *
 * **Writes always land in the canonical store**, `~/.claude/skills`, never in
 * the active profile's own directory. Every numbered profile symlinks its
 * `skills` at that one directory (see `shareClaudeAssetDirectory`), so a skill
 * written there exists for every account at once — which is what a person
 * means by "my skills". Writing to the profile instead would put a skill on
 * one account and hide it from the rest, and the account in use moves on its
 * own when failover fires.
 *
 * @module claudeSkills
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A skill's directory name, which is also the name Claude Code addresses it
 * by.
 *
 * Lowercase, digits and single hyphens. The pattern is the validation: this
 * value becomes a path segment, so `..`, a separator or a leading dot would
 * be a write outside the store, and the CLI matches `$name` against the
 * directory name, so an uppercase or spaced name is one a person cannot type.
 */
export const ClaudeSkillName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);
export type ClaudeSkillName = typeof ClaudeSkillName.Type;

export const ClaudeSkillCreateInput = Schema.Struct({
  name: ClaudeSkillName,
  /**
   * The one line Claude reads to decide whether a skill applies. Optional
   * because a template with a placeholder is more useful than a refusal, and
   * the file is editable the moment it exists.
   */
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ClaudeSkillCreateInput = typeof ClaudeSkillCreateInput.Type;

export const ClaudeSkillCreateResult = Schema.Struct({
  name: ClaudeSkillName,
  /** Absolute path of the new `SKILL.md`, so the client can offer to open it. */
  path: TrimmedNonEmptyString,
});
export type ClaudeSkillCreateResult = typeof ClaudeSkillCreateResult.Type;

export const ClaudeSkillDeleteInput = Schema.Struct({
  name: ClaudeSkillName,
});
export type ClaudeSkillDeleteInput = typeof ClaudeSkillDeleteInput.Type;

export const ClaudeSkillDeleteResult = Schema.Struct({
  name: ClaudeSkillName,
  /** False when there was nothing to delete, which is not an error. */
  removed: Schema.Boolean,
});
export type ClaudeSkillDeleteResult = typeof ClaudeSkillDeleteResult.Type;

/**
 * Why a skill write was refused.
 *
 * `exists` is separate from `failed` because it is the only one the person can
 * act on without help: pick another name. `not-shared` reports the one state
 * that would otherwise be silent — the canonical store could not be created,
 * so a write would have reached a single account's directory and looked like
 * it worked everywhere.
 */
export class ClaudeSkillError extends Schema.TaggedErrorClass<ClaudeSkillError>()(
  "ClaudeSkillError",
  {
    reason: Schema.Literals(["exists", "not-found", "not-shared", "failed"]),
    message: Schema.String,
  },
) {}
