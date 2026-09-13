/**
 * Floor between visibility-driven connection wakeups. The wakeup exists for
 * real network death after long absence — not for cmd-tab, which our users do
 * constantly and which used to tear down and rebuild every live subscription
 * per return. Within the floor a visible transition emits nothing; the
 * supervisor's own probes cover a connection that actually died meanwhile.
 */
export const VISIBILITY_WAKEUP_MIN_INTERVAL_MS = 15_000;

export function shouldEmitVisibilityWakeup(lastEmittedAtMs: number | null, nowMs: number): boolean {
  return lastEmittedAtMs === null || nowMs - lastEmittedAtMs >= VISIBILITY_WAKEUP_MIN_INTERVAL_MS;
}
