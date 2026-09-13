import { formatClaudeUsageReadAge } from "../../claudeUsageReadAge";
import { formatClaudeResetShort } from "../../claudeUsageReset";
import type {
  ClaudeAccountProfile,
  OrchestrationThreadShell,
  ProviderInstanceId,
} from "@ch3tools/contracts";
import { isThreadShellHoldingAgentRun } from "../DesktopAgentActivitySync";
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

/** `.claude-2`, `.claude-3`, … — the folder names this feature hands out. */
const NUMBERED_CLAUDE_FOLDER = /^\.claude-(\d+)$/;

/** Last path segment, on either separator: the server may be a Windows host. */
function folderName(absolutePath: string): string {
  const parts = absolutePath.trim().split(/[/\\]+/);
  return parts[parts.length - 1] ?? "";
}

/**
 * The folder to pre-fill when adding another account.
 *
 * The button used to offer the literal `~/.claude-2` on every press. Once a
 * second account exists, that names an occupied directory — and the server
 * creates the folder only when it is missing, reusing an existing one as-is.
 * So the sign-in runs against another account's config directory and the
 * credentials already there are replaced. The account is gone, and nothing
 * said so.
 *
 * So the suggestion counts instead: `~/.claude-<n>` for the lowest `n` from 2
 * up that no listed profile occupies. Lowest rather than highest+1 so a
 * deleted folder's number is reused instead of the names climbing forever —
 * discovery lists every `~/.claude-*` directory whether or not it has ever
 * been signed into, so a number free in this list is a directory free on disk.
 *
 * The `.claude-` prefix is deliberate and must stay: discovery recognizes a
 * folder with no credentials in it by that prefix alone, so a folder left
 * behind by an abandoned sign-in still appears as a row to retry from.
 *
 * A null list means the profiles never loaded. There is nothing to count
 * against, so this falls back to the old fixed suggestion rather than
 * inventing a number — the field stays editable either way.
 */
export function suggestClaudeAccountFolder(
  profiles: ReadonlyArray<ClaudeAccountProfile> | null,
): string {
  const taken = new Set<number>();
  for (const profile of profiles ?? []) {
    const match = NUMBERED_CLAUDE_FOLDER.exec(folderName(profile.homePath));
    if (match) taken.add(Number(match[1]));
  }
  let index = 2;
  while (taken.has(index)) index += 1;
  return `~/.claude-${index}`;
}

/** A profile is signed in when the CLI config recorded an account for it. */
export function isSignedInClaudeProfile(profile: ClaudeAccountProfile): boolean {
  return (profile.email ?? "").trim().length > 0;
}

/**
 * Only a signed-in profile may be switched to. Pointing an instance at an
 * unauthenticated config directory takes down every thread on it, so sign-in
 * has to come first — selecting one is not offered at all.
 *
 */
export function isSelectableClaudeProfile(profile: ClaudeAccountProfile): boolean {
  return isSignedInClaudeProfile(profile);
}

/**
 * The `homePath` setting to switch the provider to once this profile has just
 * signed in, or null to leave the selection where it is.
 *
 * A sign-in used to end with a toast saying "Select it to switch this
 * provider over", and people did not: the account they had just signed in to
 * escape an exhausted one sat unselected while the old one went on refusing
 * turns, and the errors read as the new account being broken. Signing an
 * account in from this panel IS the decision to use it, so the switch follows
 * the sign-in — unless it is already the account in use, or the seat may not
 * select it (the shared Fable account, before its window is spent), in which
 * case the row says so and the selection stays.
 */
/**
 * Whether this thread's live run is one an account switch on `instanceId`
 * would cut short.
 *
 * A switch rebuilds one Claude provider instance and stops the sessions
 * running on it — and only those. A thread whose session names another
 * instance keeps running through the switch, so it must not veto one. A run
 * that names no instance at all (a sub-agent delegation with the session
 * gone quiet, an orchestrator lease with no session) could be anywhere, so it
 * is counted; the cost of a wrong "wait" is a toast, the cost of a wrong "go"
 * is a reply cut off mid-sentence.
 */
export function isAgentRunBlockingSwitch(
  shell: Pick<OrchestrationThreadShell, "session" | "latestTurn" | "kanban">,
  instanceId: ProviderInstanceId,
): boolean {
  if (!isThreadShellHoldingAgentRun(shell)) return false;
  const runningOn = shell.session?.providerInstanceId;
  return runningOn === undefined || runningOn === instanceId;
}

/**
 * The toast text for a manual row click that lands mid-reply.
 *
 * The click still switches — it is an explicit action, not something to
 * silently refuse — but a switch that cuts a live reply short has to say so
 * rather than leave the interruption unexplained.
 *
 * Says "any reply this provider was running" rather than naming one, because
 * {@link isAgentRunBlockingSwitch} counts a run that names no instance at all:
 * the right answer when the question is "should this wait", and one run too
 * many to assert as a fact the person just watched happen. What the switch
 * does guarantee is the rebuild, and that it takes this provider's sessions
 * with it.
 */
export function manualClaudeSwitchStoppedRunNotice(accountLabel: string): string {
  return `The switch stopped any reply this provider was running. ${accountLabel} is now in use.`;
}

export function accountToSwitchToAfterSignIn(
  profile: ClaudeAccountProfile,
  currentHomePath: string,
  /** An agent is mid-turn somewhere in this environment: never switch under it. */
  agentRunActive = false,
): string | null {
  if (agentRunActive) return null;
  if (!isSelectableClaudeProfile(profile)) return null;
  const next = homePathSettingForProfile(profile);
  return next === currentHomePath.trim() ? null : next;
}

/**
 * What a row leads with: the account's address, and nothing else.
 *
 * It used to lead with the organization name and carry the address, the
 * subscription and the config directory underneath. Every one of those was
 * true and none of them was the answer to "which account is this" — three rows
 * reading `claudio.dos@example.com's Organization` differing only by a folder
 * suffix is a puzzle, not a list. The address is the account; the folder it
 * happens to live in is CH3's business, not the reader's.
 *
 * A folder with no identity has nothing else to be called, so it falls back to
 * its directory — the one case where the path is the only name there is.
 */
export function claudeProfilePrimaryLabel(profile: ClaudeAccountProfile): string {
  const email = (profile.email ?? "").trim();
  if (email.length > 0) return email;
  return profile.displayPath;
}

/**
 * The supporting line: signed in or not, and the plan when there is one.
 *
 * No config directory. It was here so two identical-looking accounts could be
 * told apart, which stopped being a reason once the list stopped showing the
 * same account more than once — see {@link collapseClaudeProfilesByAccount}.
 */
export function claudeProfileSecondaryLabel(profile: ClaudeAccountProfile): string {
  if (!isSignedInClaudeProfile(profile)) return "Not signed in";
  const plan = (profile.subscriptionLabel ?? "").trim();
  return plan.length > 0 ? `Signed in · ${plan}` : "Signed in";
}

/**
 * One row per account, not one row per directory.
 *
 * The shared-cookie-jar bug signed the same account into three directories, and
 * the panel dutifully showed it three times — identical rows distinguishable
 * only by a folder suffix nobody should have to reason about. The cause is
 * fixed and a duplicate can no longer be written, but the directories it
 * already made are still on disk and would be shown forever.
 *
 * So identity decides what is a row. Among directories holding the same
 * account the representative is the one in use if it is among them, then the
 * default home, then the first discovered — a stable choice, so the row does
 * not move between renders. Every duplicate's home path is kept on the row, so
 * an action taken on it can reach all of them rather than leaving siblings
 * behind to resurrect the account.
 */
export interface CollapsedClaudeAccount {
  readonly profile: ClaudeAccountProfile;
  /** Every directory holding this account, representative first. */
  readonly homePaths: ReadonlyArray<string>;
}

export function collapseClaudeProfilesByAccount(
  profiles: ReadonlyArray<ClaudeAccountProfile>,
): ReadonlyArray<CollapsedClaudeAccount> {
  const byAccount = new Map<string, ClaudeAccountProfile[]>();
  const order: string[] = [];
  for (const profile of profiles) {
    // Only signed-in profiles carry an identity to collapse ON. An empty
    // directory is its own row: two of them are two invitations, not one
    // account seen twice.
    const email = isSignedInClaudeProfile(profile)
      ? (profile.email ?? "").trim().toLowerCase()
      : "";
    const key = email.length > 0 ? `email:${email}` : `path:${profile.homePath}`;
    const held = byAccount.get(key);
    if (held === undefined) {
      byAccount.set(key, [profile]);
      order.push(key);
      continue;
    }
    held.push(profile);
  }
  return order.map((key) => {
    const held = byAccount.get(key) ?? [];
    const representative =
      held.find((profile) => profile.isCurrent) ??
      held.find((profile) => profile.isDefaultHome) ??
      held[0]!;
    return {
      profile: representative,
      homePaths: [
        representative.homePath,
        ...held.filter((profile) => profile !== representative).map((profile) => profile.homePath),
      ],
    } satisfies CollapsedClaudeAccount;
  });
}

/**
 * Where a row sits in the list.
 *
 * Chronological by the directory's creation time, because signing in is what
 * makes the directory, so that is when the account was added.
 *
 * Before this the order was whatever `fs.readDirectory` returned, which is
 * neither sorted nor stable across machines.
 */
/**
 * Drop the rows that are only a leftover directory.
 *
 * A signed-out folder is the residue of an account somebody signed out of or a
 * sign-in they abandoned, and it accumulates — the panel filled with rows
 * reading "Not signed in" against directory names, none of which anybody was
 * going to act on.
 *
 * Two exceptions, both because hiding the row would take away the only control
 * that reaches it:
 *
 *   - the profile the instance is currently pointed at, which has to stay
 *     visible whatever state it is in;
 *   - the default home, which is where a first sign-in on this machine lands.
 *
 * Filtered on the way to the screen rather than at discovery: the directory is
 * still there, the failover and rotation rules still see it, and signing into
 * it anywhere else brings the row straight back.
 */
export function isVisibleClaudeAccountRow(profile: ClaudeAccountProfile): boolean {
  if (isSignedInClaudeProfile(profile)) return true;
  return profile.isCurrent || profile.isDefaultHome;
}

export function visibleClaudeAccountRows(
  rows: ReadonlyArray<CollapsedClaudeAccount>,
): ReadonlyArray<CollapsedClaudeAccount> {
  return rows.filter((row) => isVisibleClaudeAccountRow(row.profile));
}

/** Sortable creation instant, or `null` when the row has none to sort on. */
function createdAtOrder(profile: ClaudeAccountProfile): number | null {
  const createdAt = profile.createdAt;
  if (createdAt === undefined) return null;
  const at = Date.parse(createdAt);
  return Number.isNaN(at) ? null : at;
}

/**
 * Oldest account first: signing in is what makes the directory, so the
 * creation time is when the account was added.
 *
 * A stable sort over a copy: the input order is the tie-break, so two rows
 * this rule cannot separate keep the arrangement they arrived in rather than
 * swapping places between renders.
 */
export function sortClaudeAccountRows(
  rows: ReadonlyArray<CollapsedClaudeAccount>,
): ReadonlyArray<CollapsedClaudeAccount> {
  return [...rows].sort((left, right) => {
    const leftCreated = createdAtOrder(left.profile);
    const rightCreated = createdAtOrder(right.profile);
    // A row with no creation time cannot be placed chronologically, so it
    // goes after the ones that can rather than being treated as the oldest.
    if (leftCreated === null || rightCreated === null) {
      if (leftCreated !== rightCreated) return leftCreated === null ? 1 : -1;
      return 0;
    }
    return leftCreated - rightCreated;
  });
}

/**
 * Plan headroom for a row, or null when usage is unknown.
 *
 * Unknown is rendered as nothing rather than as 0%, because a reader who sees
 * "0%" concludes the account is empty — the same mistake the failover rules
 * refuse to make.
 */
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

/**
 * Why a forced read cannot be made right now, or null when one can.
 *
 * The throttle is the server's, and it answers with the instant the next force
 * is allowed. Saying that out loud is the point: a button that goes inert
 * without explanation reads as broken, and the person pressing it is already
 * looking at a number they do not trust.
 */
export function claudeForceReadBlockedNote(
  profile: ClaudeAccountProfile,
  nowMs: number,
): string | null {
  if (profile.usageForceRetryAt === undefined) return null;
  const untilMs = Date.parse(profile.usageForceRetryAt);
  if (Number.isNaN(untilMs) || nowMs >= untilMs) return null;
  return `Just read — try again in ${Math.ceil((untilMs - nowMs) / 1000)}s`;
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
    // Said in its own words, because it is not a hiccup and waiting will not
    // fix it: the endpoint answered, and the answer no longer has the fields
    // CH3 reads. Shown as the blank every other silence shows, a shape
    // change is indistinguishable from flaky wifi and nobody investigates.
    if (profile.usageShapeUnrecognized === true) {
      return "usage unreadable — Anthropic changed the response; CH3 needs an update";
    }
    // "retrying" was never true inside the penalty; the time is what a reader
    // can act on, and it is the endpoint's own. Named as THIS account's limit:
    // the endpoint's bucket is per account, and a shared account is read by
    // every machine signed in as it.
    if (profile.usageRateLimited === true) {
      const resumes = formatClaudeResetShort(profile.usageRetryAt);
      return resumes === null
        ? "usage not read yet — the endpoint is limiting reads of this account"
        : `usage not read yet — the endpoint is limiting this account; next read ${resumes}`;
    }
    return null;
  }
  const sessionReset = formatClaudeResetShort(usage.sessionResetsAt);
  const session = `session ${Math.round(usage.sessionPercent)}%${
    sessionReset ? ` · resets ${sessionReset}` : ""
  }`;
  // The weekly window is the one that decides whether an account can carry a
  // long run, and it resets days out — so its date is the useful half of the
  // number. Showing the percentage without it left the reader unable to tell a
  // week at 97% that clears tonight from one that clears on Friday.
  const weekReset = formatClaudeResetShort(usage.weekResetsAt);
  const week = `week ${Math.round(usage.weekPercent)}%${weekReset ? ` · resets ${weekReset}` : ""}`;
  // The per-model cap is the meter that runs out FIRST on a capped plan, so it
  // belongs in the text rather than only under a bar: a tooltip is invisible
  // until hovered and unreachable from the keyboard entirely. No reset of its
  // own — it clears with the weekly window named just before it.
  // The per-model figure carries its own age when it is older than the two
  // beside it — which is the normal state on a busy account, because the CLI's
  // event stream refreshes the session and week windows and has never carried
  // a per-model one. Dating it here is what stops the row passing a
  // nine-hour-old Fable number off as being as current as the pair before it.
  const modelWeekAge = formatClaudeUsageReadAge(usage.modelWeekReadAt);
  // A cached reading is still the number the rules are acting on, so it is
  // shown — dated, never silently passed off as current. The age is what tells
  // a reader whether a rate-limited read left them looking at minutes-old
  // numbers or at yesterday's.
  const readAge =
    profile.usageStale === true ? formatClaudeUsageReadAge(profile.usage?.readAt) : null;
  // A dated number under a limit says when it will be refreshed, so the
  // reader is not left guessing whether the age will keep growing.
  const nextRead =
    profile.usageRateLimited === true ? formatClaudeResetShort(profile.usageRetryAt) : null;
  const fable =
    usage.modelWeekPercent === undefined ? null : `Fable ${Math.round(usage.modelWeekPercent)}%`;
  // Each age sits beside the numbers it dates. When the per-model figure has an
  // age of its own, the pair's age follows the week, and the per-model age —
  // together with the next poll, since the poll is what refreshes THAT number
  // — stays inside the Fable group. Two bare "(read …)" notes at the end of
  // one line read as a contradiction: "read 22m ago" and "read just now" about
  // the same account, with nothing saying which is which.
  if (fable !== null && modelWeekAge !== null) {
    const pairNote = readAge === null ? "" : ` (${readAge})`;
    const fableNotes = [modelWeekAge, ...(nextRead === null ? [] : [`next read ${nextRead}`])];
    return `${session} · ${week}${pairNote} · ${fable} (${fableNotes.join(" · ")})`;
  }
  const staleNote =
    profile.usageStale === true ? ` · ${readAge === null ? "cached" : `(${readAge})`}` : "";
  const limitNote = nextRead === null ? "" : ` · next read ${nextRead}`;
  return `${session} · ${week}${fable === null ? "" : ` · ${fable}`}${staleNote}${limitNote}`;
}

/**
 * One sentence for the whole panel while the endpoint is limiting any account,
 * or null when it is not. Said once, above the list, to name what the limit
 * is: per account, shared by every machine signed in as it — so a row that
 * says "limiting this account" is not this CH3 misbehaving, and the rows
 * around it are being read as normal.
 */
export function claudeUsagePauseNotice(
  profiles: ReadonlyArray<ClaudeAccountProfile>,
): string | null {
  const paused = profiles.filter((profile) => profile.usageRateLimited === true);
  if (paused.length === 0) return null;
  const shown = paused.some((profile) => profile.usage !== undefined)
    ? " Its numbers are the last ones read, dated."
    : "";
  const which =
    paused.length === 1
      ? `${paused[0]?.email ?? "one account"}`
      : `${paused.length} of these accounts`;
  return (
    `The usage endpoint is limiting reads of ${which}. The limit is per account and shared by ` +
    `every machine signed in as it, so it is not this CH3 asking too often; the row says when ` +
    `its next read is, and the other accounts are read as usual.${shown}`
  );
}

/**
 * Drop preregistered slots for accounts that already live somewhere else.
 *
 * The roster names the folder each CH3 account is *meant* to occupy, but a
 * machine set up before the roster existed holds them elsewhere —
 * `~/.claude-#0`, `~/.claude-uno`, a hand-named directory. Listing the roster
 * slot too would show the same person twice: once as the account they are
 * actually signed into, once as an empty invitation to sign in again.
 *
 * Identity wins over folder name. A roster slot is shown only when nothing in
 * the list already claims that address; the real account is never the row
 * that gets dropped.
 *
 * Applied on the way to the screen, never to the stored list. Who claims an
 * address changes without a re-list — a sign-out updates that folder's
 * profile in place — and a slot dropped at listing time stayed dropped: the
 * account that signed out of a hand-named folder had its own row hidden as
 * residue and its slot already gone, so "signed out" read as "deleted".
 * Over the stored list the slot is simply there again, empty, the moment
 * nobody holds its address.
 */
