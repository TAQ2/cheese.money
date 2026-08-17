/**
 * Thread-ownership tools: let an agent say it is still working.
 *
 * CH3 infers "the agent is busy" from things it can observe — a streaming
 * session, a live turn, a subprocess under a terminal it spawned. Work that is
 * deliberately detached defeats all three: `nohup ... & disown` reparents the
 * run to pid 1, tmux gives it no controlling terminal, and a queued CI job
 * never touches this machine at all. The kanban card then falls into the human
 * lane while the work is still going, which is the opposite of the truth.
 *
 * Nothing can be inferred here, so the launcher states it instead. The claim
 * is a LEASE, not a flag: the process holding it may be killed before it can
 * retract it, and an expiry heals that by itself where a boolean would strand
 * the card in the agent lane forever.
 *
 * @module threadTools
 */

import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  Crypto.Crypto,
];

/** Bounded so a caller cannot lease the lane indefinitely in one call. */
export const MAX_AGENT_WORKING_LEASE_SECONDS = 60 * 60;
export const DEFAULT_AGENT_WORKING_LEASE_SECONDS = 15 * 60;

export const ThreadAgentWorkingInput = Schema.Struct({
  /**
   * How long the claim stays good, in seconds. Refresh it while the work runs
   * rather than asking for a long one up front: a lease outliving the process
   * that set it is exactly the failure this design avoids.
   */
  ttlSeconds: Schema.optional(
    Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_AGENT_WORKING_LEASE_SECONDS),
    ),
  ),
  /** Set false the moment the work finishes, to hand the thread back. */
  working: Schema.optional(Schema.Boolean),
});
export type ThreadAgentWorkingInput = typeof ThreadAgentWorkingInput.Type;

export const ThreadAgentWorkingResult = Schema.Struct({
  threadId: Schema.String,
  /** Absolute expiry now in force, or null when the claim was released. */
  agentWorkingUntil: Schema.NullOr(Schema.String),
});
export type ThreadAgentWorkingResult = typeof ThreadAgentWorkingResult.Type;

export class ThreadAgentWorkingError extends Schema.TaggedErrorClass<ThreadAgentWorkingError>()(
  "ThreadAgentWorkingError",
  { message: Schema.String },
) {}

export const ThreadAgentWorkingTool = Tool.make("thread_agent_working", {
  description:
    "Claim or release this thread on the kanban board's agent lane. Call it with working=true (and refresh it periodically) right after launching work CH3 cannot observe — anything detached with `nohup ... & disown`, a tmux session, a remote or queued run — because such work leaves no live session, turn, or terminal subprocess for CH3 to detect, so the card would otherwise sit in the human lane as though it were waiting on a person. The claim is a lease that expires on its own, so a crashed run cannot strand the card; call with working=false as soon as the work finishes. A thread blocked on a human approval or input still surfaces to the user regardless of this claim.",
  parameters: ThreadAgentWorkingInput,
  success: ThreadAgentWorkingResult,
  failure: ThreadAgentWorkingError,
  dependencies,
})
  .annotate(Tool.Title, "Mark agent working on thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadToolkit = Toolkit.make(ThreadAgentWorkingTool);
