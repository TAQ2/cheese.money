import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadKanbanState,
} from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import {
  buildKanbanBoard,
  adjacentKanbanColumn,
  kanbanPushTarget,
  planKanbanMove,
  resolveKanbanColumn,
  resolveKanbanLane,
  resolveWipLimit,
  type KanbanBoardSettings,
} from "./Kanban.logic";
import { resolveKanbanColumns } from "./kanbanConfig";

const NOW = "2026-08-13T12:00:00.000Z";
const SETTINGS: KanbanBoardSettings = { now: NOW, autoSettleAfterDays: null, wipLimits: {} };

let threadCounter = 0;
function makeThread(input: {
  readonly kanban?: Partial<ThreadKanbanState>;
  readonly snoozedUntil?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly sessionStatus?: "running" | "starting" | "ready" | null;
  readonly hasPendingUserInput?: boolean;
  readonly hasPendingApprovals?: boolean;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
  readonly projectId?: string;
}): SidebarThreadSummary {
  threadCounter += 1;
  const threadId = ThreadId.make(`thread-${threadCounter}`);
  return {
    id: threadId,
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make(input.projectId ?? "project-1"),
    title: `Thread ${threadCounter}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: input.updatedAt ?? NOW,
    archivedAt: input.archivedAt ?? null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === "settled" ? NOW : null,
    snoozedUntil: input.snoozedUntil ?? null,
    snoozedAt: input.snoozedUntil != null ? NOW : null,
    kanban:
      input.kanban === undefined
        ? null
        : {
            stage: null,
            cardType: null,
            deadline: null,
            pinned: false,
            description: null,
            keywords: [],
            classifiedAt: null,
            ...input.kanban,
          },
    session:
      input.sessionStatus == null
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
    latestUserMessageAt: null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
  };
}

describe("resolveKanbanColumn", () => {
  it("derives snoozed from the snooze overlay, outranking a stored stage", () => {
    const thread = makeThread({
      snoozedUntil: "2026-08-20T09:00:00.000Z",
      kanban: { stage: "final-review" },
    });
    expect(resolveKanbanColumn(thread, SETTINGS)).toBe("snoozed");
  });

  it("derives settled from the settle override", () => {
    const thread = makeThread({ settledOverride: "settled", kanban: { stage: "exploration" } });
    expect(resolveKanbanColumn(thread, SETTINGS)).toBe("settled");
  });

  it("uses the stored stage for active threads", () => {
    const thread = makeThread({ kanban: { stage: "full-attention" } });
    expect(resolveKanbanColumn(thread, SETTINGS)).toBe("full-attention");
  });

  it("routes never-classified blocked-on-you work to decision-needed", () => {
    const thread = makeThread({ hasPendingUserInput: true });
    expect(resolveKanbanColumn(thread, SETTINGS)).toBe("decision-needed");
  });

  it("starts never-classified idle threads in exploration", () => {
    expect(resolveKanbanColumn(makeThread({}), SETTINGS)).toBe("exploration");
  });
});

describe("resolveKanbanLane", () => {
  it("dips a running conversation into the agent lane", () => {
    expect(resolveKanbanLane(makeThread({ sessionStatus: "running" }))).toBe("agent");
  });

  it("re-emerges to the user lane when the agent is done", () => {
    expect(resolveKanbanLane(makeThread({ sessionStatus: "ready" }))).toBe("user");
  });

  it("keeps blocked-on-you work in the user lane even mid-session", () => {
    const thread = makeThread({ sessionStatus: "running", hasPendingApprovals: true });
    expect(resolveKanbanLane(thread)).toBe("user");
  });

  it("keeps a card submerged while its terminal runs an orchestration script", () => {
    const thread = makeThread({ sessionStatus: "ready" });
    expect(resolveKanbanLane(thread, { hasRunningTerminal: true })).toBe("agent");
    expect(resolveKanbanLane(makeThread({}), { hasRunningTerminal: true })).toBe("agent");
  });

  it("surfaces blocked-on-you work even while a terminal runs", () => {
    const thread = makeThread({ hasPendingUserInput: true });
    expect(resolveKanbanLane(thread, { hasRunningTerminal: true })).toBe("user");
  });
});

describe("terminal-submerged board placement", () => {
  it("puts terminal-running threads in the agent strip of their column", () => {
    const thread = makeThread({ kanban: { stage: "move-along" } });
    const board = buildKanbanBoard(
      [thread],
      {
        ...SETTINGS,
        runningTerminalThreadKeys: new Set([`${thread.environmentId}:${thread.id}`]),
      },
      { cardType: "all", projectKey: "all" },
    );
    const cell = board.find((entry) => entry.columnId === "move-along")!;
    expect(cell.agentCards.map((entry) => entry.id)).toEqual([thread.id]);
    expect(cell.userCards).toEqual([]);
  });
});

describe("WIP limits", () => {
  it("falls back to column defaults, honors overrides including explicit unlimited", () => {
    expect(resolveWipLimit("decision-needed", {})).toBe(1);
    expect(resolveWipLimit("exploration", {})).toBeNull();
    expect(resolveWipLimit("decision-needed", { "decision-needed": 4 })).toBe(4);
    expect(resolveWipLimit("decision-needed", { "decision-needed": null })).toBeNull();
  });

  it("holds finished cards below a full column, urgency rising first", () => {
    const older = makeThread({
      kanban: { stage: "decision-needed" },
      updatedAt: "2026-08-13T08:00:00.000Z",
    });
    const urgent = makeThread({
      kanban: { stage: "decision-needed", cardType: "urgent" },
      updatedAt: "2026-08-13T11:00:00.000Z",
    });
    const board = buildKanbanBoard([older, urgent], SETTINGS, {
      cardType: "all",
      projectKey: "all",
    });
    const cell = board.find((entry) => entry.columnId === "decision-needed")!;
    expect(cell.limit).toBe(1);
    expect(cell.userCards.map((thread) => thread.id)).toEqual([urgent.id]);
    expect(cell.waitingCards.map((thread) => thread.id)).toEqual([older.id]);
  });
});

describe("planKanbanMove", () => {
  const occupant = makeThread({ kanban: { stage: "decision-needed" } });
  const board = buildKanbanBoard([occupant], SETTINGS, { cardType: "all", projectKey: "all" });

  it("blocks a standard card from entering a full column", () => {
    const card = makeThread({ kanban: { stage: "exploration" } });
    const plan = planKanbanMove({ card, from: "exploration", target: "decision-needed", board });
    expect(plan.kind).toBe("blocked");
  });

  it("lets an urgent card push the newest non-urgent occupant out", () => {
    const card = makeThread({ kanban: { stage: "exploration", cardType: "urgent" } });
    const plan = planKanbanMove({ card, from: "exploration", target: "decision-needed", board });
    expect(plan).toEqual({ kind: "move", pushThread: occupant });
  });

  it("never displaces a pinned card, even for urgent work", () => {
    const pinnedOccupant = makeThread({ kanban: { stage: "decision-needed", pinned: true } });
    const pinnedBoard = buildKanbanBoard([pinnedOccupant], SETTINGS, {
      cardType: "all",
      projectKey: "all",
    });
    const card = makeThread({ kanban: { stage: "exploration", cardType: "urgent" } });
    const plan = planKanbanMove({
      card,
      from: "exploration",
      target: "decision-needed",
      board: pinnedBoard,
    });
    expect(plan.kind).toBe("blocked");
  });

  it("allows moves into columns with room or without limits", () => {
    const card = makeThread({});
    expect(planKanbanMove({ card, from: "exploration", target: "final-review", board }).kind).toBe(
      "move",
    );
  });
});

describe("board geometry", () => {
  it("walks columns left and right with edges clamped", () => {
    expect(adjacentKanbanColumn("snoozed", -1)).toBeNull();
    expect(adjacentKanbanColumn("snoozed", 1)).toBe("exploration");
    expect(adjacentKanbanColumn("settled", 1)).toBeNull();
  });

  it("pushes displaced cards left but never into snooze", () => {
    expect(kanbanPushTarget("decision-needed")).toBe("full-attention");
    expect(kanbanPushTarget("exploration")).toBe("exploration");
  });
});

describe("column order resolution", () => {
  const custom = [{ id: "custom-a", label: "A", accent: "#818cf8" }];

  it("defaults customs to just before Final review", () => {
    const ids = resolveKanbanColumns(custom).map((entry) => entry.id);
    expect(ids).toEqual([
      "snoozed",
      "exploration",
      "move-along",
      "full-attention",
      "decision-needed",
      "custom-a",
      "final-review",
      "settled",
    ]);
  });

  it("applies a saved order and pins the derived endpoints", () => {
    const ids = resolveKanbanColumns(custom, [
      "settled",
      "custom-a",
      "exploration",
      "snoozed",
      "move-along",
      "full-attention",
      "decision-needed",
      "final-review",
    ]).map((entry) => entry.id);
    expect(ids[0]).toBe("snoozed");
    expect(ids.at(-1)).toBe("settled");
    expect(ids.indexOf("custom-a")).toBeLessThan(ids.indexOf("exploration"));
  });

  it("drops unknown ids and re-seats columns the order does not mention", () => {
    const ids = resolveKanbanColumns(custom, [
      "snoozed",
      "exploration",
      "custom-a",
      "custom-deleted",
      "move-along",
      "decision-needed",
      "final-review",
      "settled",
    ]).map((entry) => entry.id);
    expect(ids).not.toContain("custom-deleted");
    // full-attention was absent from the saved order: it keeps its default
    // seat after move-along.
    expect(ids.indexOf("full-attention")).toBe(ids.indexOf("move-along") + 1);
    expect(ids.indexOf("custom-a")).toBe(ids.indexOf("exploration") + 1);
  });
});
