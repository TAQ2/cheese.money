import type { ClaudeAccountProfile, ClaudeAccountUsage } from "@ch3tools/contracts";

/**
 * Automatic hand-over between Claude accounts.
 *
 * When the account in use runs out of plan headroom, the next turn fails. If
 * another account is signed in and has room, switching to it is exactly what
 * the user would do by hand — so do it for them.
 *
 * The decision lives here, apart from the polling and the settings write, so
 * the rules that matter can be tested directly against real usage numbers.
 *
 * @module claudeAccountFailover
 */

/** Worst of the two windows: either one exhausted blocks the next turn. */
export const worstUsagePercent = (usage: ClaudeAccountUsage): number =>
  Math.max(usage.sessionPercent, usage.weekPercent);

export interface ClaudeFailoverDecision {
  /** Value to store in the instance's `homePath` setting. */
  readonly homePath: string;
  /** The account handed over to, for the notification. */
  readonly to: ClaudeAccountProfile;
  readonly from: ClaudeAccountProfile;
  readonly reason: string;
}

/**
 * Picks an account to hand over to, or null to stay put.
 *
 * Deliberately conservative — a wrong switch is worse than a late one:
 *
 *   - Only a signed-in account is a candidate. Switching to an unauthenticated
 *     config directory takes down every thread on the instance.
 *   - A candidate must be measurably better, not merely under the threshold.
 *     Handing over to an account at 97% when the threshold is 98% buys minutes
 *     and then flaps back, so a candidate must beat the current account by
 *     `MIN_IMPROVEMENT` percentage points as well as sit below the threshold.
 *   - An account whose usage could not be read is never a candidate. Unknown
 *     is not the same as empty, and treating it as empty is how you fail over
 *     into a second exhausted account.
 *   - Ties break toward the account with the most headroom.
 */
export const MIN_IMPROVEMENT_PERCENT = 5;

export function chooseClaudeFailoverTarget(input: {
  readonly profiles: ReadonlyArray<ClaudeAccountProfile>;
  readonly thresholdPercent: number;
}): ClaudeFailoverDecision | null {
  const current = input.profiles.find((profile) => profile.isCurrent);
  // No usage for the current account means no evidence to act on. Staying put
  // is always safe; switching on a guess is not.
  if (!current?.usage) return null;

  const currentWorst = worstUsagePercent(current.usage);
  if (currentWorst < input.thresholdPercent) return null;

  const candidates = input.profiles
    .filter((profile) => !profile.isCurrent)
    .filter((profile) => (profile.email ?? "").trim().length > 0)
    .flatMap((profile) =>
      profile.usage ? [{ profile, worst: worstUsagePercent(profile.usage) }] : [],
    )
    .filter(({ worst }) => worst < input.thresholdPercent)
    .filter(({ worst }) => currentWorst - worst >= MIN_IMPROVEMENT_PERCENT)
    .sort((left, right) => left.worst - right.worst);

  const best = candidates[0];
  if (!best) return null;

  // Name the window the reported number actually came from. Picking whichever
  // window merely crossed the threshold reports "hit 98% of its 5-hour session
  // limit" when 98 is the weekly figure and the session sits at 96.
  const window =
    current.usage.sessionPercent >= current.usage.weekPercent ? "5-hour session" : "weekly";
  return {
    homePath: best.profile.isDefaultHome ? "" : best.profile.homePath,
    to: best.profile,
    from: current,
    reason: `${current.organizationName ?? current.displayPath} hit ${Math.round(currentWorst)}% of its ${window} limit`,
  };
}

/**
 * Picks an account to hand over to when the current one CANNOT AUTHENTICATE,
 * or null to stay put.
 *
 * A separate decision from the plan-limit one because the economics differ:
 * a dead account is not "94% versus 99%" — it serves nothing at all, so any
 * signed-in account with readable usage below the threshold is an
 * improvement and no minimum margin applies. The caller supplies the
 * corroborating evidence; this function only requires that the sign-in
 * failure was OBSERVED — either the usage endpoint rejecting the stored
 * token (`usageUnauthorized`), or the adapter watching a turn die with an
 * authentication error (`currentAuthFailureObserved`). It is never inferred
 * from usage merely being absent. The adapter's observation outranks a
 * healthy-looking usage number: usage is read per ACCOUNT and can be served
 * by another profile's credential, while turns run on the profile's own —
 * which is exactly the split that leaves a dead profile looking fine.
 */
export function chooseClaudeAuthFailoverTarget(input: {
  readonly profiles: ReadonlyArray<ClaudeAccountProfile>;
  readonly thresholdPercent: number;
  /** True when the adapter itself saw a turn fail to authenticate. */
  readonly currentAuthFailureObserved?: boolean;
}): ClaudeFailoverDecision | null {
  const current = input.profiles.find((profile) => profile.isCurrent);
  if (!current) return null;
  const observed =
    input.currentAuthFailureObserved === true ||
    (!current.usage && current.usageUnauthorized === true);
  if (!observed) return null;

  const candidates = input.profiles
    .filter((profile) => !profile.isCurrent)
    .filter((profile) => (profile.email ?? "").trim().length > 0)
    .flatMap((profile) =>
      profile.usage ? [{ profile, worst: worstUsagePercent(profile.usage) }] : [],
    )
    .filter(({ worst }) => worst < input.thresholdPercent)
    .sort((left, right) => left.worst - right.worst);

  const best = candidates[0];
  if (!best) return null;

  return {
    homePath: best.profile.isDefaultHome ? "" : best.profile.homePath,
    to: best.profile,
    from: current,
    reason: `${current.organizationName ?? current.displayPath} can no longer authenticate (session expired or revoked)`,
  };
}
