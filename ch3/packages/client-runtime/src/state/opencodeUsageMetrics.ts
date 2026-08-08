import { WS_METHODS } from "@ch3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Usage metrics are decoration, so they poll rather than stream: spend against
 * a billing cycle moves on the order of minutes, and a push channel would cost
 * a server-side poller per thread.
 *
 * Slower than the Claude status line's 30s on purpose — the reference command
 * aggregates a month of OpenCode's SQLite, and nothing it reports changes
 * meaningfully inside a minute.
 */
const OPENCODE_USAGE_METRICS_REFRESH_INTERVAL_MS = 60_000;

/**
 * Re-rendering on every keystroke would shell out constantly. A short stale
 * window collapses bursts of composer updates into one run.
 */
const OPENCODE_USAGE_METRICS_STALE_TIME_MS = 10_000;

export function createOpenCodeUsageMetricsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    render: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:opencode:usage-metrics",
      tag: WS_METHODS.opencodeUsageMetricsRender,
      refreshIntervalMs: OPENCODE_USAGE_METRICS_REFRESH_INTERVAL_MS,
      staleTimeMs: OPENCODE_USAGE_METRICS_STALE_TIME_MS,
    }),
  };
}
