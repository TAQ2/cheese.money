import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@ch3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(messages: OrchestrationThread["messages"] = []): OrchestrationReadModel {
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
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages,
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const USER_MESSAGE: OrchestrationThread["messages"][number] = {
  id: MessageId.make("message-1"),
  role: "user",
  text: "Add the retry button",
  turnId: null,
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
};

it.layer(NodeServices.layer)("thread.turn.retry decider", (it) => {
  it.effect(
    "re-emits thread.turn-start-requested for the same message, without a new message-sent event",
    () =>
      Effect.gen(function* () {
        const event = yield* decideOrchestrationCommand({
          command: {
            type: "thread.turn.retry",
            commandId: CommandId.make("cmd-retry"),
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-1"),
            createdAt: NOW,
          },
          readModel: makeReadModel([USER_MESSAGE]),
        });
        const events = Array.isArray(event) ? event : [event];
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("thread.turn-start-requested");
        if (events[0]?.type === "thread.turn-start-requested") {
          expect(events[0].payload.messageId).toBe(MessageId.make("message-1"));
        }
      }),
  );

  it.effect("carries the thread's title as the retried turn's seed", () =>
    Effect.gen(function* () {
      // Without the seed `canReplaceThreadTitle` refuses to replace a title
      // that is neither the default nor equal to the seed, so a retried FIRST
      // turn kept the raw prompt as the thread's name forever.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.retry",
          commandId: CommandId.make("cmd-retry-seed"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel([USER_MESSAGE]),
      });
      const events = Array.isArray(event) ? event : [event];
      const first = events[0];
      expect(first?.type).toBe("thread.turn-start-requested");
      if (first?.type === "thread.turn-start-requested") {
        expect(first.payload.titleSeed).toBe("Thread");
        // The thread's own model wins on a retry, so the event names none.
        expect(first.payload.modelSelection).toBeUndefined();
      }
    }),
  );

  it.effect("refuses to retry a message the thread has already moved past", () =>
    Effect.gen(function* () {
      // The failed-turn row stays on screen forever, so a days-old failure was
      // one click from starting a turn on a thread that had moved on —
      // including one the person had already retyped by hand.
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.retry",
          commandId: CommandId.make("cmd-retry-stale"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel([
          USER_MESSAGE,
          { ...USER_MESSAGE, id: MessageId.make("message-2"), text: "Typed again, by hand" },
        ]),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(result)).toContain("is not the latest message on thread");
    }),
  );

  it.effect("rejects a retry for a message that does not exist on the thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.retry",
          commandId: CommandId.make("cmd-retry-missing"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-does-not-exist"),
          createdAt: NOW,
        },
        readModel: makeReadModel([USER_MESSAGE]),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
