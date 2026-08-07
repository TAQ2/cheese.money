import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Domain Types

export const ProviderRewindTargetsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderRewindTargetsInput = typeof ProviderRewindTargetsInput.Type;

/**
 * A user message the live provider session can rewind tracked files to.
 * Targets are captured from the session's own stream, so they only cover
 * messages seen since the current session process started.
 */
export const ProviderRewindTarget = Schema.Struct({
  /** The provider runtime's user-message id (what the rewind control takes). */
  id: TrimmedNonEmptyString,
  createdAt: Schema.String,
  /** First line of the message, truncated, for the picker. */
  preview: Schema.String,
});
export type ProviderRewindTarget = typeof ProviderRewindTarget.Type;

export const ProviderRewindTargetsResult = Schema.Struct({
  /** Newest first. */
  targets: Schema.Array(ProviderRewindTarget),
});
export type ProviderRewindTargetsResult = typeof ProviderRewindTargetsResult.Type;

export const ProviderRewindFilesInput = Schema.Struct({
  threadId: ThreadId,
  /** A ProviderRewindTarget id. */
  userMessageId: TrimmedNonEmptyString,
  /** Preview the restore without touching files. */
  dryRun: Schema.optionalKey(Schema.Boolean),
});
export type ProviderRewindFilesInput = typeof ProviderRewindFilesInput.Type;

export const ProviderRewindFilesResult = Schema.Struct({
  canRewind: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  filesChanged: Schema.optionalKey(Schema.Array(Schema.String)),
  insertions: Schema.optionalKey(Schema.Number),
  deletions: Schema.optionalKey(Schema.Number),
});
export type ProviderRewindFilesResult = typeof ProviderRewindFilesResult.Type;

// Errors

export class ProviderRewindError extends Schema.TaggedErrorClass<ProviderRewindError>()(
  "ProviderRewindError",
  {
    /** "no-session" | "unsupported" | "failed" — drives the client's copy. */
    reason: Schema.Literals(["no-session", "unsupported", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
