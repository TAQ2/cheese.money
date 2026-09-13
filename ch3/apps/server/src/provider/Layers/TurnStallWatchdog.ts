import { CommandId, MessageId, type ThreadId, type TurnId } from "@ch3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { readProviderActivity } from "../providerActivityClock.ts";
import { TurnStallWatchdog, type TurnStallWatchdogShape } from "../Services/TurnStallWatchdog.ts";

/**
 * How long a running turn may say nothing before it is nudged.
 *
 * Five minutes when the last thing heard was a model turn or streamed text —
 * a model call that has produced nothing for five minutes is not thinking, it
 * is a stream that hung. Ten when the last thing heard was a tool or task
 * starting: a shell command may legitimately run for that long (the Bash
 * tool's own ceiling) and say nothing until it exits. Waiting on an approval
 * or a question is never silence — those turns are skipped outright.
 */
export const STALL_THRESHOLD_MS = 5 * 60_000;
export const STALL_THRESHOLD_WITH_WORK_IN_FLIGHT_MS = 10 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/**
 * Nudges without a single provider event in between. Past this the provider
 * is not hung, it is gone, and another "continue" every five minutes would be
 * a loop; the row keeps its state for a person to look at.
 */
export const MAX_NUDGES_WITHOUT_ACTIVITY = 2;

const WORK_IN_FLIGHT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "item.started",
  "item.updated",
  "tool.progress",
  "task.started",
  "task.progress",
  "hook.started",
  "hook.progress",
]);

export const stallNudgeText = (silentMs: number): string =>
  `[CH3] Nothing has reached CH3 from this reply for ${Math.max(1, Math.round(silentMs / 60_000))} minutes. Continue from where you left off.`;

export interface TurnStallWatchdogLiveOptions {
  readonly sweepIntervalMs?: number;
}

interface NudgeRecord {
  readonly turnId: TurnId;
  readonly sinceMs: number;
  readonly count: number;
}

/**
 * One sweep: every running turn that has produced nothing for longer than
 * its threshold gets the message a person would have typed.
 *
 * The nudge is a real user turn, dispatched exactly as the composer would
 * dispatch it, because that is the one intervention proven to work: a hung
 * reply resumed within seconds every time somebody typed "hello?", and this
 * removes the need for the somebody. It is prefixed so nobody mistakes it for
 * their own words in the transcript.
 */
export const runTurnStallSweep = Effect.fn("runTurnStallSweep")(function* (
  nudgeRecords: Map<ThreadId, NudgeRecord>,
) {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now;
  const nowMs = DateTime.toEpochMillis(now);
  const nowIso = DateTime.formatIso(now);
  const threads = yield* snapshots.getShellSnapshot().pipe(
    Effect.map((snapshot) => snapshot.threads),
    Effect.orElseSucceed(() => []),
  );
  const nudged: ThreadId[] = [];
  for (const thread of threads) {
    const session = thread.session;
    if (!session || session.status !== "running" || session.activeTurnId === null) continue;
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) continue;
    const last = readProviderActivity(thread.id);
    const lastAtMs = last?.atMs ?? Date.parse(session.updatedAt);
    if (Number.isNaN(lastAtMs)) continue;
    const threshold =
      last !== undefined && WORK_IN_FLIGHT_EVENT_TYPES.has(last.type)
        ? STALL_THRESHOLD_WITH_WORK_IN_FLIGHT_MS
        : STALL_THRESHOLD_MS;
    const silentMs = nowMs - lastAtMs;
    if (silentMs < threshold) continue;
    const record = nudgeRecords.get(thread.id);
    if (record !== undefined && record.turnId === session.activeTurnId) continue;
    const count = record !== undefined && record.sinceMs === lastAtMs ? record.count + 1 : 1;
    if (count > MAX_NUDGES_WITHOUT_ACTIVITY) {
      if (record === undefined || record.count <= MAX_NUDGES_WITHOUT_ACTIVITY) {
        yield* Effect.logWarning("turn stall watchdog gave up on a thread that never answered", {
          threadId: thread.id,
          silentMs,
        });
        nudgeRecords.set(thread.id, { turnId: session.activeTurnId, sinceMs: lastAtMs, count });
      }
      continue;
    }
    const commandId = CommandId.make(
      `server:stall-nudge:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    );
    const messageId = MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    // Recorded before the dispatch, not inside its success branch. The record
    // is what `MAX_NUDGES_WITHOUT_ACTIVITY` counts, so writing it only on
    // success meant a thread whose dispatch keeps failing never accumulated
    // one: `record` stayed undefined, `count` reset to 1 every sweep, the
    // give-up guard never engaged, and the failing dispatch repeated once a
    // minute for the life of the process. An attempt counts whether or not it
    // landed.
    nudgeRecords.set(thread.id, { turnId: session.activeTurnId, sinceMs: lastAtMs, count });
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: thread.id,
        message: {
          messageId,
          role: "user",
          text: stallNudgeText(silentMs),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: nowIso,
      })
      .pipe(
        Effect.map(() => {
          nudged.push(thread.id);
        }),
        Effect.catch((error) =>
          Effect.logWarning("turn stall watchdog could not nudge a silent turn", {
            threadId: thread.id,
            error,
          }),
        ),
      );
    if (nudged.includes(thread.id)) {
      yield* Effect.logInfo("turn stall watchdog nudged a silent turn", {
        threadId: thread.id,
        turnId: session.activeTurnId,
        silentMs,
        lastEventType: last?.type ?? null,
      });
    }
  }
  return nudged;
});

export const makeTurnStallWatchdogLive = (options?: TurnStallWatchdogLiveOptions) =>
  Effect.gen(function* () {
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    const nudgeRecords = new Map<ThreadId, NudgeRecord>();
    const sweep = runTurnStallSweep(nudgeRecords).pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery, snapshots),
      Effect.provideService(Crypto.Crypto, crypto),
    );

    const start: TurnStallWatchdogShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("turn stall watchdog sweep failed", { cause }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("turn stall watchdog started", {
          sweepIntervalMs,
          stallThresholdMs: STALL_THRESHOLD_MS,
          stallThresholdWithWorkInFlightMs: STALL_THRESHOLD_WITH_WORK_IN_FLIGHT_MS,
        });
      });

    return { start } satisfies TurnStallWatchdogShape;
  });

export const TurnStallWatchdogLive = Layer.effect(TurnStallWatchdog, makeTurnStallWatchdogLive());
