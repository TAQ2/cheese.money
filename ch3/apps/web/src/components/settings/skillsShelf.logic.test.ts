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
});
