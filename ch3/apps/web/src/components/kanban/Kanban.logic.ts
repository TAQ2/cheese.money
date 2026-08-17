/**
 * Pure board math for Kanban mode: column derivation, the two-lane split
 * (user on top, agent diving below), WIP limits, and move planning.
 *
 * Everything here is pure so it unit-tests without a DOM (repo convention:
 * sibling .logic.ts files carry the behavior, components stay thin).
 */
import { effectiveSettled, effectiveSnoozed } from "@ch3tools/client-runtime/state/thread-settled";
import type { KanbanCardType } from "@ch3tools/contracts";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarV2Status } from "../Sidebar.logic";
import {
  DEFAULT_KANBAN_CARD_TYPE,
  KANBAN_CARD_TYPES,
  KANBAN_COLUMNS,
  kanbanCardTypeConfig,
  kanbanColumnConfig,
  type KanbanCardTypeConfig,
  type KanbanColumnConfig,
  type KanbanColumnId,
} from "./kanbanConfig";

export interface KanbanBoardSettings {
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  /** Per-column overrides from client settings; null = explicitly unlimited. */
  readonly wipLimits: Readonly<Record<string, number | null>>;
  /** Scoped thread keys (environmentId:threadId) with a terminal subprocess
      running — an orchestration script counts as the agent still working,
      even when no conversation session is streaming. */
  readonly runningTerminalThreadKeys?: ReadonlySet<string>;
  /** The live column list (built-ins + user-created). Defaults to the
      built-ins so callers without custom columns need no ceremony. */
  readonly columns?: ReadonlyArray<KanbanColumnConfig>;
  /** The live card-type list (built-ins + user-created). */
  readonly cardTypes?: ReadonlyArray<KanbanCardTypeConfig>;
}

export function kanbanCardTypesOf(
  settings: KanbanBoardSettings,
): ReadonlyArray<KanbanCardTypeConfig> {
  return settings.cardTypes ?? KANBAN_CARD_TYPES;
}

export function kanbanColumnsOf(settings: KanbanBoardSettings): ReadonlyArray<KanbanColumnConfig> {
  return settings.columns ?? KANBAN_COLUMNS;
}

export interface KanbanFilters {
  readonly cardType: KanbanCardType | "all";
  readonly projectKey: string | "all";
}

export const KANBAN_ALL_FILTERS: KanbanFilters = { cardType: "all", projectKey: "all" };

export function kanbanProjectKey(thread: SidebarThreadSummary): string {
  return `${thread.environmentId}:${thread.projectId}`;
}

export function kanbanThreadKey(thread: SidebarThreadSummary): string {
  return `${thread.environmentId}:${thread.id}`;
}

export function kanbanCardType(thread: SidebarThreadSummary): KanbanCardType {
  return thread.kanban?.cardType ?? DEFAULT_KANBAN_CARD_TYPE;
}

/**
 * Where a card sits on the x-axis. Snoozed and settled are derived from the
 * existing lifecycle (snooze outranks settled, mirroring the inbox); the
 * stored stage covers the middle. A never-classified thread starts in
 * exploration — unless it is already blocked on the user, which is the
 * spec's hard rule for the decision column.
 */
export function resolveKanbanColumn(
  thread: SidebarThreadSummary,
  settings: KanbanBoardSettings,
): KanbanColumnId {
  if (effectiveSnoozed(thread, { now: settings.now })) {
    return "snoozed";
  }
  if (
    effectiveSettled(thread, {
      now: settings.now,
      autoSettleAfterDays: settings.autoSettleAfterDays,
    })
  ) {
    return "settled";
  }
  const stage = thread.kanban?.stage;
  if (stage != null) {
    // A stage whose column was deleted falls back to Exploration instead of
    // rendering the card into an invisible nowhere.
    return kanbanColumnsOf(settings).some((column) => column.id === stage) ? stage : "exploration";
  }
  const status = resolveSidebarV2Status(thread);
  if (status === "approval" || status === "input") {
    return "decision-needed";
  }
  return "exploration";
}

/**
 * Whether the thread carries an ownership lease that has not yet lapsed.
 *
 * An absent or malformed expiry is "no lease" rather than an error: the lane
 * is a display decision, and a card silently stuck on the wrong side is worse
 * than one that simply falls back to its execution signals.
 */
export function isAgentWorkingLeaseActive(
  thread: SidebarThreadSummary,
  nowMs: number = Date.now(),
): boolean {
  const until = thread.kanban?.agentWorkingUntil;
  if (!until) return false;
  const expiresAtMs = Date.parse(until);
  return Number.isNaN(expiresAtMs) ? false : expiresAtMs > nowMs;
}

/**
 * The y-axis: a conversation dips into the agent lane while the agent works
 * and re-emerges to the user lane when it finishes (or needs the user).
 *
 * A running terminal subprocess (an orchestration script driving the thread)
 * keeps the card submerged even when the conversation itself is idle — the
 * AI is still working, just not through the chat session. Blocked-on-you
 * always outranks both: a pending approval or input request must surface.
 */
export function resolveKanbanLane(
  thread: SidebarThreadSummary,
  options?: { readonly hasRunningTerminal?: boolean; readonly nowMs?: number },
): "user" | "agent" {
  const status = resolveSidebarV2Status(thread);
  if (status === "approval" || status === "input") {
    return "user";
  }
  // An unexpired ownership lease outranks every execution signal below it.
  // Work launched detached — `nohup ... & disown`, tmux, a queued CI run —
  // reparents to pid 1 and holds no terminal, so subprocess inspection sees
  // nothing and the session reads idle between the agent's polls: the card
  // dropped into the human lane while the run was still going. Only the
  // launcher knows, so it says so, and this believes it until the lease
  // lapses. Checked AFTER the blocked-on-a-human cases, never before — a
  // thread waiting on an approval belongs to the user, lease or no lease.
  if (isAgentWorkingLeaseActive(thread, options?.nowMs)) {
    return "agent";
  }
  if (status === "working") {
    return "agent";
  }
  // A turn still in flight means the AI is working, whatever the session says.
  // The two disagree while a turn is driving sub-agents: the parent blocks on
  // the sub-agent's tool call, the session stops reporting itself as running,
  // and the card surfaced into the user's lane as though it were waiting on a
  // human — while the agent was busy the whole time.
  if (thread.latestTurn?.state === "running") {
    return "agent";
  }
  return options?.hasRunningTerminal === true ? "agent" : "user";
}

export function resolveWipLimit(
  columnId: KanbanColumnId,
  wipLimits: KanbanBoardSettings["wipLimits"],
  columns: ReadonlyArray<KanbanColumnConfig> = KANBAN_COLUMNS,
): number | null {
  // Snoozed and Settled are derived holding areas, not flow stages: a WIP
  // limit there is meaningless and would only demote cards to "waiting".
  if (columnId === "snoozed" || columnId === "settled") {
    return null;
  }
  const limit =
    columnId in wipLimits
      ? (wipLimits[columnId] ?? null)
      : kanbanColumnConfig(columnId, columns).defaultWipLimit;
  // A hand-edited settings file can carry 0 or negatives; a WIP limit below 1
  // would make the column permanently unenterable.
  return limit === null ? null : Math.max(1, limit);
}

/** Who rises into a freed WIP slot first: urgency class, then age. */
export function compareRisePriority(
  a: SidebarThreadSummary,
  b: SidebarThreadSummary,
  cardTypes: ReadonlyArray<KanbanCardTypeConfig> = KANBAN_CARD_TYPES,
): number {
  const byType =
    (kanbanCardTypeConfig(kanbanCardType(a), cardTypes).risePriority ?? 2.5) -
    (kanbanCardTypeConfig(kanbanCardType(b), cardTypes).risePriority ?? 2.5);
  if (byType !== 0) {
    return byType;
  }
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
}

export interface KanbanColumnCells {
  readonly columnId: KanbanColumnId;
  readonly limit: number | null;
  /** Cards on the user lane, capped at the WIP limit. */
  readonly userCards: ReadonlyArray<SidebarThreadSummary>;
  /** Cards diving in the agent lane (a session is running). */
  readonly agentCards: ReadonlyArray<SidebarThreadSummary>;
  /** Finished cards held below the lane because the column is at its limit;
      they rise automatically when a slot frees. */
  readonly waitingCards: ReadonlyArray<SidebarThreadSummary>;
}

export function buildKanbanBoard(
  threads: ReadonlyArray<SidebarThreadSummary>,
  settings: KanbanBoardSettings,
  filters: KanbanFilters,
): ReadonlyArray<KanbanColumnCells> {
  const visible = threads.filter(
    (thread) =>
      thread.archivedAt == null &&
      (filters.cardType === "all" || kanbanCardType(thread) === filters.cardType) &&
      (filters.projectKey === "all" || kanbanProjectKey(thread) === filters.projectKey),
  );
  return kanbanColumnsOf(settings).map((column) => {
    const inColumn = visible.filter(
      (thread) => resolveKanbanColumn(thread, settings) === column.id,
    );
    const laneOf = (thread: SidebarThreadSummary) =>
      resolveKanbanLane(thread, {
        hasRunningTerminal:
          settings.runningTerminalThreadKeys?.has(kanbanThreadKey(thread)) === true,
      });
    const agentCards = inColumn.filter((thread) => laneOf(thread) === "agent");
    const finished = inColumn
      .filter((thread) => laneOf(thread) === "user")
      .toSorted((a, b) => compareRisePriority(a, b, kanbanCardTypesOf(settings)));
    const limit = resolveWipLimit(column.id, settings.wipLimits, kanbanColumnsOf(settings));
    return {
      columnId: column.id,
      limit,
      userCards: limit === null ? finished : finished.slice(0, limit),
      agentCards,
      waitingCards: limit === null ? [] : finished.slice(limit),
    };
  });
}

export function adjacentKanbanColumn(
  columnId: KanbanColumnId,
  direction: -1 | 1,
  columns: ReadonlyArray<KanbanColumnConfig> = KANBAN_COLUMNS,
): KanbanColumnId | null {
  const index = columns.findIndex((column) => column.id === columnId);
  if (index === -1) {
    return null;
  }
  const next = columns[index + direction];
  return next?.id ?? null;
}

export type KanbanMovePlan =
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "move";
      /** When an urgent card enters a full column, this card is displaced
          one column to the left to make room. */
      readonly pushThread?: SidebarThreadSummary;
    };

/**
 * WIP protection: a full column rejects entry — unless the entering card's
 * type pushes through, in which case the newest non-urgent card on the user
 * lane is displaced one column to the left.
 */
export function planKanbanMove(input: {
  readonly card: SidebarThreadSummary;
  readonly from: KanbanColumnId;
  readonly target: KanbanColumnId;
  readonly board: ReadonlyArray<KanbanColumnCells>;
  readonly columns?: ReadonlyArray<KanbanColumnConfig>;
  readonly cardTypes?: ReadonlyArray<KanbanCardTypeConfig>;
}): KanbanMovePlan {
  if (input.target === input.from) {
    return { kind: "blocked", reason: "" };
  }
  const cell = input.board.find((entry) => entry.columnId === input.target);
  if (!cell || cell.limit === null || cell.userCards.length < cell.limit) {
    return { kind: "move" };
  }
  const type = kanbanCardTypeConfig(kanbanCardType(input.card), input.cardTypes);
  if (type.pushesThroughWip === true) {
    // Never displace an urgent peer or a card the user pinned by hand — a
    // manual placement outranks even the expedite lane.
    const displaced = cell.userCards
      .filter(
        (thread) =>
          kanbanCardTypeConfig(kanbanCardType(thread), input.cardTypes).pushesThroughWip !== true &&
          thread.kanban?.pinned !== true,
      )
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (displaced) {
      return { kind: "move", pushThread: displaced };
    }
    return {
      kind: "blocked",
      reason: "Every card in the column is urgent or pinned — nothing can be displaced.",
    };
  }
  return {
    kind: "blocked",
    reason: `${kanbanColumnConfig(input.target, input.columns).label} is at its WIP limit (${cell.limit}). Finish something first — or expedite this card.`,
  };
}

/**
 * Where a displaced card lands: the column immediately left of the full one,
 * clamped to exploration — a push can force work backwards, never into
 * snooze or off the board.
 */
export function kanbanPushTarget(
  fullColumn: KanbanColumnId,
  columns: ReadonlyArray<KanbanColumnConfig> = KANBAN_COLUMNS,
): KanbanColumnId {
  const left = adjacentKanbanColumn(fullColumn, -1, columns);
  return left === null || left === "snoozed" ? "exploration" : left;
}
