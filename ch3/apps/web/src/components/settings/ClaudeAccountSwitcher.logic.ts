import type { ClaudeAccountProfile } from "@ch3tools/contracts";
import {
  chooseClaudeRotationTarget,
  weeklyBurnableRate,
} from "@ch3tools/shared/claudeAccountRotation";

/**
 * The value to store in the provider instance's `homePath` setting so it uses
 * this profile.
 *
 * The default profile MUST map to an empty string, never to its absolute path.
 * CH3 only sets `CLAUDE_CONFIG_DIR` when `homePath` is non-empty, and the CLI
 * keeps its config in `~/.claude.json` — beside `~/.claude`, not inside it.
 * Writing the explicit path therefore points the CLI at a directory holding no
 * config; it creates a fresh empty one, reports the signed-in account as "Not
 * logged in", and every thread fails with "Please run /login". Switching back
 * does not repair it, because the damage is the stored setting.
 */
export function homePathSettingForProfile(profile: ClaudeAccountProfile): string {
  return profile.isDefaultHome ? "" : profile.homePath;
}

/** A profile is signed in when the CLI config recorded an account for it. */
export function isSignedInClaudeProfile(profile: ClaudeAccountProfile): boolean {
  return (profile.email ?? "").trim().length > 0;
}

/**
 * Only a signed-in profile may be switched to. Pointing an instance at an
 * unauthenticated config directory takes down every thread on it, so sign-in
 * has to come first — selecting one is not offered at all.
 */
export function isSelectableClaudeProfile(profile: ClaudeAccountProfile): boolean {
  return isSignedInClaudeProfile(profile);
}

/**
 * What a row leads with. One login can hold a personal and a work
 * organization, in which case every row shows the same email and the
 * organization is the only thing that tells them apart — so the organization
 * leads. The email carries the row only when there is no organization to name.
 */
export function claudeProfilePrimaryLabel(profile: ClaudeAccountProfile): string {
  if (!isSignedInClaudeProfile(profile)) return "Not signed in";
  return (profile.organizationName ?? "").trim().length > 0
    ? (profile.organizationName ?? "")
    : (profile.email ?? "");
}

/**
 * The supporting line: whatever the primary line did not already say. Never
 * repeats the organization, and always ends with the config directory so a
 * profile stays identifiable even when two accounts look alike.
 */
export function claudeProfileSecondaryLabel(profile: ClaudeAccountProfile): string {
  const primary = claudeProfilePrimaryLabel(profile);
  const parts = [profile.email, profile.subscriptionLabel, profile.displayPath];
  return parts
    .filter((part): part is string => (part ?? "").trim().length > 0 && part !== primary)
    .join(" · ");
}

/**
 * Plan headroom for a row, or null when usage is unknown.
 *
 * Unknown is rendered as nothing rather than as 0%, because a reader who sees
 * "0%" concludes the account is empty — the same mistake the failover rules
 * refuse to make.
 */
/**
 * The 5-hour window's reset moment, as a local wall-clock time.
 *
 * Time of day only: the window is at most five hours long, so the date is
 * never in doubt, and "resets 2:40 PM" answers the actual question — "when
 * do I get this account back?"
 */
function formatSessionReset(resetsAt: string): string | null {
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Which account the rotation rules would seat, and the sentence explaining it. */
export interface ClaudeAccountRecommendation {
  /** `homePath` of the recommended profile, for matching the row to highlight. */
  readonly homePath: string;
  readonly detail: string;
  /** True when the recommendation is the account already in use. */
  readonly isCurrent: boolean;
}

/**
 * The account the app itself would pick right now.
 *
 * Runs `chooseClaudeRotationTarget` — the SAME function the rotation reactor
 * runs, imported from `shared` rather than reimplemented — so the highlight
 * cannot claim one thing while the reactor does another. That is the entire
 * point of the button: a reimplementation that agreed today and diverged after
 * the next rule change would be worse than no button at all.
 *
 * BOTH phases are consulted, in this order, because neither alone answers the
 * question:
 *
 *   `steady` first — it is what the reactor is about to do. It owns the escape
 *   hatches, and only it notices an incumbent minutes from stalling. Observed
 *   live: the account in use sat at 91% of its 5-hour window with the most
 *   expiring weekly allowance (24%/day), so a startup-only reading said "stay
 *   here" while the reactor was two minutes from resting it. Whichever the
 *   highlight had shown, one of the two was lying.
 *
 *   `startup` as the fallback — steady returns null while the incumbent is
 *   inside its stickiness window, and reporting THAT as "already ideal" would
 *   credit the account for nothing more than a session that just opened.
 *   Startup is the seating question with stickiness removed.
 *
 * Null means the recommendation is not knowable: with no usage read for the
 * account in use there is nothing to compare against, and saying "this one" on
 * no evidence is the failure mode this whole feature exists to catch.
 */
export function recommendClaudeAccount(input: {
  readonly profiles: ReadonlyArray<ClaudeAccountProfile>;
  readonly nowMs: number;
}): ClaudeAccountRecommendation | null {
  const current = input.profiles.find((profile) => profile.isCurrent);
  if (!current?.usage) return null;

  const decision =
    chooseClaudeRotationTarget({
      profiles: input.profiles,
      nowMs: input.nowMs,
      phase: "steady",
    }) ??
    chooseClaudeRotationTarget({
      profiles: input.profiles,
      nowMs: input.nowMs,
      phase: "startup",
    });
  if (decision) {
    return { homePath: decision.to.homePath, detail: decision.reason, isCurrent: false };
  }

  // "No better account" and "no account I could read" are different answers,
  // and only one of them is a comparison. Saying the first when the second is
  // true is what this panel did while the account in use sat at 100% of its
  // 5-hour window and a sibling sat at 12%: every rival's usage read had come
  // back 429, so nothing was ever weighed, and the sentence claimed it was.
  const rivals = input.profiles.filter(
    (profile) => !profile.isCurrent && isSignedInClaudeProfile(profile),
  );
  if (rivals.length > 0 && !rivals.some((profile) => profile.usage)) {
    const rateLimited = rivals.some((profile) => profile.usageRateLimited === true);
    return {
      homePath: current.homePath,
      isCurrent: true,
      detail:
        `No other account's usage could be read${
          rateLimited ? " — the usage endpoint is rate limiting these reads" : ""
        }, so ${claudeProfilePrimaryLabel(current)} stays in use by default. ` +
        `Nothing was compared. Refresh in a few minutes, or switch by hand.`,
    };
  }

  const rate = weeklyBurnableRate({
    weekPercent: current.usage.weekPercent,
    weekResetsAt: current.usage.weekResetsAt,
    nowMs: input.nowMs,
  });
  return {
    homePath: current.homePath,
    isCurrent: true,
    detail:
      `${claudeProfilePrimaryLabel(current)} is already the account to use — ` +
      `${Math.round(rate)}% of its weekly allowance per day expires before its reset, ` +
      `and no other account beats that by enough to be worth a switch.`,
  };
}

export function claudeProfileUsageLabel(profile: ClaudeAccountProfile): string | null {
  const usage = profile.usage;
  if (!usage) {
    // The knowable failure states are worth saying out loud: without this, a
    // dead account, a rate-limited one and a merely-unread one all show
    // nothing, and the reader cannot tell why their turns are failing — or
    // why the app is refusing to switch to a row that looks perfectly fine.
    // Genuine silence (network hiccup) still shows nothing.
    if (profile.usageUnauthorized === true) return "session expired — sign in again";
    if (profile.usageCredentialMissing === true) return "sign in again to see usage";
    if (profile.usageRateLimited === true) return "usage read rate limited — retrying";
    return null;
  }
  const sessionReset = usage.sessionResetsAt ? formatSessionReset(usage.sessionResetsAt) : null;
  const session = `session ${Math.round(usage.sessionPercent)}%${
    sessionReset ? ` · resets ${sessionReset}` : ""
  }`;
  // A cached reading is still the number the rules are acting on, so it is
  // shown — labelled, never silently passed off as current.
  return `${session} · week ${Math.round(usage.weekPercent)}%${
    profile.usageStale === true ? " · cached" : ""
  }`;
}
