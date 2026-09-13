import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@ch3tools/contracts";
import type { OrchestrationThread } from "@ch3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

describe("applyThreadDetailEvent", () => {
  describe("project events", () => {
    it("returns unchanged for project.created", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        type: "project.created",
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "CH3",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
          deletedAt: null,
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.created", () => {
    it("creates a fresh thread", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-2"),
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "New Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.id).toBe("thread-2");
        expect(result.thread.title).toBe("New Thread");
        expect(result.thread.branch).toBe("main");
        expect(result.thread.messages).toEqual([]);
        expect(result.thread.session).toBeNull();
      }
    });
  });

  describe("thread.deleted", () => {
    it("returns deleted signal", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T02:00:00.000Z",
        },
      });
      expect(result.kind).toBe("deleted");
    });
  });

  describe("thread.archived / thread.unarchived", () => {
    it("sets archivedAt and clears title regeneration", () => {
      const regeneratingThread: OrchestrationThread = {
        ...baseThread,
        titleRegeneration: {
          requestId: CommandId.make("regenerate-title"),
          startedAt: "2026-04-01T02:00:00.000Z",
        },
      };
      const result = applyThreadDetailEvent(regeneratingThread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T03:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.archived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          archivedAt: "2026-04-01T03:00:00.000Z",
          updatedAt: "2026-04-01T03:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBe("2026-04-01T03:00:00.000Z");
        expect(result.thread.titleRegeneration).toBeNull();
      }
    });

    it("clears archivedAt", () => {
      const archivedThread = { ...baseThread, archivedAt: "2026-04-01T03:00:00.000Z" };
      const result = applyThreadDetailEvent(archivedThread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unarchived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt: "2026-04-01T04:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBeNull();
      }
    });
  });

  describe("thread.settled / thread.unsettled", () => {
    it("sets the settled override and timestamp", () => {
      const settledAt = "2026-04-01T05:00:00.000Z";
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: settledAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.settled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt,
          updatedAt: settledAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe("settled");
        expect(result.thread.settledAt).toBe(settledAt);
      }
    });

    it.each([
      ["user", "active"],
      ["activity", null],
    ] as const)("unsettles for %s with override %s", (reason, settledOverride) => {
      const settledThread: OrchestrationThread = {
        ...baseThread,
        settledOverride: "settled",
        settledAt: "2026-04-01T05:00:00.000Z",
      };
      const updatedAt = "2026-04-01T06:00:00.000Z";
      const result = applyThreadDetailEvent(settledThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsettled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason,
          updatedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe(settledOverride);
        expect(result.thread.settledAt).toBeNull();
      }
    });
  });

  describe("thread.meta-updated", () => {
    it("patches title and branch", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          title: "Updated Title",
          branch: "feature/demo",
          updatedAt: "2026-04-01T05:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.title).toBe("Updated Title");
        expect(result.thread.branch).toBe("feature/demo");
        // Model selection should be unchanged since it wasn't in the payload
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection);
      }
    });
  });

  describe("thread.message-sent", () => {
    it("appends a new message", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Hello, world!",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("appends text for streaming messages", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world!",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("keeps sibling message rows referentially identical when one message streams", () => {
      const untouched = {
        id: MessageId.make("msg-1"),
        role: "user" as const,
        text: "Question",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T05:00:00.000Z",
        updatedAt: "2026-04-01T05:00:00.000Z",
      };
      const threadWithMessages: OrchestrationThread = {
        ...baseThread,
        messages: [
          untouched,
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessages, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: " again",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(2);
        expect(result.thread.messages[0]).toBe(untouched);
        expect(result.thread.messages[1]?.text).toBe("Hello again");
      }
    });

    it("updates latestTurn for assistant messages with a turn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Done.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-3");
      }
    });

    it("keeps latestTurn running for interim assistant messages while the session runs the turn", () => {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          lastErrorClass: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Interim commentary between tool calls.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.session-set", () => {
    it("settles a running latestTurn when the session leaves the running status", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            lastErrorClass: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T08:00:00.000Z");
      }
    });

    it("updates session and latestTurn for a running session", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            lastErrorClass: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("running");
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("running");
      }
    });
  });

  describe("thread.session-stop-requested", () => {
    it("marks session as stopped", () => {
      const threadWithSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          lastErrorClass: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
      };

      const result = applyThreadDetailEvent(threadWithSession, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("stopped");
        expect(result.thread.session?.activeTurnId).toBeNull();
      }
    });

    it("returns unchanged when no session exists", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.proposed-plan-upserted", () => {
    it("adds a proposed plan", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-01T10:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          proposedPlan: {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "## Plan\n- Do stuff",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T10:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans).toHaveLength(1);
        expect(result.thread.proposedPlans[0]?.id).toBe("plan-1");
      }
    });
  });

  describe("thread.activity-appended", () => {
    it("adds an activity", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.kind).toBe("file-edit");
      }
    });

    it("preserves the complete activity history when live events arrive", () => {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-129"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 129",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 129,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(130);
        expect(result.thread.activities[0]?.id).toBe("activity-0");
      }
    });
  });

  describe("thread.turn-diff-completed", () => {
    it("adds a checkpoint and updates latestTurn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 13,
        occurredAt: "2026-04-01T12:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("ref-1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("msg-3"),
          completedAt: "2026-04-01T12:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
      }
    });
  });

  describe("thread.reverted", () => {
    it("filters entities to retained turns", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Response 1",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "assistant",
            text: "Response 2",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-3"),
            completedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // turn-2 checkpoint is filtered out (turnCount 2 > revert target 1)
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.checkpoints[0]?.turnId).toBe("turn-1");
        // msg-3 (turn-2) is filtered, msg-1 (no turn) and msg-2 (turn-1) remain
        expect(result.thread.messages).toHaveLength(2);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
      }
    });
  });

  describe("thread.messages-rewound", () => {
    it("drops the chosen message and everything after it", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hi.",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "user",
            text: "yep wait",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
          {
            id: MessageId.make("msg-4"),
            role: "assistant",
            text: "Waiting.",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T04:00:00.000Z",
            updatedAt: "2026-04-01T04:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 20,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.messages-rewound",
        payload: {
          threadId: ThreadId.make("thread-1"),
          fromMessageId: MessageId.make("msg-3"),
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
      }
    });

    it("leaves the thread untouched when the message is unknown", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 21,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.messages-rewound",
        payload: {
          threadId: ThreadId.make("thread-1"),
          fromMessageId: MessageId.make("nope"),
        },
      });
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("no-op events", () => {
    it("returns unchanged for approval-response-requested", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T13:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.approval-response-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          requestId: "req-1",
          decision: "approve",
          createdAt: "2026-04-01T13:00:00.000Z",
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });

    it("returns unchanged for an event type this build does not recognize", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 999,
        occurredAt: "2026-04-01T13:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.invented-by-a-newer-server",
        payload: { threadId: ThreadId.make("thread-1") },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.snoozed / thread.unsnoozed", () => {
    const snoozedThread: OrchestrationThread = {
      ...baseThread,
      snoozedUntil: "2026-04-02T00:00:00.000Z",
      snoozedAt: "2026-04-01T00:00:00.000Z",
    };

    it("records both snooze timestamps", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 30,
        occurredAt: "2026-04-01T14:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.snoozed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          snoozedUntil: "2026-04-03T00:00:00.000Z",
          snoozedAt: "2026-04-01T14:00:00.000Z",
          updatedAt: "2026-04-01T14:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.snoozedUntil).toBe("2026-04-03T00:00:00.000Z");
        expect(result.thread.snoozedAt).toBe("2026-04-01T14:00:00.000Z");
        expect(result.thread.updatedAt).toBe("2026-04-01T14:00:00.000Z");
      }
    });

    it("clears both snooze timestamps on an explicit wake", () => {
      const result = applyThreadDetailEvent(snoozedThread, {
        ...baseEventFields,
        sequence: 31,
        occurredAt: "2026-04-01T15:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsnoozed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "user",
          updatedAt: "2026-04-01T15:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.snoozedUntil).toBeNull();
        expect(result.thread.snoozedAt).toBeNull();
      }
    });

    it("clears the snooze the same way when activity woke the thread", () => {
      const result = applyThreadDetailEvent(snoozedThread, {
        ...baseEventFields,
        sequence: 32,
        occurredAt: "2026-04-01T15:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsnoozed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "activity",
          updatedAt: "2026-04-01T15:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.snoozedUntil).toBeNull();
        expect(result.thread.snoozedAt).toBeNull();
      }
    });
  });

  describe("thread.unsettled", () => {
    const settledThread: OrchestrationThread = {
      ...baseThread,
      settledOverride: "settled",
      settledAt: "2026-04-01T06:00:00.000Z",
    };

    it("pins the thread active when the user unsettled it", () => {
      const result = applyThreadDetailEvent(settledThread, {
        ...baseEventFields,
        sequence: 33,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsettled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "user",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe("active");
        expect(result.thread.settledAt).toBeNull();
      }
    });

    it("drops the override entirely when activity unsettled it", () => {
      const result = applyThreadDetailEvent(settledThread, {
        ...baseEventFields,
        sequence: 34,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsettled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason: "activity",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBeNull();
        expect(result.thread.settledAt).toBeNull();
      }
    });
  });

  describe("thread.kanban-updated", () => {
    it("replaces the kanban state without touching the thread's updatedAt", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          kanban: {
            stage: "exploration",
            cardType: "standard",
            deadline: null,
            pinned: false,
            description: null,
            keywords: [],
            classifiedAt: null,
          },
        },
        {
          ...baseEventFields,
          sequence: 35,
          occurredAt: "2026-04-01T16:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.kanban-updated",
          payload: {
            threadId: ThreadId.make("thread-1"),
            kanban: {
              stage: "final-review",
              cardType: "urgent",
              deadline: null,
              pinned: true,
              description: "Ready for review",
              keywords: ["review"],
              classifiedAt: "2026-04-01T16:00:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.kanban?.stage).toBe("final-review");
        expect(result.thread.kanban?.pinned).toBe(true);
        // Kanban placement is presentation metadata: bumping updatedAt would
        // reorder the inbox on every background classification.
        expect(result.thread.updatedAt).toBe(baseThread.updatedAt);
      }
    });
  });

  describe("thread.runtime-mode-set / thread.interaction-mode-set", () => {
    it("switches the runtime mode", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 36,
        occurredAt: "2026-04-01T17:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "approval-required",
          updatedAt: "2026-04-01T17:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.runtimeMode).toBe("approval-required");
        expect(result.thread.interactionMode).toBe(baseThread.interactionMode);
        expect(result.thread.updatedAt).toBe("2026-04-01T17:00:00.000Z");
      }
    });

    it("switches the interaction mode without disturbing the runtime mode", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 37,
        occurredAt: "2026-04-01T17:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          interactionMode: "plan",
          updatedAt: "2026-04-01T17:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.interactionMode).toBe("plan");
        expect(result.thread.runtimeMode).toBe("full-access");
      }
    });
  });

  describe("thread.turn-start-requested", () => {
    it("keeps the thread's own model when the turn carries no selection", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 38,
        occurredAt: "2026-04-01T18:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-start-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-9"),
          runtimeMode: "approval-required",
          interactionMode: "plan",
          createdAt: "2026-04-01T18:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection);
        expect(result.thread.runtimeMode).toBe("approval-required");
        expect(result.thread.interactionMode).toBe("plan");
        expect(result.thread.updatedAt).toBe("2026-04-01T18:00:00.000Z");
      }
    });

    it("adopts the model the turn was started with", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 39,
        occurredAt: "2026-04-01T18:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-start-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-9"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude"),
            model: "opus-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-04-01T18:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.modelSelection).toEqual({
          instanceId: "claude",
          model: "opus-5",
        });
      }
    });
  });

  describe("thread.turn-interrupt-requested", () => {
    const runningTurnThread: OrchestrationThread = {
      ...baseThread,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-04-01T07:00:00.000Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    };

    function interrupt(thread: OrchestrationThread, turnId: string | undefined) {
      return applyThreadDetailEvent(thread, {
        ...baseEventFields,
        sequence: 40,
        occurredAt: "2026-04-01T19:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          ...(turnId === undefined ? {} : { turnId: TurnId.make(turnId) }),
          createdAt: "2026-04-01T19:00:00.000Z",
        },
      });
    }

    it("ignores a legacy interrupt that names no turn", () => {
      expect(interrupt(runningTurnThread, undefined).kind).toBe("unchanged");
    });

    it("ignores an interrupt for a thread with no turn at all", () => {
      expect(interrupt(baseThread, "turn-1").kind).toBe("unchanged");
    });

    it("ignores an interrupt aimed at a turn that is no longer the latest", () => {
      expect(interrupt(runningTurnThread, "turn-0").kind).toBe("unchanged");
    });

    it("marks the matching turn interrupted and back-fills its missing timestamps", () => {
      const result = interrupt(runningTurnThread, "turn-1");

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn).toEqual({
          turnId: "turn-1",
          state: "interrupted",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T19:00:00.000Z",
          completedAt: "2026-04-01T19:00:00.000Z",
          assistantMessageId: null,
        });
        expect(result.thread.updatedAt).toBe("2026-04-01T19:00:00.000Z");
      }
    });

    it("does not rewrite timestamps the turn already recorded", () => {
      const result = interrupt(
        {
          ...runningTurnThread,
          latestTurn: {
            ...runningTurnThread.latestTurn!,
            startedAt: "2026-04-01T07:30:00.000Z",
            completedAt: "2026-04-01T07:45:00.000Z",
          },
        },
        "turn-1",
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.startedAt).toBe("2026-04-01T07:30:00.000Z");
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T07:45:00.000Z");
      }
    });
  });

  describe("thread.session-set settles a running turn per session status", () => {
    const runningTurnThread: OrchestrationThread = {
      ...baseThread,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-04-01T07:00:00.000Z",
        startedAt: "2026-04-01T07:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };

    function sessionSet(status: string) {
      return applyThreadDetailEvent(runningTurnThread, {
        ...baseEventFields,
        sequence: 41,
        occurredAt: "2026-04-01T20:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status,
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            lastErrorClass: null,
            updatedAt: "2026-04-01T20:00:00.000Z",
          },
        },
      } as any);
    }

    it("settles as completed when the session goes idle", () => {
      const result = sessionSet("idle");
      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("completed");
    });

    it("settles as error when the session errored", () => {
      const result = sessionSet("error");
      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("error");
    });

    it("settles as interrupted when the session was interrupted", () => {
      const result = sessionSet("interrupted");
      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("interrupted");
    });

    it("settles as interrupted when the session was stopped", () => {
      const result = sessionSet("stopped");
      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("interrupted");
    });

    it("leaves the turn running while the session is still starting", () => {
      const result = sessionSet("starting");
      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.proposed-plan-upserted", () => {
    const plan = (id: string, createdAt: string) => ({
      id,
      turnId: TurnId.make("turn-1"),
      planMarkdown: `## ${id}`,
      implementedAt: null,
      implementationThreadId: null,
      createdAt,
      updatedAt: createdAt,
    });

    it("replaces the existing revision of a plan instead of duplicating it", () => {
      const result = applyThreadDetailEvent(
        { ...baseThread, proposedPlans: [plan("plan-1", "2026-04-01T10:00:00.000Z")] },
        {
          ...baseEventFields,
          sequence: 42,
          occurredAt: "2026-04-01T10:05:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.proposed-plan-upserted",
          payload: {
            threadId: ThreadId.make("thread-1"),
            proposedPlan: {
              ...plan("plan-1", "2026-04-01T10:00:00.000Z"),
              planMarkdown: "## revised",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans).toHaveLength(1);
        expect(result.thread.proposedPlans[0]?.planMarkdown).toBe("## revised");
      }
    });

    it("orders plans by creation time, breaking ties on id", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          proposedPlans: [
            plan("plan-c", "2026-04-01T12:00:00.000Z"),
            plan("plan-b", "2026-04-01T10:00:00.000Z"),
          ],
        },
        {
          ...baseEventFields,
          sequence: 43,
          occurredAt: "2026-04-01T12:05:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.proposed-plan-upserted",
          payload: {
            threadId: ThreadId.make("thread-1"),
            proposedPlan: plan("plan-a", "2026-04-01T12:00:00.000Z"),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans.map((entry) => entry.id)).toEqual([
          "plan-b",
          "plan-a",
          "plan-c",
        ]);
      }
    });
  });

  describe("thread.turn-diff-completed edge cases", () => {
    const checkpoint = (turnId: string, turnCount: number | undefined, status: string) => ({
      turnId: TurnId.make(turnId),
      ...(turnCount === undefined ? {} : { checkpointTurnCount: turnCount }),
      checkpointRef: CheckpointRef.make(`ref-${turnId}`),
      status,
      files: [],
      assistantMessageId: MessageId.make(`msg-${turnId}`),
      completedAt: "2026-04-01T12:00:00.000Z",
    });

    function diffCompleted(thread: OrchestrationThread, payload: Record<string, unknown>) {
      return applyThreadDetailEvent(thread, {
        ...baseEventFields,
        sequence: 44,
        occurredAt: "2026-04-01T12:10:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: ThreadId.make("thread-1"),
          checkpointRef: CheckpointRef.make("ref-late"),
          files: [],
          assistantMessageId: MessageId.make("msg-late"),
          completedAt: "2026-04-01T12:10:00.000Z",
          ...payload,
        },
      } as any);
    }

    it("refuses to downgrade a ready checkpoint to missing", () => {
      const result = diffCompleted(
        { ...baseThread, checkpoints: [checkpoint("turn-1", 1, "ready")] as any },
        { turnId: TurnId.make("turn-1"), checkpointTurnCount: 1, status: "missing" },
      );

      expect(result.kind).toBe("unchanged");
    });

    it("accepts a ready checkpoint over an earlier missing one", () => {
      const result = diffCompleted(
        { ...baseThread, checkpoints: [checkpoint("turn-1", 1, "missing")] as any },
        { turnId: TurnId.make("turn-1"), checkpointTurnCount: 1, status: "ready" },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.checkpoints[0]?.status).toBe("ready");
      }
    });

    it("sorts a checkpoint with no turn count last so placeholders stay at the end", () => {
      const result = diffCompleted(
        { ...baseThread, checkpoints: [checkpoint("turn-2", undefined, "ready")] as any },
        { turnId: TurnId.make("turn-1"), checkpointTurnCount: 1, status: "ready" },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints.map((entry) => entry.turnId)).toEqual([
          "turn-1",
          "turn-2",
        ]);
      }
    });

    it("marks the turn errored when its checkpoint failed", () => {
      const result = diffCompleted(baseThread, {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        status: "error",
      });

      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("error");
    });

    it("still reports the turn completed when its checkpoint went missing", () => {
      const result = diffCompleted(baseThread, {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        status: "missing",
      });

      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("completed");
    });

    it("records a mid-turn checkpoint without settling the turn its session still runs", () => {
      const result = diffCompleted(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "running",
            requestedAt: "2026-04-01T12:00:00.000Z",
            startedAt: "2026-04-01T12:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            lastErrorClass: null,
            updatedAt: "2026-04-01T12:00:00.000Z",
          },
        },
        { turnId: TurnId.make("turn-1"), checkpointTurnCount: 1, status: "ready" },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });
  });

  describe("thread.reverted keeps turn-less and system entities", () => {
    it("drops plans and activities of reverted turns but keeps the unbound ones", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("sys-1"),
            role: "system",
            text: "Session resumed",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Response 2",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "error",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        proposedPlans: [
          {
            id: "plan-unbound",
            turnId: null,
            planMarkdown: "## imported",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: "plan-turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "## dropped",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        activities: [
          {
            id: EventId.make("activity-unbound"),
            tone: "tool",
            kind: "command",
            summary: "Imported history",
            payload: {},
            turnId: null,
            createdAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: EventId.make("activity-turn-2"),
            tone: "tool",
            kind: "command",
            summary: "Ran a command",
            payload: {},
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-04-01T03:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 45,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: { threadId: ThreadId.make("thread-1"), turnCount: 1 },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans.map((entry) => entry.id)).toEqual(["plan-unbound"]);
        expect(result.thread.activities.map((entry) => entry.id)).toEqual(["activity-unbound"]);
        // A system message survives even though its turn was reverted away.
        expect(result.thread.messages.map((entry) => entry.id)).toEqual(["sys-1"]);
        // The surviving checkpoint errored, so the turn it restores says so.
        expect(result.thread.latestTurn).toEqual({
          turnId: "turn-1",
          state: "error",
          requestedAt: "2026-04-01T02:00:00.000Z",
          startedAt: "2026-04-01T02:00:00.000Z",
          completedAt: "2026-04-01T02:00:00.000Z",
          assistantMessageId: null,
        });
      }
    });

    it("clears latestTurn when the revert leaves no checkpoint behind", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: "2026-04-01T02:00:00.000Z",
            startedAt: "2026-04-01T02:00:00.000Z",
            completedAt: "2026-04-01T02:00:00.000Z",
            assistantMessageId: null,
          },
        },
        {
          ...baseEventFields,
          sequence: 46,
          occurredAt: "2026-04-01T04:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.reverted",
          payload: { threadId: ThreadId.make("thread-1"), turnCount: 0 },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn).toBeNull();
      }
    });
  });

  describe("thread.messages-rewound drops only the turns it orphans", () => {
    it("keeps turn-less activities and plans while dropping the orphaned turn's", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "First",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Second",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "completed",
          requestedAt: "2026-04-01T02:00:00.000Z",
          startedAt: "2026-04-01T02:00:00.000Z",
          completedAt: "2026-04-01T02:00:00.000Z",
          assistantMessageId: MessageId.make("msg-2"),
        },
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-1"),
            completedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T02:00:00.000Z",
          },
        ],
        proposedPlans: [
          {
            id: "plan-unbound",
            turnId: null,
            planMarkdown: "## kept",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: "plan-turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "## dropped",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
        ],
        activities: [
          {
            id: EventId.make("activity-unbound"),
            tone: "tool",
            kind: "command",
            summary: "Imported",
            payload: {},
            turnId: null,
            createdAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: EventId.make("activity-turn-2"),
            tone: "tool",
            kind: "command",
            summary: "Dropped",
            payload: {},
            turnId: TurnId.make("turn-2"),
            createdAt: "2026-04-01T02:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 47,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.messages-rewound",
        payload: {
          threadId: ThreadId.make("thread-1"),
          fromMessageId: MessageId.make("msg-2"),
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages.map((entry) => entry.id)).toEqual(["msg-1"]);
        expect(result.thread.activities.map((entry) => entry.id)).toEqual(["activity-unbound"]);
        expect(result.thread.proposedPlans.map((entry) => entry.id)).toEqual(["plan-unbound"]);
        expect(result.thread.checkpoints.map((entry) => entry.turnId)).toEqual(["turn-1"]);
        // latestTurn pointed at the dropped turn, so it must be cleared.
        expect(result.thread.latestTurn).toBeNull();
      }
    });
  });

  describe("thread.activity-appended ordering", () => {
    const activity = (id: string, sequence: number, createdAt: string) => ({
      id: EventId.make(id),
      tone: "tool" as const,
      kind: "command",
      summary: id,
      payload: {},
      turnId: TurnId.make("turn-1"),
      sequence,
      createdAt,
    });

    function append(activities: ReadonlyArray<unknown>, appended: unknown) {
      return applyThreadDetailEvent(
        { ...baseThread, activities: activities as OrchestrationThread["activities"] },
        {
          ...baseEventFields,
          sequence: 48,
          occurredAt: "2026-04-01T11:05:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: { threadId: ThreadId.make("thread-1"), activity: appended },
        } as any,
      );
    }

    it("re-sorts when a late activity arrives out of sequence order", () => {
      const result = append(
        [
          activity("activity-1", 1, "2026-04-01T11:01:00.000Z"),
          activity("activity-3", 3, "2026-04-01T11:03:00.000Z"),
        ],
        activity("activity-2", 2, "2026-04-01T11:02:00.000Z"),
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((entry) => entry.id)).toEqual([
          "activity-1",
          "activity-2",
          "activity-3",
        ]);
      }
    });

    it("breaks a sequence tie on createdAt, then on id", () => {
      const result = append(
        [
          activity("activity-b", 1, "2026-04-01T11:02:00.000Z"),
          activity("activity-c", 1, "2026-04-01T11:01:00.000Z"),
        ],
        activity("activity-a", 1, "2026-04-01T11:01:00.000Z"),
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((entry) => entry.id)).toEqual([
          "activity-a",
          "activity-c",
          "activity-b",
        ]);
      }
    });

    it("replaces an activity that is re-sent under the same id", () => {
      const result = append([activity("activity-1", 1, "2026-04-01T11:01:00.000Z")], {
        ...activity("activity-1", 1, "2026-04-01T11:01:00.000Z"),
        summary: "Updated summary",
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.summary).toBe("Updated summary");
      }
    });
  });

  describe("thread.message-sent checkpoint rebinding", () => {
    it("rebinds only the matching turn's checkpoint to the new assistant message", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          checkpoints: [
            {
              turnId: TurnId.make("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("ref-1"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-04-01T02:00:00.000Z",
            },
            {
              turnId: TurnId.make("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: CheckpointRef.make("ref-2"),
              status: "ready",
              files: [],
              assistantMessageId: MessageId.make("msg-other"),
              completedAt: "2026-04-01T03:00:00.000Z",
            },
          ],
        },
        {
          ...baseEventFields,
          sequence: 49,
          occurredAt: "2026-04-01T04:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-sent",
          payload: {
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("msg-new"),
            role: "assistant",
            text: "Done",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T04:00:00.000Z",
            updatedAt: "2026-04-01T04:00:00.000Z",
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(
          result.thread.checkpoints.map((entry) => [entry.turnId, entry.assistantMessageId]),
        ).toEqual([
          ["turn-1", "msg-new"],
          ["turn-2", "msg-other"],
        ]);
      }
    });

    it("keeps the stored text when a non-streaming update arrives empty", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          messages: [
            {
              id: MessageId.make("msg-1"),
              role: "assistant",
              text: "Real answer",
              turnId: TurnId.make("turn-1"),
              streaming: true,
              createdAt: "2026-04-01T02:00:00.000Z",
              updatedAt: "2026-04-01T02:00:00.000Z",
            },
          ],
        },
        {
          ...baseEventFields,
          sequence: 50,
          occurredAt: "2026-04-01T04:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-sent",
          payload: {
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("msg-1"),
            role: "assistant",
            text: "",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T04:00:00.000Z",
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages[0]?.text).toBe("Real answer");
        expect(result.thread.messages[0]?.streaming).toBe(false);
        expect(result.thread.messages[0]?.updatedAt).toBe("2026-04-01T04:00:00.000Z");
      }
    });

    it("keeps an interrupted turn interrupted when its final message lands", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "interrupted",
            requestedAt: "2026-04-01T02:00:00.000Z",
            startedAt: "2026-04-01T02:00:00.000Z",
            completedAt: "2026-04-01T02:30:00.000Z",
            assistantMessageId: null,
          },
        },
        {
          ...baseEventFields,
          sequence: 51,
          occurredAt: "2026-04-01T04:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-sent",
          payload: {
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("msg-1"),
            role: "assistant",
            text: "Partial",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T04:00:00.000Z",
          },
        },
      );

      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("interrupted");
    });

    it("keeps an errored turn errored when its final message lands", () => {
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          latestTurn: {
            turnId: TurnId.make("turn-1"),
            state: "error",
            requestedAt: "2026-04-01T02:00:00.000Z",
            startedAt: "2026-04-01T02:00:00.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
        },
        {
          ...baseEventFields,
          sequence: 52,
          occurredAt: "2026-04-01T04:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-sent",
          payload: {
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("msg-1"),
            role: "assistant",
            text: "Failed",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T04:00:00.000Z",
          },
        },
      );

      expect(result.kind === "updated" && result.thread.latestTurn?.state).toBe("error");
    });

    it("leaves latestTurn alone for a message belonging to an older turn", () => {
      const latestTurn = {
        turnId: TurnId.make("turn-2"),
        state: "running" as const,
        requestedAt: "2026-04-01T03:00:00.000Z",
        startedAt: "2026-04-01T03:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      };
      const result = applyThreadDetailEvent(
        { ...baseThread, latestTurn },
        {
          ...baseEventFields,
          sequence: 53,
          occurredAt: "2026-04-01T04:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.message-sent",
          payload: {
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("msg-old"),
            role: "assistant",
            text: "Late arrival",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn).toEqual(latestTurn);
      }
    });
  });
});
