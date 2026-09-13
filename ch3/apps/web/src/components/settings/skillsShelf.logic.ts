import type { ServerProvider, ServerProviderSkill } from "@ch3tools/contracts";

/** The driver whose config directory holds user skills. */
const CLAUDE_DRIVER = "claudeAgent";

/**
 * The same rule the server's `ClaudeSkillName` enforces, applied before the
 * button is pressed. Duplicated deliberately: the server's copy is the one
 * that protects the filesystem and must exist whatever the client sends, and
 * this one exists so a person is told which names work instead of being
 * refused after the fact.
 */
export function isValidSkillName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed);
}

/**
 * User-scope Claude skills from the provider snapshot, one row per name.
 *
 * Project skills are excluded: they live in a repository's own
 * `.claude/skills`, and offering to delete one from a settings screen would
 * edit somebody's checkout. Several Claude instances can report the same
 * skill — they share one config directory — so names collapse rather than
 * repeat.
 */
export function visibleUserSkills(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProviderSkill> {
  const byName = new Map<string, ServerProviderSkill>();
  for (const provider of providers) {
    if (provider.driver !== CLAUDE_DRIVER) continue;
    for (const skill of provider.skills) {
      if (skill.scope === "project") continue;
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((left, right) =>
    (left.displayName ?? left.name)
      .toLowerCase()
      .localeCompare((right.displayName ?? right.name).toLowerCase()),
  );
}
