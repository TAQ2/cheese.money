import type {
  EventId,
  OrchestrationEvent,
  OrchestrationThreadActivitiesPage,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  TurnId,
} from "@ch3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadActivitiesPage,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";

/**
 * The shape `ProviderRuntimeIngestion` writes for a tool activity: a payload
 * of `{ itemType, status, title, detail?, data }`, where `data` is the
 * driver's own `{ toolName, input, result }` object. Everything the projection
 * drops lives under `data`; the sibling keys are the part clients render.
 */
const activity = (
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity => ({
  id: "evt-1" as EventId,
  tone: "tool",
  kind: "tool.completed",
  summary: "Bash",
  payload,
  turnId: "turn-1" as TurnId,
  sequence: 1,
  createdAt: "2026-09-01T10:00:00.000Z",
  ...overrides,
});

const projectedData = (input: OrchestrationThreadActivity): Record<string, unknown> =>
  (projectActivityPayload(input).payload as { readonly data: Record<string, unknown> }).data;

describe("projecting one activity payload", () => {
  it("keeps the command and drops the tool's bulk", () => {
    // A real `Bash` completion as the Claude adapter emits it. `result.content`
    // is the whole command output — megabytes on a build — and no client reads
    // it from the activity row, which is why this projection exists.
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        status: "completed",
        title: "Bash",
        detail: "pnpm -w typecheck",
        data: {
          toolName: "Bash",
          command: "pnpm -w typecheck",
          input: { command: "pnpm -w typecheck", description: "Typecheck the workspace" },
          result: {
            command: "pnpm -w typecheck",
            content: "Tasks:    12 successful, 12 total\nCached:    9 cached, 12 total",
            isError: false,
          },
        },
      }),
    );

    const payload = projected.payload as Record<string, unknown>;
    // The sibling keys survive untouched: they are what the row renders.
    expect(payload.itemType).toBe("command_execution");
    expect(payload.status).toBe("completed");
    expect(payload.detail).toBe("pnpm -w typecheck");
    // `toolName`, `input.description` and `result.content` are gone.
    expect(payload.data).toEqual({ command: "pnpm -w typecheck" });
    expect(Object.keys(payload.data as object)).toEqual(["command"]);
  });

  it("passes an MCP tool call through whole, by reference", () => {
    // MCP payloads are the one exception: the client renders the server's own
    // structured result, so trimming it blanks the row.
    const mcp = activity({
      itemType: "mcp_tool_call",
      status: "completed",
      data: {
        toolName: "mcp__sentry__search_issues",
        input: { organizationSlug: "ch3", naturalLanguageQuery: "unresolved crashes" },
        result: { content: [{ type: "text", text: "3 issues" }] },
      },
    });
    expect(projectActivityPayload(mcp)).toBe(mcp);
  });

  it("leaves a payload it cannot read alone rather than replacing it with an empty one", () => {
    // Every one of these used to be a candidate for `{ data: {} }`, which
    // would have erased assistant text and approval rows wholesale.
    for (const payload of [
      undefined,
      null,
      "plain text",
      42,
      ["a", "b"],
      { itemType: "assistant_message" },
      { itemType: "reasoning", data: null },
      { itemType: "reasoning", data: "not a record" },
      { itemType: "reasoning", data: ["array", "is", "not", "a", "record"] },
    ]) {
      const row = activity(payload);
      expect(projectActivityPayload(row)).toBe(row);
    }
  });

  it("keeps only the command out of a nested item, and no item key when there is none", () => {
    // The Codex shape: the command hides under `data.item`, and `item.input`
    // and `item.result` carry the same unbounded output as the flat form.
    expect(
      projectedData(
        activity({
          itemType: "command_execution",
          data: {
            item: {
              id: "call_9lQ",
              command: "git status --porcelain",
              input: { command: "git status --porcelain", cwd: "/repo", timeoutMs: 120000 },
              result: { command: "git status --porcelain", output: "M apps/server/src/ws.ts" },
            },
          },
        }),
      ),
    ).toEqual({
      item: {
        command: "git status --porcelain",
        input: { command: "git status --porcelain" },
        result: { command: "git status --porcelain" },
      },
    });

    // An item with no command anywhere contributes nothing: an `item: {}` key
    // reads to the client as "a command ran and we lost it".
    expect(
      Object.keys(
        projectedData(
          activity({ itemType: "reasoning", data: { item: { id: "call_1", text: "…" } } }),
        ),
      ),
    ).toEqual([]);
  });

  it("ignores a non-record item instead of throwing on it", () => {
    expect(
      Object.keys(projectedData(activity({ itemType: "reasoning", data: { item: "call_1" } }))),
    ).toEqual([]);
    expect(
      Object.keys(projectedData(activity({ itemType: "reasoning", data: { item: null } }))),
    ).toEqual([]);
  });

  it("finds changed files under every path-like key and dedupes them", () => {
    // Both clients discover file names by walking for path-like keys, so the
    // projection has to rebuild that list from wherever the driver put it.
    const files = projectedData(
      activity({
        itemType: "file_change",
        data: {
          toolName: "Edit",
          input: { file_path: "ignored", path: "apps/web/src/App.tsx" },
          result: {
            changes: [
              { filePath: "apps/web/src/App.tsx" },
              { relativePath: "apps/server/src/ws.ts" },
              { filename: "docs/user/search.md" },
              { oldPath: "packages/shared/src/old.ts", newPath: "packages/shared/src/new.ts" },
            ],
          },
        },
      }),
    ).files;

    // `App.tsx` appears twice in the input and once in the output; a rename
    // contributes both of its names, new before old.
    expect(files).toEqual([
      { path: "apps/web/src/App.tsx" },
      { path: "apps/server/src/ws.ts" },
      { path: "docs/user/search.md" },
      { path: "packages/shared/src/new.ts" },
      { path: "packages/shared/src/old.ts" },
    ]);
  });

  it("skips a blank or non-string path rather than shipping an empty row", () => {
    expect(
      Object.keys(
        projectedData(
          activity({
            itemType: "file_change",
            data: { files: [{ path: "   " }, { path: "" }, { path: 42 }, { path: null }] },
          }),
        ),
      ),
    ).toEqual([]);
    // A path that is only surrounded by whitespace is still a path.
    expect(
      projectedData(
        activity({ itemType: "file_change", data: { files: [{ path: "  apps/web/x.ts\n" }] } }),
      ).files,
    ).toEqual([{ path: "apps/web/x.ts" }]);
  });

  it("stops collecting at twelve files", () => {
    // The cap is the point: a codemod touching 900 files must not put 900
    // names on the wire for a row that shows the first handful.
    const files = projectedData(
      activity({
        itemType: "file_change",
        data: {
          files: Array.from({ length: 40 }, (_unused, index) => ({
            path: `apps/web/src/file-${index}.ts`,
          })),
        },
      }),
    ).files as ReadonlyArray<{ readonly path: string }>;
    expect(files).toHaveLength(12);
    expect(files[0]).toEqual({ path: "apps/web/src/file-0.ts" });
    expect(files[11]).toEqual({ path: "apps/web/src/file-11.ts" });
  });

  it("stops descending after four levels, so a deeply wrapped payload terminates", () => {
    const reachable = projectedData(
      activity({
        itemType: "file_change",
        data: { data: { data: { data: { data: { path: "deep/at-four.ts" } } } } },
      }),
    );
    expect(reachable.files).toEqual([{ path: "deep/at-four.ts" }]);

    const tooDeep = projectedData(
      activity({
        itemType: "file_change",
        data: { data: { data: { data: { data: { data: { path: "deep/at-five.ts" } } } } } },
      }),
    );
    expect(Object.keys(tooDeep)).toEqual([]);
  });

  it("keeps the model a Task delegation asked for and drops its prompt", () => {
    // The subagent roster reads `input.model` to say what each delegation runs
    // on. Copying `input` itself would carry the agent's whole prompt.
    const prompt = "x".repeat(20_000);
    const projected = projectedData(
      activity({
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        data: {
          toolName: "Task",
          input: { subagent_type: "Explore", description: "find the seed", prompt, model: "opus" },
        },
      }),
    );
    expect(projected.input).toEqual({ model: "opus" });
    expect(JSON.stringify(projected)).not.toContain(prompt);
  });

  it("omits the model when it is blank, missing or not a string", () => {
    for (const model of ["", "   ", undefined, null, 5, { name: "opus" }]) {
      expect(
        projectedData(activity({ itemType: "collab_agent_tool_call", data: { input: { model } } }))
          .input,
      ).toBeUndefined();
    }
    // And an `input` that is not a record at all does not throw.
    expect(
      projectedData(activity({ itemType: "collab_agent_tool_call", data: { input: "opus" } }))
        .input,
    ).toBeUndefined();
  });

  it("does not leak a model out of any other item type's input", () => {
    // `input.model` is a Task-only allowance. Widening it to every item type
    // would start copying `input` on tools whose input is the payload bulk.
    expect(
      projectedData(activity({ itemType: "command_execution", data: { input: { model: "opus" } } }))
        .input,
    ).toBeUndefined();
  });

  it("keeps toolCallId and kind, which the client uses to pair a call with its result", () => {
    expect(
      projectedData(
        activity({
          itemType: "command_execution",
          data: { toolCallId: "call_9lQ", kind: "local_shell_call", toolName: "Bash" },
        }),
      ),
    ).toEqual({ toolCallId: "call_9lQ", kind: "local_shell_call" });
  });

  it("keeps a present-but-undefined toolCallId distinct from an absent one", () => {
    // `in` rather than a truthiness check: a driver that sets the key to
    // undefined still means "this row had a call id".
    const withKey = projectedData(
      activity({ itemType: "command_execution", data: { toolCallId: undefined } }),
    );
    expect(Object.keys(withKey)).toEqual(["toolCallId"]);
    expect(
      Object.keys(projectedData(activity({ itemType: "command_execution", data: {} }))),
    ).toEqual([]);
  });
});

describe("summarizing a tool's raw output", () => {
  const rawOutput = (value: unknown): unknown =>
    projectedData(activity({ itemType: "command_execution", data: { rawOutput: value } }))
      .rawOutput;

  it("keeps a file count and its truncation flag instead of the listing", () => {
    // Glob's real output: the names are already in `files`, so the count and
    // the flag are the whole of what the row shows.
    expect(rawOutput({ totalFiles: 1_284, truncated: true, filenames: ["a.ts", "b.ts"] })).toEqual({
      totalFiles: 1_284,
      truncated: true,
    });
    // `truncated: false` is the default reading, so it is not shipped.
    expect(rawOutput({ totalFiles: 3, truncated: false })).toEqual({ totalFiles: 3 });
    expect(rawOutput({ totalFiles: 0 })).toEqual({ totalFiles: 0 });
  });

  it("falls through to the text when the count is not a finite number", () => {
    // NaN reaches here from a driver that divided by a missing total; treating
    // it as a count puts "NaN files" on the row.
    expect(rawOutput({ totalFiles: Number.NaN, content: "matched nothing" })).toEqual({
      content: "matched nothing",
    });
    expect(rawOutput({ totalFiles: Number.POSITIVE_INFINITY, content: "overflowed" })).toEqual({
      content: "overflowed",
    });
    expect(rawOutput({ totalFiles: "1284", content: "1284 files" })).toEqual({
      content: "1284 files",
    });
  });

  it("takes the first real line and collapses its whitespace", () => {
    expect(rawOutput({ content: "\n\n   Ran 12 tests,   0   failed  \nand more\n" })).toEqual({
      content: "Ran 12 tests, 0 failed",
    });
  });

  it("draws the truncation line at eighty-four characters", () => {
    const exactly84 = "x".repeat(84);
    expect(rawOutput({ content: exactly84 })).toEqual({ content: exactly84 });
    const over = "y".repeat(85);
    expect(rawOutput({ content: over })).toEqual({ content: `${"y".repeat(83)}…` });
    // Never longer than the limit, ellipsis included.
    expect((rawOutput({ content: over }) as { readonly content: string }).content).toHaveLength(84);
  });

  it("does not leave a dangling space before the ellipsis", () => {
    // The cut lands exactly on a space, so the summary would read "…text …"
    // with a gap before the ellipsis if the trim were dropped.
    const value = `${"a".repeat(82)} ${"z".repeat(10)}`;
    expect(rawOutput({ content: value })).toEqual({ content: `${"a".repeat(82)}…` });
  });

  it("counts the lines when the output is nothing but a fenced block", () => {
    // A code fence tells the reader nothing, so a fence-only body degrades to
    // its line count rather than rendering "```".
    expect(rawOutput({ content: "```\n```\n```" })).toEqual({ content: "3 lines" });
    // One lone fence has no count worth showing and no first line: drop it.
    expect(rawOutput({ content: "```" })).toBeUndefined();
    // A fence carrying a language is not the bare fence, so it is shown.
    expect(rawOutput({ content: "```ts\nexport const x = 1;\n```" })).toEqual({
      content: "```ts",
    });
  });

  it("reads stdout when there is no content, and neither when both are blank", () => {
    expect(rawOutput({ stdout: "  on branch main  " })).toEqual({ content: "on branch main" });
    // Content wins when both are present.
    expect(rawOutput({ content: "from content", stdout: "from stdout" })).toEqual({
      content: "from content",
    });
    expect(rawOutput({ content: "   ", stdout: "   " })).toBeUndefined();
    expect(rawOutput({})).toBeUndefined();
    expect(rawOutput("a string, not a record")).toBeUndefined();
    expect(rawOutput(null)).toBeUndefined();
  });
});

/**
 * The stale-context-window filter. Clients resolve the meter by walking the
 * activity array backwards for the first row with a usable `usedTokens`, so
 * only the last such row per turn is worth shipping — on a long thread the
 * rest is thousands of rows nobody reads.
 */
describe("dropping superseded context-window rows", () => {
  const contextWindow = (
    id: string,
    usedTokens: unknown,
    turnId: string | null = "turn-1",
  ): OrchestrationThreadActivity =>
    activity(
      { usedTokens, maxTokens: 200_000, inputTokens: 1_200 },
      {
        id: id as EventId,
        kind: "context-window.updated",
        tone: "info",
        summary: "Context window updated",
        turnId: turnId === null ? null : (turnId as TurnId),
      },
    );

  const page = (
    activities: ReadonlyArray<OrchestrationThreadActivity>,
  ): OrchestrationThreadActivitiesPage => ({ activities, hasMoreBefore: false });

  const idsOf = (result: OrchestrationThreadActivitiesPage): ReadonlyArray<string> =>
    result.activities.map((entry) => entry.id);

  it("keeps the last row of each turn and no earlier one", () => {
    const result = projectThreadActivitiesPage(
      page([
        contextWindow("cw-1", 1_000, "turn-1"),
        contextWindow("cw-2", 5_000, "turn-1"),
        activity({ itemType: "assistant_message" }, { id: "msg-1" as EventId }),
        contextWindow("cw-3", 9_000, "turn-2"),
        contextWindow("cw-4", 12_000, "turn-2"),
      ]),
    );
    // A live `thread.reverted` makes the client throw away whole turns, so the
    // retention is per turn: turn-1 must keep a resolvable row of its own.
    expect(idsOf(result)).toEqual(["cw-2", "msg-1", "cw-4"]);
    expect((result.activities[0]!.payload as { readonly usedTokens: number }).usedTokens).toBe(
      5_000,
    );
  });

  it("treats the turnless rows as their own turn", () => {
    expect(
      idsOf(
        projectThreadActivitiesPage(
          page([
            contextWindow("cw-null-1", 100, null),
            contextWindow("cw-null-2", 200, null),
            contextWindow("cw-turn", 300, "turn-1"),
          ]),
        ),
      ),
    ).toEqual(["cw-null-2", "cw-turn"]);
  });

  it("never lets a malformed row shadow the last good one", () => {
    // The trap. The client skips rows without a finite, non-negative
    // `usedTokens` on its backward walk. If the filter had counted them as the
    // turn's latest, the good row would be dropped and the meter would resolve
    // to nothing on a thread that has a perfectly good number.
    const result = projectThreadActivitiesPage(
      page([
        contextWindow("cw-good", 5_000),
        contextWindow("cw-negative", -1),
        contextWindow("cw-nan", Number.NaN),
        contextWindow("cw-infinite", Number.POSITIVE_INFINITY),
        contextWindow("cw-string", "5000"),
        contextWindow("cw-missing", undefined),
      ]),
    );
    expect(idsOf(result)).toEqual([
      "cw-good",
      "cw-negative",
      "cw-nan",
      "cw-infinite",
      "cw-string",
      "cw-missing",
    ]);
  });

  it("keeps a zero-token row, which is a real reading on a fresh turn", () => {
    expect(idsOf(projectThreadActivitiesPage(page([contextWindow("cw-zero", 0)])))).toEqual([
      "cw-zero",
    ]);
  });

  it("drops nothing when no row is resolvable", () => {
    const rows = [
      activity({ itemType: "assistant_message" }, { id: "msg-1" as EventId }),
      contextWindow("cw-bad", "nope"),
    ];
    const projected = projectThreadActivitiesPage(page(rows)).activities;
    // A thread whose only context-window rows are unreadable keeps them all —
    // filtering them out would leave the client with nothing to walk back to,
    // and each row is handed on as the very object that came in.
    expect(projected).toHaveLength(2);
    expect(projected[0]).toBe(rows[0]);
    expect(projected[1]).toBe(rows[1]);
  });

  it("applies to the snapshot path too, and trims its payloads on the way", () => {
    const snapshot = {
      snapshotSequence: 42,
      thread: {
        id: "thread-1",
        title: "Coverage gate",
        activities: [
          contextWindow("cw-1", 1_000),
          contextWindow("cw-2", 7_500),
          activity(
            {
              itemType: "command_execution",
              data: { toolName: "Bash", command: "pnpm test", result: { content: "…" } },
            },
            { id: "tool-1" as EventId },
          ),
        ],
      },
    } as unknown as OrchestrationThreadDetailSnapshot;

    const projected = projectThreadDetailSnapshot(snapshot);
    expect(projected.thread.activities.map((entry) => entry.id)).toEqual(["cw-2", "tool-1"]);
    expect((projected.thread.activities[1]!.payload as { readonly data: unknown }).data).toEqual({
      command: "pnpm test",
    });
    // The rest of the snapshot rides through untouched.
    expect(projected.snapshotSequence).toBe(42);
    expect(projected.thread.title).toBe("Coverage gate");
  });

  it("leaves an empty page alone", () => {
    expect(projectThreadActivitiesPage(page([]))).toEqual({
      activities: [],
      hasMoreBefore: false,
    });
    expect(projectThreadActivitiesPage({ activities: [], hasMoreBefore: true }).hasMoreBefore).toBe(
      true,
    );
  });
});

describe("projecting a live activity event", () => {
  it("trims the activity inside thread.activity-appended", () => {
    const event = {
      type: "thread.activity-appended",
      sequence: 91,
      payload: {
        threadId: "thread-1",
        activity: activity({
          itemType: "command_execution",
          data: { toolName: "Bash", command: "git log", result: { content: "b02594b9 …" } },
        }),
      },
    } as unknown as OrchestrationEvent;

    const projected = projectActivityEvent(event) as unknown as {
      readonly sequence: number;
      readonly payload: {
        readonly threadId: string;
        readonly activity: { readonly payload: unknown };
      };
    };
    expect((projected.payload.activity.payload as { readonly data: unknown }).data).toEqual({
      command: "git log",
    });
    // Sibling payload keys are preserved — dropping `threadId` would route the
    // frame to no thread at all.
    expect(projected.payload.threadId).toBe("thread-1");
    expect(projected.sequence).toBe(91);
  });

  it("hands back any other event by reference", () => {
    // Live context-window updates are deliberately NOT filtered here: they
    // stream through and supersede the retained rows on the client.
    for (const type of ["thread.token-usage.updated", "turn.completed", "project.created"]) {
      const event = { type, payload: { threadId: "thread-1" } } as unknown as OrchestrationEvent;
      expect(projectActivityEvent(event)).toBe(event);
    }
  });
});
