import { EventId, ThreadId, TurnId } from "@ch3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const NOW = "2026-01-01T00:00:00.000Z";

let rowCounter = 0;
function activityRow(input: {
  readonly threadId: string;
  readonly kind:
    | "task.started"
    | "task.completed"
    | "task.progress"
    | "tool.started"
    | "tool.completed";
  readonly taskId?: string;
  readonly taskType?: string;
  readonly itemType?: string;
  readonly turnId?: string | null;
  readonly createdAt?: string;
}) {
  rowCounter += 1;
  return {
    activityId: EventId.make(`activity-${rowCounter}`),
    threadId: ThreadId.make(input.threadId),
    turnId: input.turnId === undefined || input.turnId === null ? null : TurnId.make(input.turnId),
    tone: "info" as const,
    kind: input.kind,
    summary: `${input.kind} row`,
    payload: {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
      ...(input.itemType === undefined ? {} : { itemType: input.itemType }),
    },
    createdAt: input.createdAt ?? NOW,
  };
}

layer("ProjectionThreadActivityRepository.listOpenTasks", (it) => {
  it.effect("finds a task that started and never reported an outcome", () =>
    Effect.gen(function* () {
      // This is the whole point: a task whose process died leaves exactly this
      // shape behind, and nothing in that process can ever close it.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({ threadId: "thread-open", kind: "task.started", taskId: "task-1" }),
      );

      const open = yield* activities.listOpenTasks;
      const mine = open.filter((row) => row.threadId === "thread-open");
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.taskId, "task-1");
    }),
  );

  it.effect("ignores a task that already completed", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({ threadId: "thread-closed", kind: "task.started", taskId: "task-2" }),
      );
      yield* activities.upsert(
        activityRow({ threadId: "thread-closed", kind: "task.completed", taskId: "task-2" }),
      );

      const open = yield* activities.listOpenTasks;
      assert.deepEqual(
        open.filter((row) => row.threadId === "thread-closed"),
        [],
      );
    }),
  );

  it.effect("matches on thread AND task id, since ids are unique per session only", () =>
    Effect.gen(function* () {
      // Two threads legitimately holding the same task id: closing one must
      // not silently close the other.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({ threadId: "thread-a", kind: "task.started", taskId: "shared" }),
      );
      yield* activities.upsert(
        activityRow({ threadId: "thread-b", kind: "task.started", taskId: "shared" }),
      );
      yield* activities.upsert(
        activityRow({ threadId: "thread-a", kind: "task.completed", taskId: "shared" }),
      );

      const open = yield* activities.listOpenTasks;
      const stillOpen = open.filter((row) => row.taskId === "shared");
      assert.equal(stillOpen.length, 1);
      assert.equal(stillOpen[0]?.threadId, "thread-b");
    }),
  );

  it.effect("skips rows carrying no task id rather than inventing one", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(activityRow({ threadId: "thread-idless", kind: "task.started" }));

      const open = yield* activities.listOpenTasks;
      assert.deepEqual(
        open.filter((row) => row.threadId === "thread-idless"),
        [],
      );
    }),
  );

  it.effect("returns oldest first, so a capped pass still drains the backlog", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-order",
          kind: "task.started",
          taskId: "newer",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      yield* activities.upsert(
        activityRow({
          threadId: "thread-order",
          kind: "task.started",
          taskId: "older",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const open = yield* activities.listOpenTasks;
      assert.deepEqual(
        open.filter((row) => row.threadId === "thread-order").map((row) => row.taskId),
        ["older", "newer"],
      );
    }),
  );
});

layer("ProjectionThreadActivityRepository.countLiveDelegations", (it) => {
  const TURN = "turn-1";

  it.effect("counts a single Claude subagent — the case the rail used to miss", () =>
    Effect.gen(function* () {
      // One agent, one robot. This returned 0 before, because only the collab
      // tool-call shape was counted, and the rail then lit up solely when the
      // parent session fell quiet — which read as "it needs two agents".
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-one-agent",
          kind: "task.started",
          taskId: "agent-1",
          taskType: "local_agent",
          turnId: TURN,
        }),
      );

      const live = yield* activities.countLiveDelegations({
        threadId: ThreadId.make("thread-one-agent"),
        turnId: TurnId.make(TURN),
      });
      assert.equal(live, 1);
    }),
  );

  it.effect("stops counting an agent once it reports back", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-done",
          kind: "task.started",
          taskId: "agent-2",
          taskType: "local_agent",
          turnId: TURN,
        }),
      );
      yield* activities.upsert(
        activityRow({
          threadId: "thread-done",
          kind: "task.completed",
          taskId: "agent-2",
          turnId: TURN,
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-done"),
          turnId: TurnId.make(TURN),
        }),
        0,
      );
    }),
  );

  it.effect("clears an agent that finished in a LATER turn than it started", () =>
    Effect.gen(function* () {
      // The common case, not the exotic one: an agent outlives the message
      // that launched it, so its completion lands in the next turn. Matching
      // completions turn-first would leave it counted forever — a robot on a
      // finished thread with nothing to clear it.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-late",
          kind: "task.started",
          taskId: "agent-3",
          taskType: "local_agent",
          turnId: TURN,
        }),
      );
      yield* activities.upsert(
        activityRow({
          threadId: "thread-late",
          kind: "task.completed",
          taskId: "agent-3",
          turnId: "turn-2",
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-late"),
          turnId: TurnId.make(TURN),
        }),
        0,
      );
    }),
  );

  it.effect("does not call a backgrounded shell command an agent", () =>
    Effect.gen(function* () {
      // `local_bash` is a task.started too. Painting the rail "Agents" for a
      // `sleep 30` would be the same lie in the other direction.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-bash",
          kind: "task.started",
          taskId: "bash-1",
          taskType: "local_bash",
          turnId: TURN,
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-bash"),
          turnId: TurnId.make(TURN),
        }),
        0,
      );
    }),
  );

  it.effect("still counts the collab tool-call shape, and adds the two together", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-both",
          kind: "tool.started",
          itemType: "collab_agent_tool_call",
          turnId: TURN,
        }),
      );
      yield* activities.upsert(
        activityRow({
          threadId: "thread-both",
          kind: "task.started",
          taskId: "agent-4",
          taskType: "local_agent",
          turnId: TURN,
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-both"),
          turnId: TurnId.make(TURN),
        }),
        2,
      );
    }),
  );

  it.effect("keeps counting an agent whose turn ended under it", () =>
    Effect.gen(function* () {
      // Traced on a real thread: the agent started 11 seconds before its turn
      // completed and went on working for two more minutes under the next one.
      // Scoping the start to the current turn — which this query did at first —
      // lit the rail for those 11 seconds and then dropped it while the agent
      // was still going, which is the original silence in a shorter dress.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-outlived",
          kind: "task.started",
          taskId: "agent-5",
          taskType: "local_agent",
          turnId: "turn-that-ended",
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-outlived"),
          turnId: TurnId.make(TURN),
        }),
        1,
      );
    }),
  );

  it.effect("counts a second delegation that reuses a finished agent's taskId", () =>
    Effect.gen(function* () {
      // Claude reuses one taskId for repeat delegations in a thread — 331
      // starts on this machine carry 288 distinct ids, one of them six times.
      // Asking "does a completion exist" has no ordering, so the second run
      // was cancelled by the FIRST run's completion and showed nothing while
      // it worked. Netting per id is what makes the second one count.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-reuse",
          kind: "task.started",
          taskId: "agent-reused",
          taskType: "local_agent",
          turnId: TURN,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      yield* activities.upsert(
        activityRow({
          threadId: "thread-reuse",
          kind: "task.completed",
          taskId: "agent-reused",
          turnId: TURN,
          createdAt: "2026-01-01T00:01:00.000Z",
        }),
      );
      yield* activities.upsert(
        activityRow({
          threadId: "thread-reuse",
          kind: "task.started",
          taskId: "agent-reused",
          taskType: "local_agent",
          turnId: TURN,
          createdAt: "2026-01-01T00:02:00.000Z",
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-reuse"),
          turnId: TurnId.make(TURN),
        }),
        1,
      );
    }),
  );

  it.effect("does not let a straddling collab completion blank a live agent", () =>
    Effect.gen(function* () {
      // A collab pair can straddle a turn: the completion lands in this turn
      // while its start belongs to the previous one, so that half sums to −1.
      // Added bare, it cancelled the agent beside it and the rail went dark on
      // a thread that had one working.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-straddle",
          kind: "tool.completed",
          itemType: "collab_agent_tool_call",
          turnId: TURN,
        }),
      );
      yield* activities.upsert(
        activityRow({
          threadId: "thread-straddle",
          kind: "task.started",
          taskId: "agent-7",
          taskType: "local_agent",
          turnId: TURN,
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-straddle"),
          turnId: TurnId.make(TURN),
        }),
        1,
      );
    }),
  );

  it.effect("never counts another thread's agent", () =>
    Effect.gen(function* () {
      // The turn no longer bounds the agent half, so the thread has to.
      const activities = yield* ProjectionThreadActivityRepository;
      yield* activities.upsert(
        activityRow({
          threadId: "thread-neighbour",
          kind: "task.started",
          taskId: "agent-6",
          taskType: "local_agent",
          turnId: TURN,
        }),
      );

      assert.equal(
        yield* activities.countLiveDelegations({
          threadId: ThreadId.make("thread-asking"),
          turnId: TurnId.make(TURN),
        }),
        0,
      );
    }),
  );
});
