import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnId } from "@ch3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it } from "@effect/vitest";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resetProviderActivityClock, touchProviderActivity } from "../providerActivityClock.ts";
import {
  MAX_NUDGES_WITHOUT_ACTIVITY,
  STALL_THRESHOLD_MS,
  STALL_THRESHOLD_WITH_WORK_IN_FLIGHT_MS,
  runTurnStallSweep,
  stallNudgeText,
} from "./TurnStallWatchdog.ts";

// The test clock starts at the epoch, so a session last moved "at the epoch"
// has been silent for exactly as long as the clock has been advanced.
const epoch = "1970-01-01T00:00:00.000Z";

const shell = (input: {
  id: string;
  status?: "running" | "ready";
  activeTurnId?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
}) => ({
  id: ThreadId.make(input.id),
  runtimeMode: "full-access",
  interactionMode: "default",
  hasPendingApprovals: input.hasPendingApprovals ?? false,
  hasPendingUserInput: input.hasPendingUserInput ?? false,
  session: {
    threadId: ThreadId.make(input.id),
    status: input.status ?? "running",
    providerName: "claudeAgent",
    runtimeMode: "full-access",
    activeTurnId: input.activeTurnId === null ? null : TurnId.make(input.activeTurnId ?? "turn-1"),
    lastError: null,
    updatedAt: epoch,
  },
});

function harness(threads: ReadonlyArray<unknown>) {
  const dispatched: Array<{ type: string; threadId: string; message?: { text: string } }> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: { type: string; threadId: string; message?: { text: string } }) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as never),
    Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 0, projects: [], threads, updatedAt: epoch }),
    } as never),
    TestClock.layer(),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return { dispatched, layer };
}

/**
 * The twelve-minute silences: a turn whose model stream hung produced nothing,
 * the row said "Working", and it resumed the moment somebody typed "hello?".
 * The watchdog types it for them.
 */
describe("runTurnStallSweep", () => {
  beforeEach(() => resetProviderActivityClock());

  it.effect("nudges a running turn that has been silent past the threshold, once", () => {
    const { dispatched, layer } = harness([shell({ id: "silent" })]);
    return Effect.gen(function* () {
      const records = new Map();
      yield* TestClock.adjust(Duration.millis(STALL_THRESHOLD_MS - 1_000));
      expect(yield* runTurnStallSweep(records)).toEqual([]);
      yield* TestClock.adjust(Duration.millis(1_000));
      expect(yield* runTurnStallSweep(records)).toEqual([ThreadId.make("silent")]);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]!.type).toBe("thread.turn.start");
      expect(dispatched[0]!.message?.text).toBe(stallNudgeText(STALL_THRESHOLD_MS));
      // The same turn is not nudged again while it stays the active turn.
      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* runTurnStallSweep(records)).toEqual([]);
      expect(dispatched).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a turn alone while it is waiting on a person", () => {
    const { dispatched, layer } = harness([
      shell({ id: "approval", hasPendingApprovals: true }),
      shell({ id: "question", hasPendingUserInput: true }),
      shell({ id: "finished", status: "ready", activeTurnId: null }),
    ]);
    return Effect.gen(function* () {
      yield* TestClock.adjust(Duration.hours(2));
      expect(yield* runTurnStallSweep(new Map())).toEqual([]);
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives a running tool the longer threshold", () => {
    const { dispatched, layer } = harness([shell({ id: "tool" })]);
    return Effect.gen(function* () {
      const records = new Map();
      touchProviderActivity(ThreadId.make("tool"), "item.started", 0);
      yield* TestClock.adjust(Duration.millis(STALL_THRESHOLD_MS + 1_000));
      expect(yield* runTurnStallSweep(records)).toEqual([]);
      yield* TestClock.adjust(
        Duration.millis(STALL_THRESHOLD_WITH_WORK_IN_FLIGHT_MS - STALL_THRESHOLD_MS),
      );
      expect(yield* runTurnStallSweep(records)).toEqual([ThreadId.make("tool")]);
      expect(dispatched).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("counts the clock from the last provider event, not the session row", () => {
    const { dispatched, layer } = harness([shell({ id: "chatty" })]);
    return Effect.gen(function* () {
      yield* TestClock.adjust(Duration.minutes(4));
      // Text streamed a moment ago: the row's timestamp is old, the thread is not.
      touchProviderActivity(ThreadId.make("chatty"), "content.delta", 4 * 60_000);
      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* runTurnStallSweep(new Map())).toEqual([]);
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops nudging a provider that never answers", () => {
    // Each nudge starts a new turn id on a live server; here the stub keeps
    // the same silent session, which is what a dead provider looks like.
    const turns = ["turn-1", "turn-2", "turn-3", "turn-4"];
    let index = 0;
    const threads = { current: [shell({ id: "dead", activeTurnId: "turn-1" })] };
    const { dispatched, layer } = harness(threads.current);
    return Effect.gen(function* () {
      const records = new Map();
      for (const turn of turns) {
        threads.current[0] = shell({ id: "dead", activeTurnId: turn });
        yield* TestClock.adjust(Duration.millis(STALL_THRESHOLD_MS));
        yield* runTurnStallSweep(records);
        index += 1;
      }
      expect(index).toBe(4);
      expect(dispatched).toHaveLength(MAX_NUDGES_WITHOUT_ACTIVITY);
    }).pipe(Effect.provide(layer));
  });
});
