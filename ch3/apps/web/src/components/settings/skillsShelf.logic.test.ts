import type { ServerProvider, ServerProviderSkill } from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isValidSkillName, visibleUserSkills } from "./skillsShelf.logic";

function skill(name: string, extra: Partial<ServerProviderSkill> = {}): ServerProviderSkill {
  return { name, path: `/Users/x/.claude/skills/${name}/SKILL.md`, enabled: true, ...extra };
}

function provider(driver: string, skills: ReadonlyArray<ServerProviderSkill>): ServerProvider {
  return {
    instanceId: driver,
    driver,
    enabled: true,
    installed: true,
    models: [],
    skills,
  } as unknown as ServerProvider;
}

describe("isValidSkillName", () => {
  it("accepts the names the server will accept, and no others", () => {
    expect(isValidSkillName("release-notes")).toBe(true);
    expect(isValidSkillName("triage2")).toBe(true);
    // Each of these becomes a path segment or a `$name` nobody can type.
    expect(isValidSkillName("Release Notes")).toBe(false);
    expect(isValidSkillName("../escape")).toBe(false);
    expect(isValidSkillName("-leading")).toBe(false);
    expect(isValidSkillName("double--hyphen")).toBe(false);
    expect(isValidSkillName("")).toBe(false);
  });
});

describe("visibleUserSkills", () => {
  it("collapses the same skill reported by several Claude instances", () => {
    const rows = visibleUserSkills([
      provider("claudeAgent", [skill("triage")]),
      provider("claudeAgent", [skill("triage"), skill("alpha")]),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["alpha", "triage"]);
  });

  it("leaves project skills and other providers out", () => {
    const rows = visibleUserSkills([
      provider("claudeAgent", [skill("user-one"), skill("repo-one", { scope: "project" })]),
      provider("codex", [skill("codex-one")]),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["user-one"]);
  });

  // Real shape, read live from `~/.ch3/caches/claudeAgent.json` on
  // 2026-09-14, corrected to what `ClaudeSkills.ts` reports post-fix: the
  // shared `~/.claude/skills` root, discovered with `cwd` equal to the home
  // directory, comes back `scope: "user"` (the collision that used to
  // overwrite it with `"project"` is gone — see `ClaudeSkills.test.ts`). A
  // genuine project skill, discovered under a real project's own `cwd`,
  // still comes back `scope: "project"` and is still dropped here — the
  // delete-safety rule this filter exists for depends on that distinction
  // being real, and it is again.
  it("keeps a real user-scope skill and drops a real project-scope one", () => {
    const fiveWhys: ServerProviderSkill = {
      name: "5y",
      path: "/Users/Conrad/.claude/skills/5y/SKILL.md",
      enabled: true,
      scope: "user",
      description: "Run a disciplined five-whys root-cause analysis on a software bug.",
    };
    const repoSkill: ServerProviderSkill = {
      name: "deploy",
      path: "/Users/Conrad/Desktop/cheese.money/.claude/skills/deploy/SKILL.md",
      enabled: true,
      scope: "project",
      description: "Deploy this repository.",
    };

    const rows = visibleUserSkills([provider("claudeAgent", [fiveWhys, repoSkill])]);

    expect(rows).toEqual([fiveWhys]);
  });
});
