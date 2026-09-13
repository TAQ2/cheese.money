import type { OrchestrationThreadShell } from "@ch3tools/contracts";
import { useEffect, useMemo } from "react";

import { useThreadShells } from "../state/entities";
import { isAgentWorkingLeaseActive } from "./Sidebar.logic";

/**
 * A run that should hold the machine awake. Session `running`/`starting`
 * covers the provider actively working — including approval and input waits,
 * where sleeping would also cut off the remote client that could answer.
 * `latestTurn.state === "running"` covers sub-agent delegation, where the
 * session stops reporting itself as running while work continues (see
 * `resolveSidebarV2Status`). The agent-working lease covers an orchestrator
 * run and detached work, which have no session at all.
 */
export function isThreadShellHoldingAgentRun(
  thread: Pick<OrchestrationThreadShell, "session" | "latestTurn" | "kanban">,
): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    isAgentWorkingLeaseActive(thread)
  );
}

/**
 * Tells the desktop shell whether any agent run is live, so it holds a
 * power-save blocker for the duration (F13 in the stability audit: the Mac
 * used to sleep mid-run). Renders nothing; sends only on transitions; a
 * browser or an older shell without the bridge method is a no-op.
 */
export function DesktopAgentActivitySync() {
  const threadShells = useThreadShells();
  const agentRunActive = useMemo(
    () => threadShells.some(isThreadShellHoldingAgentRun),
    [threadShells],
  );

  useEffect(() => {
    const setAgentActivity = window.desktopBridge?.setAgentActivity;
    if (setAgentActivity === undefined) {
      return;
    }
    const report = (active: boolean) =>
      setAgentActivity({ active }).catch(() => {
        // The shell owns the blocker; a failed report self-heals on the next
        // transition and is not worth surfacing to the user.
      });
    void report(agentRunActive);
    // A renderer that reloads or navigates away mid-run can never send the
    // `false` that releases the blocker, so the Mac stayed awake for the rest
    // of the process. Release on the way out. A window that is DESTROYED
    // gives no effect a chance to run; the shell's own layer finalizer covers
    // that at quit, and a closed-then-reopened window re-reports on mount.
    return () => {
      if (agentRunActive) void report(false);
    };
  }, [agentRunActive]);

  return null;
}
