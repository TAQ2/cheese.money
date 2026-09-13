import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@ch3tools/contracts";

/**
 * The per-call wall clock CH3 asks the Claude CLI to give its own MCP
 * server, in milliseconds.
 *
 * The CLI's default is 60 000 ms, not the 300 000 ms this repo assumed — read
 * from the 2.1.263 binary, where the resolver is
 * `(config.timeout >= 1000 ? config.timeout : undefined) ?? MCP_TOOL_TIMEOUT`,
 * then `Math.min(Math.max(value, 60_000), 2_147_483_647)`, falling back to
 * 60 000 when neither is set. So 60 000 is both the default and the floor, and
 * a per-server `timeout` on the MCP config wins over the environment variable.
 * It is a hard limit: progress notifications do not extend it, and a call that
 * outlives it returns nothing at all to the caller.
 *
 * 60 s is too short for a tool that waits by design. `preview_wait_for` takes
 * the deadline it should wait to as an argument, so an agent can legitimately
 * ask for longer than a minute — and a call that outruns the CLI's clock
 * returns nothing at all, which reads to the agent as a broken tool rather
 * than a slow page. This raises the clock for CH3's server only. The cost is
 * that a CH3 MCP tool that wedges holds the calling turn for half an hour
 * rather than one minute — acceptable, because the rest of them are in-process
 * and answer at once.
 *
 * The same field carries the CLI's silent-run allowance, which is what makes
 * thirty minutes real rather than nominal. From the binary's own help: a
 * per-server "timeout" (ms) is what you set "to allow longer silent runs for
 * just this server; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms)
 * globally". The 1_800_000 that also appears in the binary is that idle
 * timeout's stdio default, not a ceiling on this path — this one clamps at
 * 2_147_483_647.
 */
export const CH3CODE_MCP_TOOL_TIMEOUT_MS = 1_800_000;

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
