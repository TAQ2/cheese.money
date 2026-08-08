import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

// Domain Types

/**
 * What CH3 tells a usage-metrics command about the session it is reporting on.
 *
 * Deliberately thin. This is NOT Claude Code's `statusLine` contract and does
 * not try to be: that contract exists so an unmodified Claude script keeps
 * working, whereas nothing upstream defines a usage line for OpenCode. Fields
 * get added here when a script can actually use them, not speculatively.
 */
export const OpenCodeUsageMetricsContext = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  modelDisplayName: Schema.optionalKey(TrimmedNonEmptyStringSchema),
});
export type OpenCodeUsageMetricsContext = typeof OpenCodeUsageMetricsContext.Type;

/**
 * One rendered usage line. ANSI escapes the command emitted are kept — the
 * client owns presentation, so a future surface can render them differently
 * without a wire change.
 */
export const OpenCodeUsageMetricsResult = Schema.Struct({
  /** Absent when no command is configured, or when it printed nothing. */
  text: Schema.NullOr(Schema.String),
  /** Milliseconds the command took, for the slow-command warning. */
  durationMs: NonNegativeInt,
  /** True when the command exited non-zero or timed out; `text` is then null. */
  failed: Schema.Boolean,
});
export type OpenCodeUsageMetricsResult = typeof OpenCodeUsageMetricsResult.Type;

// Errors

export class OpenCodeUsageMetricsError extends Schema.TaggedErrorClass<OpenCodeUsageMetricsError>()(
  "OpenCodeUsageMetricsError",
  {
    reason: Schema.Literals(["commandFailed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
