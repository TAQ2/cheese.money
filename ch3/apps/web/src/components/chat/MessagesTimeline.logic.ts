import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@ch3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
      /**
       * The turn's fold, repeated under its terminal assistant message so the
       * "Worked for ..." control is reachable without scrolling back up past a
       * long reply. Same turn, same label, same toggle as the header row.
       */
      assistantTurnFold?: MessagesTimelineTurnFold | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      runningAgents: ReadonlyArray<RunningAgentIndicator>;
    }
  | {
      kind: "agent-roster";
      id: string;
      agents: ReadonlyArray<AgentRosterItem>;
    };

/** A settled turn's fold, as both the header row and the footer control read it. */
export interface MessagesTimelineTurnFold {
  readonly turnId: TurnId;
  readonly label: string;
  readonly expanded: boolean;
}

/**
 * One subagent's rolling roster line, persisted for the thread's life:
 * its task label, the model it was given (when the Task input names one),
 * when it started, and — once finished — when it ended.
 */
export interface AgentRosterItem {
  readonly id: string;
  readonly label: string;
  readonly model: string | null;
  readonly startedAt: string;
  /** Null while the agent is still running. */
  readonly endedAt: string | null;
  readonly status: "running" | "done" | "failed";
  /** What the agent is doing right now (background agents report this). */
  readonly step?: string;
  /** Runtime-reported elapsed milliseconds, when the agent reports usage. */
  readonly durationMs?: number;
}

/** One thread activity, as the read model carries it. */
export interface AgentRosterActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly turnId: string | null;
  readonly createdAt: string;
}

/**
 * Live subagents.
 *
 * Two sources, because the runtime reports the two kinds of delegation
 * differently:
 *
 * 1. Background agents emit `task.started` / `task.progress` /
 *    `task.completed` activities carrying a stable `taskId`, the task text,
 *    the current step, and an authoritative `usage.duration_ms`. These
 *    outlive their turn, so started-without-completed is the only sound
 *    liveness test — "the assistant spoke since" is not (it wrongly buried
 *    agents that were still working).
 * 2. Foreground delegations only appear as `collab_agent_tool_call` work
 *    entries and can only run inside their own turn, so they count as live
 *    exactly while that turn is the running one.
 */
export function deriveAgentRoster(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  runningTurnId: TurnId | null = null,
  options: {
    readonly dismissedAgentIds?: ReadonlySet<string>;
    readonly activities?: ReadonlyArray<AgentRosterActivity>;
  } = {},
): AgentRosterItem[] {
  const dismissed = options.dismissedAgentIds;
  const roster: AgentRosterItem[] = [];
  const seenLabels = new Set<string>();

  interface TaskAccumulator {
    label: string;
    step: string | null;
    startedAt: string;
    latestAt: string;
    durationMs: number | null;
    completed: boolean;
  }
  const readString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  const byTaskId = new Map<string, TaskAccumulator>();
  for (const activity of options.activities ?? []) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const payload = activity.payload as
      | {
          taskId?: unknown;
          title?: unknown;
          detail?: unknown;
          usage?: { duration_ms?: unknown };
        }
      | undefined;
    const taskId = readString(payload?.taskId);
    if (taskId === null) continue;
    const detail = readString(payload?.detail);
    const title = readString(payload?.title);
    const durationMs =
      typeof payload?.usage?.duration_ms === "number" ? payload.usage.duration_ms : null;
    const existing = byTaskId.get(taskId);
    if (!existing) {
      byTaskId.set(taskId, {
        // task.started's detail is the task itself; progress rows overwrite
        // detail with the current step, so the first one seen wins.
        label: detail ?? title ?? "Subagent",
        step: activity.kind === "task.progress" ? (title ?? detail) : null,
        startedAt: activity.createdAt,
        latestAt: activity.createdAt,
        durationMs,
        completed: activity.kind === "task.completed",
      });
      continue;
    }
    if (activity.createdAt < existing.startedAt) {
      existing.startedAt = activity.createdAt;
    }
    if (activity.createdAt >= existing.latestAt) {
      existing.latestAt = activity.createdAt;
      if (activity.kind === "task.progress") {
        existing.step = title ?? detail;
      }
      if (durationMs !== null) {
        existing.durationMs = durationMs;
      }
    }
    if (activity.kind === "task.completed") {
      existing.completed = true;
    }
    if (activity.kind === "task.started" && detail !== null) {
      existing.label = detail;
    }
  }
  // The task feed carries no model; the Task tool call that spawned the
  // agent does, and its `detail` matches the task label (optionally behind
  // a "<subagent_type>: " prefix).
  const modelByLabel = new Map<string, string>();
  for (const entry of timelineEntries) {
    if (entry.kind !== "work") continue;
    const work = entry.entry;
    if (work.itemType !== "collab_agent_tool_call") continue;
    const model = work.agentModel ?? null;
    const detailText = (work.detail ?? "").trim();
    if (model === null || detailText.length === 0) continue;
    modelByLabel.set(detailText, model);
    const separator = detailText.indexOf(": ");
    if (separator > 0) {
      modelByLabel.set(detailText.slice(separator + 2), model);
    }
  }
  for (const [taskId, task] of byTaskId) {
    if (task.completed) continue;
    if (dismissed?.has(taskId)) continue;
    seenLabels.add(task.label);
    roster.push({
      id: taskId,
      label: task.label,
      model: modelByLabel.get(task.label) ?? null,
      startedAt: task.startedAt,
      endedAt: null,
      status: "running" as const,
      ...(task.step !== null ? { step: task.step } : {}),
      ...(task.durationMs !== null ? { durationMs: task.durationMs } : {}),
    });
  }

  // Foreground delegations: live only inside their own running turn.
  if (runningTurnId !== null) {
    interface ToolAccumulator {
      label: string;
      model: string | null;
      startedAt: string;
      latestAt: string;
      latestStatus: NonNullable<WorkLogEntry["toolLifecycleStatus"]> | null;
    }
    const byAgent = new Map<string, ToolAccumulator>();
    for (const entry of timelineEntries) {
      if (entry.kind !== "work") continue;
      const work = entry.entry;
      if (work.itemType !== "collab_agent_tool_call") continue;
      const turnId = work.turnId !== undefined && work.turnId !== null ? String(work.turnId) : null;
      if (turnId !== String(runningTurnId)) continue;
      const detailText = (work.detail ?? "").trim();
      // "Agent: {}" is the pre-stream placeholder — it identifies nothing.
      const hasRealDetail = detailText.length > 0 && !/[:] ?\{/.test(detailText);
      if (!hasRealDetail && work.toolLifecycleStatus === undefined) continue;
      const label = hasRealDetail
        ? detailText
        : (work.toolTitle ?? work.label).trim() || "Subagent";
      const model = work.agentModel ?? null;
      const key = work.toolCallId ?? `${turnId}:${label}`;
      const startedAt = work.firstCreatedAt ?? work.createdAt;
      const existing = byAgent.get(key);
      if (!existing) {
        byAgent.set(key, {
          label,
          model,
          startedAt,
          latestAt: work.createdAt,
          latestStatus: work.toolLifecycleStatus ?? null,
        });
        continue;
      }
      if (startedAt < existing.startedAt) existing.startedAt = startedAt;
      if (work.createdAt >= existing.latestAt) {
        existing.latestAt = work.createdAt;
        if (work.toolLifecycleStatus !== undefined) {
          existing.latestStatus = work.toolLifecycleStatus;
        }
      }
      if (existing.model === null && model !== null) existing.model = model;
      if (hasRealDetail) existing.label = label;
    }
    for (const [key, agent] of byAgent) {
      if (agent.latestStatus !== "inProgress" && agent.latestStatus !== null) continue;
      if (dismissed?.has(key)) continue;
      // The same delegation can surface in both sources; the task feed wins.
      if (seenLabels.has(agent.label)) continue;
      roster.push({
        id: key,
        label: agent.label,
        model: agent.model,
        startedAt: agent.startedAt,
        endedAt: null,
        status: "running" as const,
      });
    }
  }
  return roster;
}

/**
 * A subagent (collab agent tool call) still in flight during the active
 * turn. Derived from the same work-log entries the timeline already renders,
 * so count and start times can never disagree with the log itself.
 */
export interface RunningAgentIndicator {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
}

export function deriveRunningAgentIndicators(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  runningTurnId: TurnId | null,
): RunningAgentIndicator[] {
  return deriveAgentRoster(timelineEntries, runningTurnId)
    .filter((agent) => agent.status === "running")
    .map((agent) => ({ id: agent.id, label: agent.label, startedAt: agent.startedAt }));
}

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
  /** The turn's terminal assistant message — the fold's second anchor. */
  terminalMessageId: string | null;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id !== group.terminalEntry?.id) {
        hiddenEntryIds.add(entry.id);
      }
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
      terminalMessageId: group.terminalEntry?.message.id ?? null,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  /** Roster lines the user dismissed with the row's close control. */
  dismissedAgentIds?: ReadonlySet<string>;
  /** Thread activities — the background-agent task feed lives here. */
  threadActivities?: ReadonlyArray<AgentRosterActivity>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  const foldByTerminalMessageId = new Map<string, MessagesTimelineTurnFold>();
  for (const fold of foldsByAnchorEntryId.values()) {
    const expanded = input.expandedTurnIds?.has(fold.turnId) ?? false;
    if (!expanded) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
    if (fold.terminalMessageId !== null) {
      foldByTerminalMessageId.set(fold.terminalMessageId, {
        turnId: fold.turnId,
        label: fold.label,
        expanded,
      });
    }
  }

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const visibleEntries = visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
          const renderedEntries = expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: hiddenEntries.length,
            expanded,
            onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry)),
          });
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
      // Only the metadata row carries it; a message rendered without that row
      // (commentary, or a turn still in flight) has no footer to hang it on.
      assistantTurnFold: showAssistantMeta
        ? foldByTerminalMessageId.get(timelineEntry.message.id)
        : undefined,
    });
  }

  // Subagents launched near the end of a turn keep running AFTER the turn
  // settles (background Task delegation) — the indicator row must survive
  // them, not just the active turn.
  const agentRoster = deriveAgentRoster(input.timelineEntries, input.runningTurnId ?? null, {
    ...(input.dismissedAgentIds === undefined
      ? {}
      : { dismissedAgentIds: input.dismissedAgentIds }),
    ...(input.threadActivities === undefined ? {} : { activities: input.threadActivities }),
  });
  if (agentRoster.length > 0) {
    nextRows.push({
      kind: "agent-roster",
      id: "agent-roster-row",
      agents: agentRoster,
    });
  }
  const runningAgents = deriveRunningAgentIndicators(
    input.timelineEntries,
    input.runningTurnId ?? null,
  );
  if (input.isWorking || runningAgents.length > 0) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.isWorking ? input.activeTurnStartedAt : null,
      runningAgents,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "agent-roster": {
      const br = b as typeof a;
      return (
        a.agents.length === br.agents.length &&
        a.agents.every((agent, index) => {
          const other = br.agents[index];
          return (
            other !== undefined &&
            agent.id === other.id &&
            agent.label === other.label &&
            agent.model === other.model &&
            agent.startedAt === other.startedAt &&
            agent.endedAt === other.endedAt &&
            agent.status === other.status &&
            agent.step === other.step &&
            agent.durationMs === other.durationMs
          );
        })
      );
    }

    case "working": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runningAgents.length === bw.runningAgents.length &&
        a.runningAgents.every((agent, index) => {
          const other = bw.runningAgents[index];
          return (
            other !== undefined &&
            agent.id === other.id &&
            agent.label === other.label &&
            agent.startedAt === other.startedAt
          );
        })
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount &&
        // Rebuilt each derive, so it has to be compared field-wise or every
        // folded turn's terminal message would re-render on every pass.
        a.assistantTurnFold?.turnId === bm.assistantTurnFold?.turnId &&
        a.assistantTurnFold?.label === bm.assistantTurnFold?.label &&
        a.assistantTurnFold?.expanded === bm.assistantTurnFold?.expanded
      );
    }
  }
}
