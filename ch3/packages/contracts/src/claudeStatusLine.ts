import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

// Domain Types

/**
 * The subset of Claude Code's status line stdin payload that CH3 can fill
 * honestly from its own state. Field names and units are Claude Code's, not
 * ours: an existing `statusLine` script must not need a CH3-specific branch.
 *
 * Deliberately absent: `rate_limits`. Only the Claude Code TUI assembles plan
 * rate-limit windows, and reproducing that would mean calling an undocumented
 * account endpoint with the user's OAuth token. Scripts that want those meters
 * fetch them themselves.
 */
export const ClaudeStatusLineContext = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  modelDisplayName: Schema.optionalKey(TrimmedNonEmptyStringSchema),
  version: Schema.optionalKey(TrimmedNonEmptyStringSchema),
  contextWindowSize: Schema.optionalKey(NonNegativeInt),
  contextRemainingPercentage: Schema.optionalKey(Schema.Number),
  effortLevel: Schema.optionalKey(TrimmedNonEmptyStringSchema),
  alwaysThinkingEnabled: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeStatusLineContext = typeof ClaudeStatusLineContext.Type;

/**
 * One rendered status line. `text` keeps the ANSI escapes the command emitted —
 * the client owns presentation, so a future surface can render them differently
 * without changing the wire format.
 */
export const ClaudeStatusLineResult = Schema.Struct({
  /** Absent when the user has no `statusLine` configured. */
  text: Schema.NullOr(Schema.String),
  /** Milliseconds the command took, for the slow-command warning. */
  durationMs: NonNegativeInt,
  /** True when the command exited non-zero or timed out; `text` is then null. */
  failed: Schema.Boolean,
});
export type ClaudeStatusLineResult = typeof ClaudeStatusLineResult.Type;

// Errors

export class ClaudeStatusLineError extends Schema.TaggedErrorClass<ClaudeStatusLineError>()(
  "ClaudeStatusLineError",
  {
    reason: Schema.Literals(["settingsUnreadable", "commandFailed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
