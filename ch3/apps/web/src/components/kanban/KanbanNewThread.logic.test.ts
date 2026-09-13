import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@ch3tools/contracts";
import { createModelSelection } from "@ch3tools/shared/model";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
import { describe, expect, it } from "vite-plus/test";

import { KANBAN_COLUMNS } from "./kanbanConfig";
import {
  buildKanbanNewThreadPlacement,
  buildKanbanNewThreadTurnStart,
  defaultKanbanDeadlineDate,
  kanbanDeadlineFromDate,
  kanbanNewThreadSeedModel,
  kanbanNewThreadTitle,
  resolveKanbanNewThreadStages,
} from "./KanbanNewThread.logic";

describe("a new thread from the Kanban board", () => {
  it("opens on the default model, never on what the project last ran", () => {
    // The bug: a project that had once been used on Fable offered Fable as
    // the default for every new thread started from the board.
    expect(kanbanNewThreadSeedModel().model).toBe("claude-sonnet-5");
  });

  it("offers the stages and never the derived ends of the board", () => {
    expect(resolveKanbanNewThreadStages(KANBAN_COLUMNS).map((column) => column.id)).toEqual([
      "exploration",
      "move-along",
      "full-attention",
      "decision-needed",
      "final-review",
    ]);
  });

  it("titles the thread from its prompt, one line, bounded", () => {
    expect(kanbanNewThreadTitle("  Fix the\n\nlogin   bug ")).toBe("Fix the login bug");
    // `truncate` appends an ellipsis past the bound.
    expect(kanbanNewThreadTitle("x".repeat(200)).length).toBeLessThanOrEqual(75);
    expect(kanbanNewThreadTitle("   ")).toBe("New thread");
  });

  it("creates the thread and sends the prompt in one turn start", () => {
    const start = buildKanbanNewThreadTurnStart({
      threadId: ThreadId.make("t1"),
      messageId: MessageId.make("m1"),
      projectId: ProjectId.make("p1"),
      prompt: "  Ship the thing  ",
      modelSelection: createModelSelection(
        defaultInstanceIdForDriver(ProviderDriverKind.make(CLAUDE_DRIVER_KIND)),
        "claude-opus-5",
      ),
      newThreadModes: { runtimeMode: "full-access", interactionMode: "default" },
      createdAt: "2026-08-29T10:00:00.000Z",
    });
    expect(start.message).toEqual({
      messageId: "m1",
      role: "user",
      text: "Ship the thing",
      attachments: [],
    });
    expect(start.titleSeed).toBe("Ship the thing");
    expect(start.bootstrap.createThread).toMatchObject({
      projectId: "p1",
      title: "Ship the thing",
      branch: null,
      worktreePath: null,
      createdAt: "2026-08-29T10:00:00.000Z",
    });
    // A card started from the board is a conversation like any other: it opens
    // on the configured new-thread modes. This used to hardcode the shipped
    // ones and ignore Settings entirely.
    expect(start.runtimeMode).toBe("full-access");
    expect(start.bootstrap.createThread.runtimeMode).toBe("full-access");
  });

  it("carries a deadline only with the deadline priority, as the card stores it", () => {
    expect(
      buildKanbanNewThreadPlacement({
        threadId: ThreadId.make("t1"),
        stage: "exploration",
        cardType: "deadline",
        deadlineDate: "2026-09-05",
      }),
    ).toMatchObject({ cardType: "deadline", deadline: "2026-09-05T12:00:00.000Z" });
    // Another priority with a date left over from switching: no deadline sent.
    expect(
      buildKanbanNewThreadPlacement({
        threadId: ThreadId.make("t1"),
        stage: "exploration",
        cardType: "standard",
        deadlineDate: "2026-09-05",
      }),
    ).not.toHaveProperty("deadline");
    expect(kanbanDeadlineFromDate("not a date")).toBeNull();
    expect(defaultKanbanDeadlineDate(Date.UTC(2026, 7, 29, 12))).toBe("2026-09-05");
  });

  it("pins the card where the person filed it", () => {
    expect(
      buildKanbanNewThreadPlacement({
        threadId: ThreadId.make("t1"),
        stage: "decision-needed",
        cardType: "urgent",
      }),
    ).toEqual({
      threadId: "t1",
      stage: "decision-needed",
      cardType: "urgent",
      pinned: true,
      source: "user",
    });
  });
});
