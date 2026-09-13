import { EnvironmentId } from "@ch3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));

const { readSpawnAgentCard, SpawnAgentCard } = await import("./SpawnAgentCard");

const baseEntry: WorkLogEntry = {
  id: "entry-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  label: "spawn_model_agent",
  tone: "tool",
  itemType: "mcp_tool_call",
};

const TOOL_NAME = "mcp__ch3__spawn_model_agent";
const input = { model: "glm-5-3-flash", prompt: "Say hello.", title: "Québécois hello" };

/**
 * The shape the Claude runtime really carries, captured from a live call:
 * flat `{ toolName, input, result }`, with `result` an MCP tool_result whose
 * `content` is the tool's JSON as a string.
 */
const claudeShaped = (resultFields: Record<string, unknown> | null): WorkLogEntry => ({
  ...baseEntry,
  toolData: {
    toolName: TOOL_NAME,
    input,
    ...(resultFields
      ? {
          result: {
            tool_use_id: "toolu_01",
            type: "tool_result",
            content: JSON.stringify(resultFields),
          },
        }
      : {}),
  },
});

const completedFields = {
  threadId: "530ad30c-646d-4af4-b2b1-e64a27ee79e8",
  model: "glm-5-3-flash",
  title: "Québécois hello",
  status: "completed",
  output: "Salut! Ça va?",
};

describe("readSpawnAgentCard", () => {
  it("reads a completed call off the Claude runtime's real shape", () => {
    expect(readSpawnAgentCard(claudeShaped(completedFields))).toEqual({
      threadId: "530ad30c-646d-4af4-b2b1-e64a27ee79e8",
      model: "glm-5-3-flash",
      title: "Québécois hello",
      status: "completed",
      output: "Salut! Ça va?",
    });
  });

  it("shows a running card from the input alone while no result has come back", () => {
    // The first lifecycle rows carry the call's name and arguments but no
    // result yet. The card must still appear, on the model, with no thread id
    // to copy or open until the child reports one.
    expect(readSpawnAgentCard(claudeShaped(null))).toEqual({
      threadId: null,
      model: "glm-5-3-flash",
      title: "Québécois hello",
      status: "running",
      output: null,
    });
  });

  it("reads a result given as MCP text blocks", () => {
    const entry: WorkLogEntry = {
      ...baseEntry,
      toolData: {
        toolName: TOOL_NAME,
        input,
        result: { content: [{ type: "text", text: JSON.stringify(completedFields) }] },
      },
    };
    expect(readSpawnAgentCard(entry)?.threadId).toBe("530ad30c-646d-4af4-b2b1-e64a27ee79e8");
  });

  it("reads a result given under structuredContent", () => {
    const entry: WorkLogEntry = {
      ...baseEntry,
      toolData: { toolName: TOOL_NAME, input, result: { structuredContent: completedFields } },
    };
    expect(readSpawnAgentCard(entry)?.status).toBe("completed");
  });

  it("reads a bare result nested under toolData.item.result", () => {
    const entry: WorkLogEntry = {
      ...baseEntry,
      toolData: {
        item: {
          toolName: TOOL_NAME,
          result: { ...completedFields, status: "error", output: null },
        },
      },
    };
    expect(readSpawnAgentCard(entry)).toMatchObject({
      threadId: "530ad30c-646d-4af4-b2b1-e64a27ee79e8",
      status: "error",
      output: null,
    });
  });

  /**
   * The name decides, not the shape of the result. A result carrying a
   * threadId, a model and a known status used to be enough on its own, so any
   * MCP server whose tool happened to answer in that shape drew a CH3
   * delegation card — with an Open button pointing at a thread id it had
   * invented.
   */
  it("returns null for another server's tool whose result looks like a spawn result", () => {
    const entry: WorkLogEntry = {
      ...baseEntry,
      toolData: {
        toolName: "mcp__somebody_else__run",
        result: { ...completedFields, status: "completed", output: "done" },
      },
    };
    expect(readSpawnAgentCard(entry)).toBeNull();
  });

  it("falls back to the model as the title when neither result nor input names one", () => {
    const entry: WorkLogEntry = {
      ...baseEntry,
      toolData: { toolName: TOOL_NAME, input: { model: "kimi-k2-6", prompt: "x" } },
    };
    expect(readSpawnAgentCard(entry)?.title).toBe("kimi-k2-6");
  });

  it("returns null for an ordinary MCP tool call, with or without a result", () => {
    const withResult: WorkLogEntry = {
      ...baseEntry,
      toolData: {
        toolName: "mcp__ch3__preview_status",
        input: {},
        result: { tool_use_id: "t", type: "tool_result", content: "attached" },
      },
    };
    const withoutResult: WorkLogEntry = {
      ...baseEntry,
      toolData: { toolName: "mcp__ch3__preview_status", input: { model: "not-a-spawn" } },
    };
    expect(readSpawnAgentCard(withResult)).toBeNull();
    expect(readSpawnAgentCard(withoutResult)).toBeNull();
  });

  it("shows an error card, with the tool's message, for a call the runtime marked failed", () => {
    // An unknown model, a caller thread gone, a dispatch the engine refused:
    // the tool returns isError and the runtime marks the item failed. That is
    // never a "Running" card that outlives the call.
    const entry: WorkLogEntry = {
      ...baseEntry,
      toolLifecycleStatus: "failed",
      toolData: {
        toolName: TOOL_NAME,
        input,
        result: {
          tool_use_id: "toolu_01",
          type: "tool_result",
          content: '"not-a-real-model" is not a Maple model. Valid ids: glm-5-3-flash, glm-5-3.',
        },
      },
    };
    expect(readSpawnAgentCard(entry)).toEqual({
      threadId: null,
      model: "glm-5-3-flash",
      title: "Québécois hello",
      status: "error",
      output: '"not-a-real-model" is not a Maple model. Valid ids: glm-5-3-flash, glm-5-3.',
    });
  });

  it("leaves a completed call with an unreadable result to the generic row", () => {
    const entry: WorkLogEntry = {
      ...baseEntry,
      toolLifecycleStatus: "completed",
      toolData: {
        toolName: TOOL_NAME,
        input,
        result: { content: "something the card cannot read" },
      },
    };
    expect(readSpawnAgentCard(entry)).toBeNull();
  });

  it("degrades a named spawn call with a malformed result to a running card, not nothing", () => {
    // A result missing threadId, model, or a recognised status is unusable,
    // but the call is still identifiably a spawn with a model in its input,
    // so it keeps its card (thread id absent) instead of falling back to the
    // bare MCP row.
    for (const malformed of [
      { model: "glm-5-3-flash", status: "completed" },
      { threadId: "t1", status: "completed" },
      { threadId: "t1", model: "glm-5-3-flash", status: "queued" },
    ]) {
      expect(readSpawnAgentCard(claudeShaped(malformed))).toEqual({
        threadId: null,
        model: "glm-5-3-flash",
        title: "Québécois hello",
        status: "running",
        output: null,
      });
    }
  });

  it("returns null for a non-mcp_tool_call entry, even with a matching shape", () => {
    expect(
      readSpawnAgentCard({ ...claudeShaped(completedFields), itemType: "command_execution" }),
    ).toBeNull();
  });
});

describe("SpawnAgentCard", () => {
  const card = {
    threadId: "child-thread-1",
    model: "glm-5-3-flash",
    title: "Summarize the README",
    status: "completed" as const,
    output: "The README documents a WebSocket server.",
  };

  it("shows the model chip, the title, and a copy control", () => {
    const html = renderToStaticMarkup(
      <SpawnAgentCard card={card} environmentId={EnvironmentId.make("env-1")} />,
    );

    expect(html).toContain('data-testid="spawn-agent-model"');
    expect(html).toContain("glm-5-3-flash");
    expect(html).toContain("Summarize the README");
    expect(html).toContain('data-testid="spawn-agent-copy-thread-id"');
    expect(html).toContain("Completed");
  });

  it("offers Open only once an environment id is available", () => {
    const withEnv = renderToStaticMarkup(
      <SpawnAgentCard card={card} environmentId={EnvironmentId.make("env-1")} />,
    );
    const withoutEnv = renderToStaticMarkup(
      <SpawnAgentCard card={card} environmentId={undefined} />,
    );

    expect(withEnv).toContain('data-testid="spawn-agent-open"');
    expect(withoutEnv).not.toContain('data-testid="spawn-agent-open"');
  });

  it("hides copy and Open while the child has no thread id yet", () => {
    const html = renderToStaticMarkup(
      <SpawnAgentCard
        card={{ ...card, threadId: null, status: "running", output: null }}
        environmentId={EnvironmentId.make("env-1")}
      />,
    );

    expect(html).toContain("Running");
    expect(html).not.toContain('data-testid="spawn-agent-copy-thread-id"');
    expect(html).not.toContain('data-testid="spawn-agent-open"');
  });

  it("offers the output toggle for an error that left a message", () => {
    const html = renderToStaticMarkup(
      <SpawnAgentCard
        card={{ ...card, threadId: null, status: "error", output: "Could not start the child." }}
        environmentId={undefined}
      />,
    );
    expect(html).toContain("Error");
    expect(html).toContain("Show output");
  });

  it("shows a Show output toggle only when there is output to show", () => {
    const withOutput = renderToStaticMarkup(
      <SpawnAgentCard card={card} environmentId={undefined} />,
    );
    const running = renderToStaticMarkup(
      <SpawnAgentCard
        card={{ ...card, status: "running", output: null }}
        environmentId={undefined}
      />,
    );

    expect(withOutput).toContain("Show output");
    expect(running).not.toContain("Show output");
  });
});
