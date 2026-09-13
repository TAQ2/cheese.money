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
  /**
   * The per-model weekly cap (Fable on current plans), 0–100. Absent when
   * the plan reports no per-model window.
   */
  modelWeekPercent: Schema.optionalKey(Schema.Number),
  /**
   * When this reading was actually taken, ISO. Present on every reading the
   * server serves, including one it is standing in with because the live read
   * was refused — which is the case that needs it, since a number nobody can
   * date reads as current.
   */
  readAt: Schema.optionalKey(Schema.String),
  /**
   * When the per-model window specifically was read, ISO — present only when
   * it is OLDER than `readAt`.
   *
   * There are two transports for these numbers and they carry different
   * subsets. The CLI's `rate_limit_event` stream refreshes the session and
   * week windows on the account that is busy — the one whose HTTP poll is
   * being refused — but has never carried a per-model figure. Folding that
   * window into `readAt` would age the whole reading to the last successful
   * poll and make numbers taken seconds ago read as hours old; keeping its own
   * stamp lets a row date the Fable figure honestly without lying about the
   * two beside it.
   */
  modelWeekReadAt: Schema.optionalKey(Schema.String),
  /** ISO instants, when the endpoint supplies them. */
  sessionResetsAt: Schema.optionalKey(Schema.String),
  weekResetsAt: Schema.optionalKey(Schema.String),
  modelWeekResetsAt: Schema.optionalKey(Schema.String),
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
  /**
   * ISO instant the profile DIRECTORY was created — the closest thing to
   * "when this account was added", since signing an account in is what makes
   * its directory.
   *
   * Absent for a roster slot nobody has signed into yet (no directory to
   * date), and on a filesystem that reports no birth time. Ordering must
   * therefore tolerate its absence rather than assume it.
   */
  createdAt: Schema.optionalKey(Schema.String),
  /** Account the profile is signed in as; absent when it is not signed in. */
  email: Schema.optionalKey(Schema.String),
  /**
   * The preregistered address this folder belongs to, when the SERVER says the
   * client may know it.
   *
   * The roster is advisory and the client used to resolve it itself, from a
   * copy of the roster in the bundle. That put the decision in the wrong place:
   * an account reserved for one country was still named by the client — in a
   * row's title, in "in <address>'s slot", and in the address handed to
   * "Add account…" — on machines where the server had already decided that
   * account does not exist. Absent means the client has nothing to say about
   * whose folder this is, and every label falls back to what it can see.
   */
  rosterEmail: Schema.optionalKey(Schema.String),
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
   * When the endpoint will accept a read again, ISO — the `retry-after` it
   * sent, or CH3's own back-off when it sent none. Present whenever
   * `usageRateLimited` is, so a row can say "resumes 10:33 pm" instead of
   * "retrying", which was never true inside the penalty.
   */
  usageRetryAt: Schema.optionalKey(Schema.String),
  /**
   * True when `usage` is the last good reading rather than a fresh one,
   * because the live read did not land. Still evidence, and far better than
   * the paralysis that absent usage causes — but the row says so.
   */
  usageStale: Schema.optionalKey(Schema.Boolean),
  /**
   * True when the endpoint answered 200 with a body CH3 can no longer
   * read — Anthropic moved the response shape.
   *
   * Its own flag because, collapsed into "no usage", a shape change is
   * indistinguishable from a dropped connection: the row shows the same blank,
   * the same blank clears itself on every other failure, and nobody goes and
   * looks. This one does not clear on its own and needs a code change.
   */
  usageShapeUnrecognized: Schema.optionalKey(Schema.Boolean),
  /**
   * When this account will accept another FORCED read, ISO. Present only when
   * a force was just refused for being inside its throttle window, so the
   * button can say why it is disabled instead of going quiet.
   */
  usageForceRetryAt: Schema.optionalKey(Schema.String),
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
  /**
   * With `includeUsage`, return only cached usage and make no network call, so
   * the panel paints last-known numbers instantly and refreshes them with a
   * second, un-flagged request.
   */
  cachedUsageOnly: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeAccountProfilesInput = typeof ClaudeAccountProfilesInput.Type;

export const ClaudeAccountProfilesResult = Schema.Struct({
  profiles: Schema.Array(ClaudeAccountProfile),
  /**
   * The shell-profile line that makes every terminal on this machine follow
   * the selected account, not only the ones CH3 opens.
   *
   * Sent with the profiles because it is the same question the panel answers —
   * "which account does `claude` run as" — and it is the environment's own
   * path, so only the server knows it. `null` where no shim exists: Windows,
   * or a write that failed.
   */
  terminalShimPathLine: Schema.NullOr(Schema.String),
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

/**
 * Abandon a sign-in in flight. Without this a login the user walked away from
 * holds its CLI session for the full timeout, and its cleanup can still fire
 * minutes later — so "Cancel" has to reach the server, not just the screen.
 */
export const ClaudeAccountLoginCancelInput = Schema.Struct({
  loginId: TrimmedNonEmptyString,
});
export type ClaudeAccountLoginCancelInput = typeof ClaudeAccountLoginCancelInput.Type;

export const ClaudeAccountLoginCancelResult = Schema.Struct({
  /** False when the sign-in had already finished or expired on its own. */
  cancelled: Schema.Boolean,
});
export type ClaudeAccountLoginCancelResult = typeof ClaudeAccountLoginCancelResult.Type;

/**
 * Sign one account out — clears its credential and `oauthAccount`, scoped to
 * this config directory so every other account stays signed in. Reversible:
 * the same row signs back in.
 */
/**
 * Ask the server to make the Claude Code CLI work on this machine.
 *
 * The one repair a non-technical person can make from inside the app: CH3
 * installs the CLI itself — through the package manager if there is one, and
 * through Anthropic's native installer if there is not — and answers with what
 * actually runs afterwards rather than with whether a command exited zero.
 */
export const ClaudeCliInstallInput = Schema.Struct({});
export type ClaudeCliInstallInput = typeof ClaudeCliInstallInput.Type;

export const ClaudeCliInstallResult = Schema.Struct({
  /** Whether `claude --version` runs now. The only claim worth making. */
  ok: Schema.Boolean,
  /** The binary that answered, recorded in settings so the app can find it. */
  binaryPath: Schema.NullOr(Schema.String),
  /** One sentence for the person in front of the panel. */
  detail: Schema.String,
});
export type ClaudeCliInstallResult = typeof ClaudeCliInstallResult.Type;

/**
 * Read one account's usage NOW, ignoring the freshness window and the pause
 * the endpoint asked for.
 *
 * The only way to make a stale number try again. Before this, the panel's
 * "Try again" rendered solely when the profile list had never loaded, so an
 * engineer looking at a nine-hour-old reading had no control at all — the
 * automatic loops were being refused and there was nothing else to press.
 *
 * User-initiated only, and throttled server-side to one forced read per
 * account per minute: automatic retries inside a penalty are what produced the
 * blackout, and a button that can be mashed is an automatic retry with extra
 * steps.
 */
export const ClaudeAccountUsageForceReadInput = Schema.Struct({
  /** Profile to read, by its config directory. */
  homePath: TrimmedNonEmptyString,
});
export type ClaudeAccountUsageForceReadInput = typeof ClaudeAccountUsageForceReadInput.Type;

export const ClaudeAccountUsageForceReadResult = Schema.Struct({
  /**
   * The profile after the read. Carries the outcome in its own usage flags —
   * `usageRateLimited` when the forced read was refused again (said out loud,
   * never silently), `usageForceRetryAt` when the throttle refused to make it.
   */
  profile: ClaudeAccountProfile,
});
export type ClaudeAccountUsageForceReadResult = typeof ClaudeAccountUsageForceReadResult.Type;

export const ClaudeAccountSignOutInput = Schema.Struct({
  /** Profile to sign out, by its config directory. */
  homePath: TrimmedNonEmptyString,
});
export type ClaudeAccountSignOutInput = typeof ClaudeAccountSignOutInput.Type;

export const ClaudeAccountSignOutResult = Schema.Struct({
  /** The profile after sign-out, re-probed — now reading as signed out. */
  profile: ClaudeAccountProfile,
});
export type ClaudeAccountSignOutResult = typeof ClaudeAccountSignOutResult.Type;

/**
 * Usage for the account currently in use, for the native usage band shown
 * under the composer. One read, served through the shared cache and fanned
 * out to every thread's band — the reverse of the old per-thread statusline
 * poll that hit the rate-limited endpoint once per open conversation.
 */
export const ClaudeCurrentUsageInput = Schema.Struct({
  /**
   * The Claude provider instance the caller is deciding for, when it has one.
   * A machine may run two Claude instances on two accounts; the metering rule
   * is about the account the THREAD runs on, so a caller that knows its
   * instance names it. Absent: the server answers for the default instance —
   * and, when more than one Claude instance is enabled, withholds
   * `accountEmail`, so a metering decision made blind stays metered.
   */
  providerInstanceId: Schema.optionalKey(Schema.String),
  /**
   * The account the caller believes is in use. The server ignores it — it
   * resolves the in-use account itself — but it makes a switch visible to the
   * client's query cache, so the band refetches on switch instead of showing
   * the previous account until its next poll.
   */
  accountKey: Schema.optionalKey(Schema.String),
});
export type ClaudeCurrentUsageInput = typeof ClaudeCurrentUsageInput.Type;

export const ClaudeCurrentUsageResult = Schema.Struct({
  /** Null when no account is signed in, or when it could not be read. */
  usage: Schema.NullOr(ClaudeAccountUsage),
  /** The in-use account's label, for the band's tooltip. */
  accountLabel: Schema.optionalKey(Schema.String),
  /**
   * The address the in-use profile is signed in as. The label above prefers
   * the organization name, which is the wrong key for a rule about one
   * specific account — the shared Fable account is recognised by this.
   */
  accountEmail: Schema.optionalKey(Schema.String),
  /** The read was refused with 429 — the band shows its last value, dimmed. */
  rateLimited: Schema.optionalKey(Schema.Boolean),
  /** When reads resume, ISO; present whenever `rateLimited` is. */
  retryAt: Schema.optionalKey(Schema.String),
  /** The value is a cached reading standing in for a read that did not land. */
  stale: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeCurrentUsageResult = typeof ClaudeCurrentUsageResult.Type;

// Errors

export class ClaudeAccountError extends Schema.TaggedErrorClass<ClaudeAccountError>()(
  "ClaudeAccountError",
  {
    /** "unsupported" | "failed" | "not-found" — drives the client copy. */
    /**
     * `cli-missing` is its own reason because it is the only one the app can
     * fix for the person: the Claude Code CLI is not installed or will not
     * run, and CH3 can install it with the command it already uses at
     * startup. Everything else needs a human decision.
     */
    reason: Schema.Literals(["unsupported", "failed", "not-found", "cli-missing"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Automated sign-in — desktop IPC vocabulary

/**
 * The address the next Claude sign-in window should prefill, or `null` for a
 * brand-new account — which both says "nothing to prefill" and clears an
 * address a previous, abandoned attempt left pending.
 */
export const ClaudeSignInEmailHintPayload = Schema.NullOr(Schema.String);
export type ClaudeSignInEmailHintPayload = typeof ClaudeSignInEmailHintPayload.Type;
