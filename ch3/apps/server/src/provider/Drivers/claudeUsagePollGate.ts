/**
 * When the background loops may spend a usage read.
 *
 * The usage endpoint rate limits, and the penalty is shared: one storm of
 * reads earns a `retry-after` that blinds every account behind the same quota.
 * A machine nobody is using still paid for a read per account per minute,
 * forever, to answer a question nobody was asking.
 *
 * So the loops go quiet after `USAGE_IDLE_SUSPEND_MS` without activity, and
 * wake on the first sign of it. Two things count as activity, because two
 * things depend on the answer:
 *
 *   - Somebody watching. A foreground client lease means a panel or a band is
 *     on screen and its numbers are being read.
 *   - A turn running. An unattended run still needs automatic hand-over when
 *     its account hits the cap, and nobody is there to wake the loop by
 *     clicking. Silence here would mean an overnight run stalls at 100% with
 *     a sibling account sitting idle at 12%.
 *
 * @module provider/Drivers/claudeUsagePollGate
 */

/** How long CH3 must be untouched, with nothing running, before reads stop. */
export const USAGE_IDLE_SUSPEND_MS = 8 * 60_000;

export interface ClaudeUsagePollActivity {
  /** A client is on screen and interacting right now. */
  readonly clientActive: boolean;
  /** A turn started or ran inside the idle window. */
  readonly turnActive: boolean;
  /** When activity was last observed, or null when none has been since boot. */
  readonly lastActivityMs: number | null;
  readonly nowMs: number;
}

export interface ClaudeUsagePollVerdict {
  readonly poll: boolean;
  /** How long the machine has been quiet, for the log line that says why. */
  readonly idleForMs: number;
}

/**
 * Whether this tick may read usage.
 *
 * Live activity answers yes without consulting the clock. Otherwise the last
 * observed activity decides, and a gate that has never seen any (a server that
 * just booted with no client attached) polls until the window elapses rather
 * than starting suspended — booting is itself a sign somebody is about to
 * arrive, and starting silent would leave the first band on screen with
 * nothing to show.
 */
export function resolveClaudeUsagePoll(
  activity: ClaudeUsagePollActivity,
  idleSuspendMs: number = USAGE_IDLE_SUSPEND_MS,
): ClaudeUsagePollVerdict {
  if (activity.clientActive || activity.turnActive) return { poll: true, idleForMs: 0 };
  if (activity.lastActivityMs === null) return { poll: true, idleForMs: 0 };
  const idleForMs = Math.max(0, activity.nowMs - activity.lastActivityMs);
  return { poll: idleForMs < idleSuspendMs, idleForMs };
}

/**
 * Last instant activity was observed, shared by both loops. Module state for
 * the same reason the usage cache is: the two loops are separate fibers asking
 * one question about one machine, and a second copy of the answer is how they
 * would disagree about whether the machine is awake.
 */
let lastActivityMs: number | null = null;

export const noteClaudeUsagePollActivity = (nowMs: number): void => {
  lastActivityMs = nowMs;
};

export const readLastClaudeUsagePollActivityMs = (): number | null => lastActivityMs;

/** Test seam. Production never forgets activity; it only ages out of the window. */
export const resetClaudeUsagePollActivity = (): void => {
  lastActivityMs = null;
};
