/**
 * Delegate a task to a Maple-model child agent.
 *
 * `spawn_model_agent` is the one tool that lets a running agent hand a task
 * to a *different* model without leaving CH3's orchestration path: it
 * mints a brand-new thread on the caller's project, starts it on the OpenCode
 * driver against a chosen Maple model, and waits (bounded) for that turn to
 * settle before handing back the child's own final answer. The child thread
 * is not a sub-process or a throwaway context window — it is a normal,
 * independent, resumable CH3 thread from the moment it is created, so a
 * person can open it, read the transcript, or keep talking to it after this
 * call returns.
 *
 * This is deliberately narrow. It is not "ask another model for a second
 * opinion inline" (that is a text-generation concern, not a thread) and it is
 * not a general subagent-orchestration primitive — it exists because a user
 * asking for a named Maple model by name is asking for a real, addressable
 * thread on that model, not for the calling agent to silently reason with it
 * and paraphrase the result.
 *
 * @module agentTools
 */

import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CH3CODE_MCP_TOOL_TIMEOUT_MS } from "../../McpProviderSession.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  Crypto.Crypto,
];

/** Bounds on how long the tool call itself may block waiting on the child. */
export const MIN_WAIT_SECONDS = 1;
export const DEFAULT_WAIT_SECONDS = 240;
/**
 * Room left under the CLI's clock for the handler itself: creating the child
 * thread, starting its turn, and writing the answer back after the wait ends.
 */
const HANDLER_OVERHEAD_SECONDS = 30;
/**
 * Under the Claude CLI's per-call MCP wall clock, and derived from it so the
 * two cannot drift apart.
 *
 * The CLI aborts a tool call that outlives that clock, and an aborted call
 * returns nothing — not even the child thread id the caller needs to open or
 * resume the child. So a wait longer than the clock can only lose the answer;
 * anything slower is reported as "running" with the id, which the caller can
 * come back to.
 *
 * The clock is **60 000 ms by default**, which is what this constant used to
 * be wrong about: it assumed 300 000. Read from the 2.1.263 binary, the
 * resolver is `(config.timeout >= 1000 ? config.timeout : undefined) ??
 * MCP_TOOL_TIMEOUT`, clamped by `Math.min(Math.max(value, 60_000),
 * 2_147_483_647)` and defaulting to 60 000 — so 60 000 is both the default and
 * the floor, and a per-server `timeout` beats the environment variable.
 * CH3 sets that per-server value for its own MCP server, which is why the
 * budget here is `CH3CODE_MCP_TOOL_TIMEOUT_MS` and not one minute.
 */
export const MAX_WAIT_SECONDS = CH3CODE_MCP_TOOL_TIMEOUT_MS / 1000 - HANDLER_OVERHEAD_SECONDS;

export const SpawnModelAgentInput = Schema.Struct({
  /**
   * A Maple model id from the catalogue in `@ch3tools/shared/mapleModels`, e.g.
   * "glm-5-3-flash" or "kimi-k2-6". Either the bare id or the "maple/"-
   * prefixed slug is accepted.
   */
  model: Schema.String,
  /** The task for the child agent's first (and only) awaited turn. */
  prompt: Schema.String,
  /** Thread title. Defaults to a title derived from the model name. */
  title: Schema.optional(Schema.String),
  /**
   * How long to wait for the child's turn to finish before giving up and
   * returning `status: "running"`. The child keeps running either way — this
   * only bounds how long the calling turn blocks. Defaults to
   * `DEFAULT_WAIT_SECONDS`, capped at `MAX_WAIT_SECONDS`.
   */
  waitSeconds: Schema.optional(
    Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(MIN_WAIT_SECONDS),
      Schema.isLessThanOrEqualTo(MAX_WAIT_SECONDS),
    ),
  ),
});
export type SpawnModelAgentInput = typeof SpawnModelAgentInput.Type;

export const SpawnModelAgentResult = Schema.Struct({
  /** The new child thread's id. Resumable like any other CH3 thread. */
  threadId: Schema.String,
  /** The bare Maple model id the child thread ran on. */
  model: Schema.String,
  title: Schema.String,
  /**
   * "completed" — the turn ended normally within the wait window; `output` is
   * its final assistant text, or null if it wrote none.
   * "running" — still going when the wait window elapsed; `output` is null,
   * the thread id is still valid and can be opened or resumed.
   * "error" — the turn ended in an error, interrupt or stop; `output` is
   * whatever assistant text it left, or null.
   */
  status: Schema.Literals(["completed", "running", "error"]),
  /** The child's final assistant text, or null when not yet available. */
  output: Schema.NullOr(Schema.String),
});
export type SpawnModelAgentResult = typeof SpawnModelAgentResult.Type;

export class SpawnModelAgentError extends Schema.TaggedErrorClass<SpawnModelAgentError>()(
  "SpawnModelAgentError",
  { message: Schema.String },
) {}

export const SpawnModelAgentTool = Tool.make("spawn_model_agent", {
  description:
    "Delegate a task to a NEW child agent thread running a specific Maple model. Use this ONLY " +
    "when the user explicitly asks to create or spawn an agent on a specific named model (for " +
    "example: 'create a GLM 5.3 Flash agent to do X', 'spawn a Kimi K3 agent for Y'). Do not use " +
    "it as a general-purpose way to consult another model — it is for the narrow case where the " +
    "user names a model and wants a real agent thread on it. It creates an independent, resumable " +
    "CH3 thread in the caller's project, starts one turn on it with the given prompt, waits " +
    `(bounded, ${DEFAULT_WAIT_SECONDS}s by default) for that turn to finish, and returns the ` +
    "child thread's id plus its final assistant text. The thread id is resumable in CH3: a " +
    "person (or another tool call) can open it and keep talking to it. If the wait window elapses " +
    'first, the child keeps running and the tool reports status "running" with a null output — ' +
    "the thread id is still valid to open later.",
  parameters: SpawnModelAgentInput,
  success: SpawnModelAgentResult,
  failure: SpawnModelAgentError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn a model agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  // Calling it twice creates two child threads, never reuses one.
  .annotate(Tool.Idempotent, false);

export const AgentToolkit = Toolkit.make(SpawnModelAgentTool);
