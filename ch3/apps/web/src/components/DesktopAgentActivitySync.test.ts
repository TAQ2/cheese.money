import type { OrchestrationSession, OrchestrationThreadShell } from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadShellHoldingAgentRun } from "./DesktopAgentActivitySync";

type ShellSlice = Pick<OrchestrationThreadShell, "session" | "latestTurn" | "kanban">;

const leased = (agentWorkingUntil: string): OrchestrationThreadShell["kanban"] =>
  ({ agentWorkingUntil }) as OrchestrationThreadShell["kanban"];

const session = (status: OrchestrationSession["status"]): OrchestrationSession =>
  ({ status }) as OrchestrationSession;

const latestTurn = (state: "running" | "completed") =>
  ({ state }) as OrchestrationThreadShell["latestTurn"];

describe("isThreadShellHoldingAgentRun", () => {
  it("holds while the session runs or starts", () => {
    expect(isThreadShellHoldingAgentRun({ session: session("running"), latestTurn: null })).toBe(
      true,
    );
    expect(isThreadShellHoldingAgentRun({ session: session("starting"), latestTurn: null })).toBe(
      true,
    );
  });

  it("holds while a delegated turn keeps running with an idle session", () => {
    const shell: ShellSlice = { session: session("idle"), latestTurn: latestTurn("running") };
    expect(isThreadShellHoldingAgentRun(shell)).toBe(true);
  });

  it("holds on an agent-working lease with no session — an orchestrator run", () => {
    const until = new Date(Date.now() + 30_000).toISOString();
    expect(
      isThreadShellHoldingAgentRun({ session: null, latestTurn: null, kanban: leased(until) }),
    ).toBe(true);
    const lapsed = new Date(Date.now() - 30_000).toISOString();
    expect(
      isThreadShellHoldingAgentRun({ session: null, latestTurn: null, kanban: leased(lapsed) }),
    ).toBe(false);
  });

  it("releases once nothing runs", () => {
    expect(isThreadShellHoldingAgentRun({ session: null, latestTurn: null })).toBe(false);
    expect(
      isThreadShellHoldingAgentRun({
        session: session("idle"),
        latestTurn: latestTurn("completed"),
      }),
    ).toBe(false);
    expect(isThreadShellHoldingAgentRun({ session: session("error"), latestTurn: null })).toBe(
      false,
    );
  });
});
