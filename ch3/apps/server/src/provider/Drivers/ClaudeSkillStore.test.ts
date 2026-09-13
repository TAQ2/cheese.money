// @effect-diagnostics nodeBuiltinImport:off - fixtures build and read a real temporary skills store on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { parse as parseYamlDocument } from "yaml";
import { describe, expect } from "vite-plus/test";

import {
  buildSkillMarkdown,
  createClaudeSkill,
  deleteClaudeSkill,
  skillFrontmatterRoundTrips,
} from "./ClaudeSkillStore.ts";

function temporaryStore(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-skills-"));
}

describe("createClaudeSkill", () => {
  it.effect("writes a SKILL.md whose frontmatter parses", () =>
    Effect.gen(function* () {
      const store = temporaryStore();

      const result = yield* createClaudeSkill({ name: "release-notes" }, store);

      expect(result.path).toBe(NodePath.join(store, "release-notes", "SKILL.md"));
      const block = /^---\n([\s\S]*?)\n---/.exec(NodeFS.readFileSync(result.path, "utf8"))?.[1];
      const parsed = parseYamlDocument(block ?? "") as Record<string, unknown>;
      expect(parsed["name"]).toBe("release-notes");
      expect(typeof parsed["description"]).toBe("string");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a description with a colon in it as one value", () =>
    Effect.gen(function* () {
      // The trap this guards: an unquoted `: ` turns the description into a
      // YAML mapping, the whole block fails to parse, and Claude Code skips
      // the skill with no error anywhere.
      const store = temporaryStore();
      const description = "Use when: the build fails and nobody knows why";

      const result = yield* createClaudeSkill({ name: "triage", description }, store);

      const block = /^---\n([\s\S]*?)\n---/.exec(NodeFS.readFileSync(result.path, "utf8"))?.[1];
      const parsed = parseYamlDocument(block ?? "") as Record<string, unknown>;
      expect(parsed["description"]).toBe(description);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a name that is already installed, rather than replacing it", () =>
    Effect.gen(function* () {
      const store = temporaryStore();
      yield* createClaudeSkill({ name: "triage", description: "first" }, store);

      const failure = yield* createClaudeSkill(
        { name: "triage", description: "second" },
        store,
      ).pipe(Effect.flip);

      expect(failure.reason).toBe("exists");
      // The original survived untouched.
      const kept = NodeFS.readFileSync(NodePath.join(store, "triage", "SKILL.md"), "utf8");
      expect(kept).toContain("first");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("deleteClaudeSkill", () => {
  it.effect("removes the skill directory", () =>
    Effect.gen(function* () {
      const store = temporaryStore();
      yield* createClaudeSkill({ name: "triage" }, store);

      const result = yield* deleteClaudeSkill({ name: "triage" }, store);

      expect(result.removed).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(store, "triage"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a skill that was not there without failing", () =>
    Effect.gen(function* () {
      // Deleting something already gone is the state the caller wanted, and a
      // panel that shows an error for it teaches people to ignore errors.
      const result = yield* deleteClaudeSkill({ name: "never-existed" }, temporaryStore());

      expect(result.removed).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("skillFrontmatterRoundTrips", () => {
  it("rejects a block whose description was not quoted", () => {
    const handWritten = ["---", "name: triage", "description: Use when: it breaks", "---", ""].join(
      "\n",
    );

    expect(
      skillFrontmatterRoundTrips(handWritten, {
        name: "triage",
        description: "Use when: it breaks",
      }),
    ).toBe(false);
    // The module's own writer produces the same description safely.
    expect(
      skillFrontmatterRoundTrips(
        buildSkillMarkdown({ name: "triage", description: "Use when: it breaks" }),
        { name: "triage", description: "Use when: it breaks" },
      ),
    ).toBe(true);
  });
});
