import type { ThreadId } from "@ch3tools/contracts";

/**
 * When each thread's provider last said anything, in process memory.
 *
 * Every runtime event a driver emits passes through `ProviderService`, and
 * this is the one place that remembers the time of the latest one per thread.
 * It exists for the stall watchdog: "working" on screen means only that a
 * turn started, and the projection cannot tell a reply that is thinking from
 * one whose model stream hung an hour ago — the twelve-minute silences that
 * ended only when somebody typed "hello?" were exactly that. Memory rather
 * than a projection because it is a clock, not history: a restart forgets it,
 * and a restart also kills every provider process, so nothing is lost.
 */
interface ProviderActivityMark {
  readonly atMs: number;
  readonly type: string;
}

const lastByThread = new Map<ThreadId, ProviderActivityMark>();

export const touchProviderActivity = (threadId: ThreadId, type: string, atMs: number): void => {
  lastByThread.set(threadId, { atMs, type });
};

export const readProviderActivity = (threadId: ThreadId): ProviderActivityMark | undefined =>
  lastByThread.get(threadId);

/** Tests only: forget every mark. */
export const resetProviderActivityClock = (): void => {
  lastByThread.clear();
};
