/**
 * Keep-warm riddle: prompt, reply parsing, and whose turn it is.
 *
 * An account that is signed in but not selected sees no traffic at all, so its
 * rolling session window never turns over and nothing exercises its stored
 * credential until the moment failover tries to hand real work to it — which
 * is the worst possible moment to discover it needs signing in again. The
 * keep-warm loop asks one such account for a short riddle every 25 minutes,
 * rotating through them.
 *
 * A riddle rather than a ping because there is no ping: the only way to make
 * the CLI transact against an account is to ask it something. Making it
 * something small, deterministic in shape and self-evidently disposable keeps
 * the cost negligible and the stored row readable.
 *
 * Everything here is pure so the rotation is testable without spawning a
 * process, mirroring `claudeAccountFailover.ts` and `claudeAccountRotation.ts`.
 *
 * @module provider/Drivers/claudeAccountRiddle
 */
import type { ClaudeAccountProfile } from "@ch3tools/contracts";

/**
 * Haiku 4.5: the cheapest model on the plan. The loop's purpose is traffic,
 * not output, so anything dearer is waste — and the point of keeping an
 * account's window warm is defeated if warming it is what exhausts it.
 */
export const RIDDLE_MODEL = "claude-haiku-4-5";

/** One firing every 25 minutes, moving to the next account each time. */
export const RIDDLE_INTERVAL_MS = 25 * 60 * 1000;

/**
 * A run that has not answered in two minutes is not going to. The loop must
 * never accumulate stuck subprocesses; the next tick will pick the account up
 * again anyway.
 */
export const RIDDLE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The exact two-line shape is what makes the reply parseable. "Invent
 * something fresh" is not decoration: a well-known riddle is likely to be
 * answered from the model's own memory of it, and a reply that never reaches
 * for anything is a weaker exercise of the account.
 */
export const RIDDLE_PROMPT = `Give me one fun, original riddle with its answer. Invent something fresh, not a well-known classic riddle. Format exactly as:
Riddle: <riddle text>
Answer: <answer text>
Nothing else in your reply.`;

export interface ParsedRiddle {
  readonly riddle: string;
  readonly answer: string;
}

/**
 * Pull the riddle and its answer out of a reply.
 *
 * Returns null rather than guessing when either label is missing. The raw
 * reply is stored regardless, so a null here loses nothing — whereas half-
 * parsed rows would quietly poison the log the loop exists to produce.
 */
export function parseRiddleReply(raw: string): ParsedRiddle | null {
  const riddleMatch = /^\s*riddle\s*:\s*(.+)$/im.exec(raw);
  const answerMatch = /^\s*answer\s*:\s*(.+)$/im.exec(raw);
  const riddle = riddleMatch?.[1]?.trim() ?? "";
  const answer = answerMatch?.[1]?.trim() ?? "";
  return riddle.length > 0 && answer.length > 0 ? { riddle, answer } : null;
}

/**
 * How many consecutive failures retire an account from the rotation.
 *
 * An account whose credential was revoked fails identically every time, so
 * asking it again buys nothing but a subprocess and a duplicate row. Three
 * rather than one because a single failure is far more likely to be a dropped
 * network than a dead account, and the cost of one extra ask is trivial next
 * to wrongly parking a working account.
 */
export const RIDDLE_CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * Whether an account is worth asking.
 *
 * The selected account is excluded on purpose: real work already keeps its
 * window turning, so a riddle there spends quota to achieve what is happening
 * anyway. A signed-out profile is excluded because there is nothing to keep
 * warm.
 *
 * Note what is NOT consulted here: `usageUnauthorized` and
 * `usageCredentialMissing`. Those are only populated when the profile listing
 * is asked for usage, and this loop deliberately does not ask — a usage probe
 * reads the login keychain, which is the very thing that makes the sibling
 * features opt-in. Gating on flags that are structurally always `undefined`
 * would be a guard that cannot fire, so a dead account is retired from the
 * rotation by its own failure history instead (see `retiredHomePaths`), which
 * is evidence this loop actually has.
 */
export function isRiddleEligible(
  profile: ClaudeAccountProfile,
  retiredHomePaths?: ReadonlySet<string>,
): boolean {
  return (
    !profile.isCurrent &&
    (profile.email ?? "").length > 0 &&
    retiredHomePaths?.has(profile.homePath) !== true
  );
}

export interface RiddleRotationInput {
  readonly profiles: ReadonlyArray<ClaudeAccountProfile>;
  /** Home path → ISO instant of that account's most recent ask. */
  readonly lastAskedByHomePath: ReadonlyMap<string, string>;
  /**
   * Home paths retired for failing {@link RIDDLE_CONSECUTIVE_FAILURE_LIMIT}
   * times in a row. One success clears the count, so an account that comes
   * back — the user signs it in again — rejoins the rotation on its own.
   */
  readonly retiredHomePaths?: ReadonlySet<string>;
}

/**
 * Which accounts have failed often enough in a row to be retired.
 *
 * Reads newest-first rows and counts the unbroken run of failures at the head
 * of each account's history; a single `answered` anywhere in that run means the
 * account works and the count resets to zero.
 */
export function retiredRiddleHomePaths(
  recent: ReadonlyArray<{ readonly accountHomePath: string; readonly status: string }>,
): ReadonlySet<string> {
  const consecutive = new Map<string, number>();
  const settled = new Set<string>();
  for (const row of recent) {
    if (settled.has(row.accountHomePath)) continue;
    if (row.status === "failed") {
      consecutive.set(row.accountHomePath, (consecutive.get(row.accountHomePath) ?? 0) + 1);
      continue;
    }
    // The first success walking backwards ends this account's failure run.
    settled.add(row.accountHomePath);
  }
  return new Set(
    [...consecutive.entries()]
      .filter(
        ([homePath, count]) => !settled.has(homePath) && count >= RIDDLE_CONSECUTIVE_FAILURE_LIMIT,
      )
      .map(([homePath]) => homePath),
  );
}

/**
 * Whose turn it is: the eligible account asked longest ago, with one never
 * asked outranking every account that has been.
 *
 * Ordering on the stored log rather than an in-memory cursor is what makes the
 * rotation survive a restart. A cursor resets to zero on every launch, so on a
 * machine that restarts often the first account would be asked repeatedly and
 * the last never — precisely the account most likely to have gone stale.
 *
 * Ties break on home path so the order is total and the choice deterministic;
 * without it two never-asked accounts would alternate on `Array.sort`
 * implementation detail.
 */
export function chooseRiddleTarget(input: RiddleRotationInput): ClaudeAccountProfile | undefined {
  const eligible = input.profiles.filter((profile) =>
    isRiddleEligible(profile, input.retiredHomePaths),
  );
  if (eligible.length === 0) {
    return undefined;
  }
  const askedAtMs = (profile: ClaudeAccountProfile): number => {
    const askedAt = input.lastAskedByHomePath.get(profile.homePath);
    if (!askedAt) {
      // Never asked: ahead of everything that has been.
      return Number.NEGATIVE_INFINITY;
    }
    const parsed = Date.parse(askedAt);
    // An unparseable stamp is treated as never asked rather than as "just
    // now": the failure mode of asking an account twice is a wasted riddle,
    // and of never asking it is the whole feature silently not working.
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return eligible.toSorted((a, b) => {
    const aMs = askedAtMs(a);
    const bMs = askedAtMs(b);
    // Compared, not subtracted: two never-asked accounts are both -Infinity,
    // and subtracting those yields NaN, which makes the sort order undefined.
    const byAge = aMs === bMs ? 0 : aMs < bMs ? -1 : 1;
    return byAge !== 0 ? byAge : a.homePath.localeCompare(b.homePath);
  })[0];
}
