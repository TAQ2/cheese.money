import type { ClaudeAccountProfile } from "@ch3tools/contracts";

/**
 * The account this module would seat, and why.
 *
 * Structurally identical to the failover module's decision — the reactor
 * consumes either — but declared here so the rule can be evaluated without
 * pulling in the server.
 */
export interface ClaudeAccountSelection {
  /** Value to store in the instance's `homePath` setting. */
  readonly homePath: string;
  /** The account handed over to, for the notification. */
  readonly to: ClaudeAccountProfile;
  readonly from: ClaudeAccountProfile;
  readonly reason: string;
}

/**
 * Proactive rotation between Claude accounts.
 *
 * Lives in `shared` rather than beside the reactor that drives it because the
 * settings UI asks the SAME question the reactor does ("which account should
 * be spending right now?") for its recommendation highlight. A second
 * implementation on the client would answer it differently the first time
 * these rules changed, which would make the highlight worse than useless:
 * confidently wrong about the logic it exists to expose.
 *
 * Failover waits for an account to die; rotation asks a better question every
 * tick: WHICH account should be spending right now? The answer is the one
 * whose weekly allowance expires soonest — capacity that vanishes at the next
 * reset is capacity to use, and capacity with days of runway is capacity to
 * save. The account in use "rests" whenever a sibling is meaningfully better
 * positioned, and the person in front of the client never notices: shared
 * transcripts make the switch invisible, and it never happens mid-reply.
 *
 * @module claudeAccountRotation
 */

/**
 * The one number the whole strategy rests on: how much weekly allowance an
 * account can burn per day before its window resets — remaining percent
 * divided by days until the reset refills it.
 *
 * An account at 70% with a reset tomorrow scores 30; an account at 10% with
 * six days of runway scores 15. The first one wins: its capacity is about to
 * be handed back whether it was spent or not.
 */
export function weeklyBurnableRate(input: {
  readonly weekPercent: number;
  readonly weekResetsAt: string | undefined;
  readonly nowMs: number;
}): number {
  const remaining = Math.max(0, 100 - input.weekPercent);
  return remaining / weeklyHorizonDays(input.weekResetsAt, input.nowMs);
}

/**
 * Days until the weekly reset, clamped to sane bounds.
 *
 * The floor stops a reset moments away from dividing the score toward
 * infinity; the ceiling and the missing-timestamp default are both the full
 * window, so an account that does not say when it resets is treated as
 * having the longest possible runway — the CONSERVATIVE reading, since a
 * long horizon argues for resting the account, not spending it.
 */
const WEEK_HORIZON_FLOOR_DAYS = 1 / 24;
const WEEK_HORIZON_CEILING_DAYS = 7;

function weeklyHorizonDays(weekResetsAt: string | undefined, nowMs: number): number {
  if (!weekResetsAt) return WEEK_HORIZON_CEILING_DAYS;
  const resetMs = Date.parse(weekResetsAt);
  if (Number.isNaN(resetMs)) return WEEK_HORIZON_CEILING_DAYS;
  const days = (resetMs - nowMs) / (24 * 60 * 60 * 1000);
  return Math.min(Math.max(days, WEEK_HORIZON_FLOOR_DAYS), WEEK_HORIZON_CEILING_DAYS);
}

/**
 * Candidate eligibility: an account is only worth SEATING if it could hold
 * the seat — one already past the stickiness threshold would engage
 * re-evaluation on the very next tick, and one with a nearly-dead weekly
 * window is the failover's business, not rotation's.
 */
export const ROTATION_CANDIDATE_SESSION_LIMIT_PERCENT = 60;
export const ROTATION_WEEK_GATE_PERCENT = 97;

/**
 * The incumbent's session escape. At this much of the 5-hour window the
 * account is done serving, so the margins below are waived: ANY seatable
 * candidate beats it, whatever the weekly arithmetic says.
 *
 * 99, not a softer number, and the reasoning is the division of labour with
 * FAILOVER. Between 60% and here the margin rules already run every two
 * minutes, so a genuinely better-positioned account is picked up on its
 * merits; and above 98% the failover reactor hands over to anything with room
 * regardless of weekly arithmetic. Escaping earlier would only fire in the
 * band where the incumbent is still the best use of allowance that is about to
 * expire — abandoning it there wastes exactly what this module exists to
 * spend.
 *
 * The trade this accepts: an incumbent sitting at, say, 91% of its session
 * with no candidate that beats it on weekly rate now keeps the seat until 98%,
 * where failover takes over. It stalls later and briefly rather than switching
 * away from expiring capacity early.
 */
export const ROTATION_SESSION_ESCAPE_PERCENT = 99;

/**
 * The second engagement condition, and an escape in its own right: a weekly
 * window at 99% is spent — the account switches to the best available
 * sibling immediately, session state and margins notwithstanding. 99 rather
 * than lower on purpose: even 90% used still leaves real working capacity,
 * and rotating away from it early wastes exactly the expiring allowance
 * this module exists to spend.
 */
export const ROTATION_WEEK_ENGAGE_PERCENT = 99;

/**
 * Hysteresis. A switch costs a provider-instance rebuild, so the challenger
 * must beat the incumbent by BOTH a factor and an absolute gap — the factor
 * keeps small scores from flapping on noise, the gap keeps large scores from
 * flapping on rounding. After a switch the winner becomes the incumbent and
 * the same margins now defend it, which is what makes the loop stable.
 */
export const ROTATION_IMPROVEMENT_FACTOR = 1.25;
export const ROTATION_MIN_GAIN_PER_DAY = 5;

/**
 * Stickiness. Once an account is chosen it KEEPS the seat until it has spent
 * this much of its 5-hour window — constant re-optimisation buys little and
 * costs an instance rebuild per switch, so the steady loop stays asleep
 * while the incumbent still has a fresh session. Startup is the exception:
 * the first pick of the day should be the best-positioned account, not
 * whichever one was left in the chair.
 */
export const ROTATION_ENGAGE_SESSION_PERCENT = 60;

/**
 * Startup's own modest margin. The one-time seating needs no flap
 * protection within a process, but processes RESTART — and two accounts on
 * the same plan hover within noise of each other, which without this gap
 * would alternate the seat (and pay an instance rebuild) on every launch.
 */
export const STARTUP_MIN_GAIN_PER_DAY = 2;

export type RotationPhase = "startup" | "steady";

/**
 * Whether the steady loop should evaluate at all — exported so the reactor
 * can ask this with ONE cheap probe of the incumbent before spending a
 * usage call on every other account in the fleet.
 */
export function rotationEngaged(usage: {
  readonly sessionPercent: number;
  readonly weekPercent: number;
}): boolean {
  return (
    usage.sessionPercent >= ROTATION_ENGAGE_SESSION_PERCENT ||
    usage.weekPercent >= ROTATION_WEEK_ENGAGE_PERCENT
  );
}

interface ScoredProfile {
  readonly profile: ClaudeAccountProfile;
  readonly rate: number;
  readonly sessionPercent: number;
}

function scoreEligible(profile: ClaudeAccountProfile, nowMs: number): ScoredProfile | null {
  if ((profile.email ?? "").trim().length === 0) return null;
  const usage = profile.usage;
  if (!usage) return null;
  if (usage.sessionPercent >= ROTATION_CANDIDATE_SESSION_LIMIT_PERCENT) return null;
  if (usage.weekPercent >= ROTATION_WEEK_GATE_PERCENT) return null;
  return {
    profile,
    rate: weeklyBurnableRate({
      weekPercent: usage.weekPercent,
      weekResetsAt: usage.weekResetsAt,
      nowMs,
    }),
    sessionPercent: usage.sessionPercent,
  };
}

/**
 * Picks the account that should be spending, or null to stay put.
 *
 * Null is the common answer and always safe: unknown usage, no better
 * candidate, a margin not met, or an incumbent still inside its stickiness
 * window all mean the current account keeps working. The current account
 * failing its own gates does NOT force a switch here — that is exhaustion,
 * and the failover path owns it with its own rules.
 *
 * The two phases differ in exactly two ways. "steady" respects stickiness
 * (no evaluation until the incumbent has spent 60% of its session) and
 * demands the full hysteresis margins. "startup" is the one-time seating of
 * the best account: no stickiness — the incumbent was not chosen, merely
 * inherited — and any strict improvement is enough.
 */
export function chooseClaudeRotationTarget(input: {
  readonly profiles: ReadonlyArray<ClaudeAccountProfile>;
  readonly nowMs: number;
  readonly phase?: RotationPhase;
}): ClaudeAccountSelection | null {
  const phase = input.phase ?? "steady";
  const current = input.profiles.find((profile) => profile.isCurrent);
  if (!current?.usage) return null;

  if (phase === "steady" && !rotationEngaged(current.usage)) {
    return null;
  }

  const candidates = input.profiles
    .filter((profile) => !profile.isCurrent)
    // Two directories signed into the same account and organization share
    // one quota — "switching" between them is pure churn, never a gain.
    .filter(
      (profile) =>
        profile.email !== current.email || profile.organizationName !== current.organizationName,
    )
    .flatMap((profile) => {
      const scored = scoreEligible(profile, input.nowMs);
      return scored ? [scored] : [];
    })
    // Highest burnable rate first; an open session window breaks ties.
    .sort((left, right) => right.rate - left.rate || left.sessionPercent - right.sessionPercent);

  const best = candidates[0];
  if (!best) return null;

  const currentRate = weeklyBurnableRate({
    weekPercent: current.usage.weekPercent,
    weekResetsAt: current.usage.weekResetsAt,
    nowMs: input.nowMs,
  });
  if (phase === "steady") {
    // An incumbent minutes from stalling waives the margins: any seatable
    // candidate beats an account about to refuse turns. The weekly escape
    // shares the engagement threshold — at 99% the two are the same event.
    const escaping =
      current.usage.sessionPercent >= ROTATION_SESSION_ESCAPE_PERCENT ||
      current.usage.weekPercent >= ROTATION_WEEK_ENGAGE_PERCENT;
    if (!escaping) {
      if (best.rate < currentRate * ROTATION_IMPROVEMENT_FACTOR) return null;
      if (best.rate - currentRate < ROTATION_MIN_GAIN_PER_DAY) return null;
    }
  } else if (best.rate - currentRate < STARTUP_MIN_GAIN_PER_DAY) {
    return null;
  }

  return {
    homePath: best.profile.isDefaultHome ? "" : best.profile.homePath,
    to: best.profile,
    from: current,
    reason:
      phase === "startup"
        ? `starting on ${best.profile.organizationName ?? best.profile.displayPath} — best ` +
          `positioned to spend (${Math.round(best.rate)}%/day vs ${Math.round(currentRate)}%/day)`
        : `${best.profile.organizationName ?? best.profile.displayPath} has more weekly allowance ` +
          `expiring before its reset (${Math.round(best.rate)}%/day vs ${Math.round(currentRate)}%/day)` +
          ` — resting ${current.organizationName ?? current.displayPath}`,
  };
}
