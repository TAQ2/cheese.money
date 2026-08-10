import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Domain Types

/**
 * Plan usage for one account, as the CLI's own `/usage` reports it: the
 * rolling 5-hour session window and the 7-day window, each 0–100.
 */
export const ClaudeAccountUsage = Schema.Struct({
  sessionPercent: Schema.Number,
  weekPercent: Schema.Number,
  /** ISO instants, when the endpoint supplies them. */
  sessionResetsAt: Schema.optionalKey(Schema.String),
  weekResetsAt: Schema.optionalKey(Schema.String),
});
export type ClaudeAccountUsage = typeof ClaudeAccountUsage.Type;

/**
 * A Claude account profile: one `CLAUDE_CONFIG_DIR` holding its own OAuth
 * credentials, settings and transcripts. Switching accounts means pointing a
 * provider instance at a different profile — no sign-out, both stay signed
 * in, and switching back is instant.
 */
export const ClaudeAccountProfile = Schema.Struct({
  /** Absolute config directory for this profile. */
  homePath: TrimmedNonEmptyString,
  /** `~`-relative form for display. */
  displayPath: TrimmedNonEmptyString,
  /** Account the profile is signed in as; absent when it is not signed in. */
  email: Schema.optionalKey(Schema.String),
  /**
   * Organization the profile is signed into. One login can hold a personal and
   * a work organization with different plans and separate limits, in which
   * case the email is identical on every row and this is the only thing that
   * distinguishes them.
   */
  organizationName: Schema.optionalKey(Schema.String),
  /** e.g. "Claude Max Subscription"; absent when not signed in. */
  subscriptionLabel: Schema.optionalKey(Schema.String),
  /** True for the profile the asking provider instance currently uses. */
  isCurrent: Schema.Boolean,
  /**
   * True for the CLI's own default config directory. Selecting this profile
   * must store an EMPTY `homePath`, never its absolute path: an explicit
   * `CLAUDE_CONFIG_DIR` pointing at the default directory makes the CLI look
   * for its config inside it rather than beside it, find none, and report the
   * signed-in account as "Not logged in".
   */
  isDefaultHome: Schema.Boolean,
  /** Absent when the account is signed out or its usage could not be read. */
  usage: Schema.optionalKey(ClaudeAccountUsage),
  /**
   * True when the usage endpoint explicitly REJECTED the account's stored
   * token (401/403) — a sign-in problem, as opposed to usage being missing
   * for network or parsing reasons. The automatic hand-over treats this,
   * corroborated by failing turns, as reason to switch away.
   */
  usageUnauthorized: Schema.optionalKey(Schema.Boolean),
  /**
   * True when the profile LOOKS signed in (its identity file names an
   * account) but no stored credential could be found to ask for usage —
   * a re-login landed elsewhere, or the credential was removed. Distinct
   * from silence so the row can say "sign in again" instead of nothing.
   */
  usageCredentialMissing: Schema.optionalKey(Schema.Boolean),
  /**
   * True when the usage endpoint answered 429. The read failed for a reason
   * that says NOTHING about the account's headroom, so a reader — human or
   * rule — must not conclude "no room here" or "nothing to compare against".
   */
  usageRateLimited: Schema.optionalKey(Schema.Boolean),
  /**
   * True when `usage` is the last good reading rather than a fresh one,
   * because the live read did not land. Still evidence, and far better than
   * the paralysis that absent usage causes — but the row says so.
   */
  usageStale: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeAccountProfile = typeof ClaudeAccountProfile.Type;

export const ClaudeAccountProfilesInput = Schema.Struct({
  /** The instance's configured home path (empty means the default home). */
  currentHomePath: Schema.String,
  /**
   * Fetch plan usage per account. Costs one HTTPS call per signed-in account,
   * so it is opt-in rather than part of every listing.
   */
  includeUsage: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeAccountProfilesInput = typeof ClaudeAccountProfilesInput.Type;

export const ClaudeAccountProfilesResult = Schema.Struct({
  profiles: Schema.Array(ClaudeAccountProfile),
});
export type ClaudeAccountProfilesResult = typeof ClaudeAccountProfilesResult.Type;

/**
 * Starts the Claude sign-in flow for one profile, over the CLI's local
 * control channel. Returns the URL to open in a browser; the flow completes
 * out of band and is awaited separately.
 */
export const ClaudeAccountLoginStartInput = Schema.Struct({
  /** Profile to sign into; created when missing. */
  homePath: TrimmedNonEmptyString,
});
export type ClaudeAccountLoginStartInput = typeof ClaudeAccountLoginStartInput.Type;

export const ClaudeAccountLoginStartResult = Schema.Struct({
  /** Handle for awaiting or cancelling this login. */
  loginId: TrimmedNonEmptyString,
  /** Open this in a browser to authorize. Absent if the CLI opened it itself. */
  url: Schema.optionalKey(Schema.String),
});
export type ClaudeAccountLoginStartResult = typeof ClaudeAccountLoginStartResult.Type;

export const ClaudeAccountLoginAwaitInput = Schema.Struct({
  loginId: TrimmedNonEmptyString,
});
export type ClaudeAccountLoginAwaitInput = typeof ClaudeAccountLoginAwaitInput.Type;

export const ClaudeAccountLoginAwaitResult = Schema.Struct({
  /** The profile after sign-in, re-probed. */
  profile: ClaudeAccountProfile,
});
export type ClaudeAccountLoginAwaitResult = typeof ClaudeAccountLoginAwaitResult.Type;

// Errors

export class ClaudeAccountError extends Schema.TaggedErrorClass<ClaudeAccountError>()(
  "ClaudeAccountError",
  {
    /** "unsupported" | "failed" | "not-found" — drives the client copy. */
    reason: Schema.Literals(["unsupported", "failed", "not-found"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
