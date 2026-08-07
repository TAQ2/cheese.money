import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// Domain Types

/**
 * Resolving an external Claude Code session id (a `claude --resume` id) to
 * the repository it was recorded in, by reading the CLI's own transcript
 * store (`<claude home>/projects/<cwd-slug>/<session-id>.jsonl`). Pure
 * local file reads — no model request, no token cost.
 */
export const ClaudeExternalSessionInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type ClaudeExternalSessionInput = typeof ClaudeExternalSessionInput.Type;

export const ClaudeExternalSessionResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  /** Working directory the session was recorded in. */
  cwd: TrimmedNonEmptyString,
  /** Transcript path the cwd was read from, for diagnostics. */
  transcriptPath: TrimmedNonEmptyString,
});
export type ClaudeExternalSessionResult = typeof ClaudeExternalSessionResult.Type;

/**
 * Binds an existing CH3 thread to an external Claude session id, so the
 * thread's first turn starts the provider with `resume: <sessionId>` and
 * continues that conversation natively.
 */
export const ThreadsAdoptClaudeSessionInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  /**
   * The thread's provider instance. The session-start fallback only reads a
   * persisted cursor whose binding matches the thread's resolved instance,
   * so adopting under the wrong instance id silently loses the resume.
   */
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export type ThreadsAdoptClaudeSessionInput = typeof ThreadsAdoptClaudeSessionInput.Type;

/**
 * Rewinds a thread to an earlier input: drops that message and everything
 * after it, and repositions the provider conversation so the next turn
 * resumes with the prior history intact.
 */
export const ThreadsRewindToInputInput = Schema.Struct({
  threadId: ThreadId,
  /** The user message to rewind to (it and everything after are dropped). */
  fromMessageId: TrimmedNonEmptyString,
  /**
   * How many user messages sit after this one in the thread. Positional —
   * repeated identical prompts ("hey wait" twice) make text matching wrong.
   */
  userMessagesAfter: Schema.Int,
});
export type ThreadsRewindToInputInput = typeof ThreadsRewindToInputInput.Type;

export const ThreadsRewindToInputResult = Schema.Struct({
  /** True when the provider conversation was repositioned to that point. */
  conversationRepositioned: Schema.Boolean,
  detail: Schema.String,
});
export type ThreadsRewindToInputResult = typeof ThreadsRewindToInputResult.Type;

// Errors

export class ClaudeExternalSessionError extends Schema.TaggedErrorClass<ClaudeExternalSessionError>()(
  "ClaudeExternalSessionError",
  {
    /** "not-found" | "unreadable" | "invalid" | "failed" — drives client copy. */
    reason: Schema.Literals(["not-found", "unreadable", "invalid", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
