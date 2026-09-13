import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
} from "@ch3tools/contracts";
import { createModelSelection } from "@ch3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { resolveImportModelSelection, resolveImportTarget } from "./useImportClaudeSession";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

const environmentId = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const projectId = (value: string) => ProjectId.make(`00000000-0000-4000-8000-00000000000${value}`);

const project = (id: string, workspaceRoot: string) => ({
  id: projectId(id),
  environmentId,
  workspaceRoot,
  defaultModelSelection: null,
});

describe("resolveImportTarget", () => {
  it("files the thread in the named project even when the list has not caught up", () => {
    // The cockpit creates the project and imports into it in one go: the list
    // this callback closed over cannot contain it yet. Resolving through the
    // list failed the first click and worked on the second.
    const target = resolveImportTarget({
      projectRef: { environmentId, projectId: projectId("9") },
      cwd: "/engine/runs/run-1",
      projects: [],
    });

    expect(target).toEqual({
      id: projectId("9"),
      environmentId,
      defaultModelSelection: null,
    });
  });

  it("uses the live project entry when there is one, for its default model", () => {
    const known = { ...project("2", "/engine/runs"), defaultModelSelection: null };
    const target = resolveImportTarget({
      projectRef: { environmentId, projectId: projectId("2") },
      cwd: "/engine/runs/run-1",
      projects: [known],
    });

    expect(target).toBe(known);
  });

  it("falls back to the session's own working directory when no project is named", () => {
    const exact = project("1", "/Users/someone/code/app");
    const parent = project("2", "/Users/someone/code");
    expect(
      resolveImportTarget({
        projectRef: undefined,
        cwd: "/Users/someone/code/app",
        projects: [parent, exact],
      }),
    ).toBe(exact);
    expect(
      resolveImportTarget({
        projectRef: undefined,
        cwd: "/Users/someone/code/app/src",
        projects: [parent],
      }),
    ).toBe(parent);
    expect(
      resolveImportTarget({
        projectRef: undefined,
        cwd: "/somewhere/else",
        projects: [parent],
      }),
    ).toBeNull();
  });
});

const claudeInstanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(CLAUDE_DRIVER_KIND));

describe("resolveImportModelSelection", () => {
  it("keeps the model the imported conversation ran on", () => {
    // The cockpit's "Talk to Brain" resumed every finished run on Sonnet,
    // whatever it had run on: the run's own model was never passed in, so the
    // Claude tier default decided, and an Opus 5 run came back smaller with
    // nothing on screen saying so.
    expect(resolveImportModelSelection({ ranOn: "claude-opus-5", projectDefault: null })).toEqual(
      createModelSelection(claudeInstanceId, "claude-opus-5"),
    );
  });

  it("aliases what the engine recorded, rather than falling through to the default", () => {
    // Run state files carry whatever `claude --model` was given: a bare alias,
    // a dated id, or a slug the catalogue has since retired. Each of those
    // resolving to Sonnet is the same silent downgrade.
    for (const [recorded, expected] of [
      ["fable", "claude-fable-5-1"],
      ["claude-fable-5", "claude-fable-5-1"],
    ] as const) {
      expect(resolveImportModelSelection({ ranOn: recorded, projectDefault: null }).model).toBe(
        expected,
      );
    }
  });

  it("outranks the project default, because the thread's own model is the truth", () => {
    const projectDefault = createModelSelection(claudeInstanceId, "claude-sonnet-5");
    expect(resolveImportModelSelection({ ranOn: "claude-fable-5-1", projectDefault }).model).toBe(
      "claude-fable-5-1",
    );
  });

  it("falls back the way it always did when the run recorded no model", () => {
    const projectDefault = createModelSelection(claudeInstanceId, "claude-opus-5");
    expect(resolveImportModelSelection({ ranOn: null, projectDefault })).toBe(projectDefault);
    expect(resolveImportModelSelection({ ranOn: "  ", projectDefault: null }).model).toBe(
      "claude-sonnet-5",
    );
  });

  it("refuses a recorded slug that is not a Claude model", () => {
    // The recorded id is third-party data — whatever the engine wrote into its
    // own state file — and an unaliased one comes back from `normalizeModelSlug`
    // unchanged. A Claude instance carrying a Codex slug is the exact thread
    // whose first turn answered "There is an issue with the selected model
    // (gpt-5.6-sol)".
    for (const recorded of ["gpt-5.6-sol", "openai/gpt-5", "sonnet-but-not-really"]) {
      expect(resolveImportModelSelection({ ranOn: recorded, projectDefault: null }).model).toBe(
        "claude-sonnet-5",
      );
    }
    const projectDefault = createModelSelection(claudeInstanceId, "claude-opus-5");
    expect(resolveImportModelSelection({ ranOn: "gpt-5.6-sol", projectDefault })).toBe(
      projectDefault,
    );
  });

  it("keeps the project's own options when the run's model wins", () => {
    // Only the model comes from the run. Effort, context window and response
    // style are the project's, and dropping them reopened a Caveman project in
    // the default voice with no way to tell from the chip.
    const projectDefault = createModelSelection(claudeInstanceId, "claude-sonnet-5", [
      { id: "outputStyle", value: "Caveman" },
      { id: "contextWindow", value: "1m" },
    ]);

    const resolved = resolveImportModelSelection({ ranOn: "claude-opus-5", projectDefault });

    expect(resolved.model).toBe("claude-opus-5");
    expect(resolved.options).toEqual([
      { id: "outputStyle", value: "Caveman" },
      { id: "contextWindow", value: "1m" },
    ]);
  });
});
