import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadKanbanState,
} from "@ch3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(input: {
  readonly kanban?: ThreadKanbanState | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        kanban: input.kanban ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const PINNED_STATE: ThreadKanbanState = {
  stage: "decision-needed",
  cardType: "urgent",
  deadline: null,
  pinned: true,
  description: "Existing description.",
  keywords: ["existing"],
  classifiedAt: null,
};

const LEASED_STATE: ThreadKanbanState = {
  stage: null,
  cardType: null,
  deadline: null,
  pinned: false,
  description: "Existing description.",
  keywords: [],
  classifiedAt: null,
  agentWorkingUntil: "2026-01-01T00:30:00.000Z",
};

it.layer(NodeServices.layer)("kanban thread decider", (it) => {
  it.effect("applies a user move and pins the card", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-user"),
          threadId: ThreadId.make("thread-1"),
          stage: "full-attention",
          pinned: true,
          source: "user",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.stage).toBe("full-attention");
        expect(events[0].payload.kanban.pinned).toBe(true);
        // Board placement never carries updatedAt: classification and moves
        // must not reorder the inbox.
        expect("updatedAt" in events[0].payload).toBe(false);
      }
    }),
  );

  it.effect("records an agent-working lease from a non-classifier caller", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-lease"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: "2026-01-01T00:30:00.000Z",
          source: "user",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingUntil).toBe("2026-01-01T00:30:00.000Z");
      }
    }),
  );

  it.effect("lets the holder release its own lease", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-release"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: null,
          source: "user",
        },
        readModel: makeReadModel({
          kanban: { ...PINNED_STATE, agentWorkingUntil: "2026-01-01T00:30:00.000Z" },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingUntil).toBeNull();
      }
    }),
  );

  it.effect("classifier never clears a lease it cannot see", () =>
    Effect.gen(function* () {
      // The classifier only reads the conversation. A detached run it has no
      // way to observe must not be declared finished because a model wrote a
      // fresh card summary.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-classify-lease"),
          threadId: ThreadId.make("thread-1"),
          description: "Refreshed summary.",
          source: "classifier",
        },
        readModel: makeReadModel({
          kanban: {
            ...PINNED_STATE,
            pinned: false,
            agentWorkingUntil: "2026-01-01T00:30:00.000Z",
          },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingUntil).toBe("2026-01-01T00:30:00.000Z");
        expect(events[0].payload.kanban.description).toBe("Refreshed summary.");
      }
    }),
  );

  it.effect("classifier updates stage and summary on an unpinned card", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-classify"),
          threadId: ThreadId.make("thread-1"),
          stage: "final-review",
          description: "Two lines about the work.",
          keywords: ["alpha", "beta", "gamma"],
          source: "classifier",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.stage).toBe("final-review");
        expect(events[0].payload.kanban.description).toBe("Two lines about the work.");
        expect(events[0].payload.kanban.keywords).toEqual(["alpha", "beta", "gamma"]);
        expect(events[0].payload.kanban.classifiedAt).not.toBeNull();
      }
    }),
  );

  it.effect("classifier never moves or retypes a pinned card but refreshes its summary", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-pinned"),
          threadId: ThreadId.make("thread-1"),
          stage: "exploration",
          cardType: "standard",
          description: "Fresh description.",
          keywords: ["fresh"],
          source: "classifier",
        },
        readModel: makeReadModel({ kanban: PINNED_STATE }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.stage).toBe("decision-needed");
        expect(events[0].payload.kanban.cardType).toBe("urgent");
        expect(events[0].payload.kanban.pinned).toBe(true);
        expect(events[0].payload.kanban.description).toBe("Fresh description.");
        expect(events[0].payload.kanban.keywords).toEqual(["fresh"]);
      }
    }),
  );

  it.effect("user move overrides a pinned card and can release the pin", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-release"),
          threadId: ThreadId.make("thread-1"),
          stage: "move-along",
          pinned: false,
          source: "user",
        },
        readModel: makeReadModel({ kanban: PINNED_STATE }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.stage).toBe("move-along");
        expect(events[0].payload.kanban.pinned).toBe(false);
        // Untouched fields carry over.
        expect(events[0].payload.kanban.description).toBe("Existing description.");
      }
    }),
  );

  it.effect("records an agent-working lease from a non-classifier caller", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-lease-claim"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: "2026-01-01T00:15:00.000Z",
          source: "user",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingUntil).toBe("2026-01-01T00:15:00.000Z");
      }
    }),
  );

  it.effect("lets the holder release its lease with null", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-lease-release"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: null,
          source: "user",
        },
        readModel: makeReadModel({ kanban: LEASED_STATE }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingUntil).toBeNull();
      }
    }),
  );

  it.effect("classifier refreshes the summary but never clears a lease it cannot see", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-lease-classifier"),
          threadId: ThreadId.make("thread-1"),
          description: "Refreshed by the classifier.",
          agentWorkingUntil: null,
          source: "classifier",
        },
        readModel: makeReadModel({ kanban: LEASED_STATE }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.description).toBe("Refreshed by the classifier.");
        // The classifier only reads the conversation, so it cannot know that a
        // detached run has finished — its "null" must not end the lease.
        expect(events[0].payload.kanban.agentWorkingUntil).toBe("2026-01-01T00:30:00.000Z");
      }
    }),
  );

  // The lease says only that the run has not ended; its expiry slides forward
  // on every renewal. `agentWorkingSince` is the other half — when the run
  // began — and without it a leased row can only say "Working" with no number,
  // because a leased thread has no session and no turn to read a start from.
  //
  // Every fixture below is built FROM the decider's own clock rather than
  // pinned to a literal date. These tests share one layer, and the clock they
  // run on starts at the epoch, so a hard-coded "2026-..." expiry reads as the
  // far future and every lease looks live. Deriving the fixtures keeps
  // "already lapsed" and "still held" true whatever the clock says.
  const leaseFixtures = Effect.gen(function* () {
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const at = (offsetMs: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) + offsetMs));
    return {
      now,
      anHourAgo: at(-3_600_000),
      twoHoursAgo: at(-7_200_000),
      inHalfAnHour: at(1_800_000),
      inTwoHours: at(7_200_000),
    };
  });

  it.effect("stamps a start when a lease is first claimed", () =>
    Effect.gen(function* () {
      const t = yield* leaseFixtures;
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-since-claim"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: t.inHalfAnHour,
          source: "user",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingSince).toBe(t.now);
      }
    }),
  );

  it.effect("carries the start unchanged through a renewal of a live lease", () =>
    Effect.gen(function* () {
      // The trap this guards: the daemon renews by pushing the expiry out. If
      // the start moved with it, the clock would reset on every renewal and the
      // row would never read more than one renewal interval.
      const t = yield* leaseFixtures;
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-since-renew"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: t.inTwoHours,
          source: "user",
        },
        readModel: makeReadModel({
          kanban: {
            ...LEASED_STATE,
            agentWorkingUntil: t.inHalfAnHour,
            agentWorkingSince: t.anHourAgo,
          },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingUntil).toBe(t.inTwoHours);
        expect(events[0].payload.kanban.agentWorkingSince).toBe(t.anHourAgo);
      }
    }),
  );

  it.effect("clears the start when the lease is released", () =>
    Effect.gen(function* () {
      const t = yield* leaseFixtures;
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-since-release"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: null,
          source: "user",
        },
        readModel: makeReadModel({
          kanban: {
            ...LEASED_STATE,
            agentWorkingUntil: t.inHalfAnHour,
            agentWorkingSince: t.anHourAgo,
          },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingUntil).toBeNull();
        expect(events[0].payload.kanban.agentWorkingSince).toBeNull();
      }
    }),
  );

  it.effect("re-stamps a lease that had already lapsed, because that is new work", () =>
    Effect.gen(function* () {
      // The stored expiry is BEFORE now, so this claim is a restart rather than
      // a renewal: carrying the old start forward would report a run that ended
      // hours ago as still going.
      const t = yield* leaseFixtures;
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.kanban.update",
          commandId: CommandId.make("cmd-kanban-since-restart"),
          threadId: ThreadId.make("thread-1"),
          agentWorkingUntil: t.inHalfAnHour,
          source: "user",
        },
        readModel: makeReadModel({
          kanban: {
            ...LEASED_STATE,
            agentWorkingUntil: t.anHourAgo,
            agentWorkingSince: t.twoHoursAgo,
          },
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.kanban-updated");
      if (events[0]?.type === "thread.kanban-updated") {
        expect(events[0].payload.kanban.agentWorkingSince).toBe(t.now);
      }
    }),
  );

  it.effect("rejects kanban updates on archived threads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "thread.kanban.update",
            commandId: CommandId.make("cmd-kanban-archived"),
            threadId: ThreadId.make("thread-1"),
            stage: "exploration",
            source: "user",
          },
          readModel: makeReadModel({ archivedAt: NOW }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
