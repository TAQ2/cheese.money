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
