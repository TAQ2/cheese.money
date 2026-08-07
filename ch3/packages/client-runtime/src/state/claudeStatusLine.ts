import { WS_METHODS } from "@ch3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * The status line is decoration, so it polls rather than streaming: the values
 * a script reports (plan usage, a PR's review state) move on the order of
 * minutes, and a push channel would cost a server-side poller per thread.
 */
const CLAUDE_STATUS_LINE_REFRESH_INTERVAL_MS = 30_000;

/**
 * Re-rendering on every keystroke would shell out constantly. A short stale
 * window collapses bursts of context-window updates into one run.
 */
const CLAUDE_STATUS_LINE_STALE_TIME_MS = 5_000;

export function createClaudeStatusLineEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    render: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:claude:status-line",
      tag: WS_METHODS.claudeStatusLineRender,
      refreshIntervalMs: CLAUDE_STATUS_LINE_REFRESH_INTERVAL_MS,
      staleTimeMs: CLAUDE_STATUS_LINE_STALE_TIME_MS,
    }),
  };
}
