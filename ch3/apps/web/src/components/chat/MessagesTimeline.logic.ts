import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import {
  type MessageId,
  type OrchestrationLatestTurn,
  type ProviderDriverKind,
  type TurnId,
} from "@ch3tools/contracts";
import { normalizeCustomModelSlug, normalizeModelSlug } from "@ch3tools/shared/model";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
}

/**
 * Whether the timeline is parked on the live edge. Read from `isAtEnd`, which
 * is the edge itself; LegendList's `isNearEnd` is its prefetch signal and
 * covers half a viewport, so treating it as "at the end" re-armed live-follow
 * under a reader who had deliberately scrolled up.
 */
export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  return state?.isAtEnd;
}

export interface TimelineScrollExtentState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/** Pixels between the bottom of the viewport and the end of the content. */
export function resolveTimelineDistanceFromEnd(
  state: TimelineScrollExtentState | undefined,
): number | null {
  if (
    state === undefined ||
    typeof state.contentLength !== "number" ||
    typeof state.scroll !== "number" ||
    typeof state.scrollLength !== "number"
  ) {
    return null;
  }
  return Math.max(0, state.contentLength - state.scroll - state.scrollLength);
}

export const TIMELINE_USER_SCROLL_ATTRIBUTION_MS = 1500;

/**
 * Whether a scroll event was the reader's doing. Scroll events also fire when
 * a layout reflow moves the content under a stationary reader — most violently
 * when a settled turn folds its work rows away — and treating those as the
 * reader scrolling is what cancelled live-follow under people who never
 * touched anything. A scroll is the reader's only when a scroll gesture
 * (wheel, touch, scrollbar grab, scroll key) happened recently; the caller
 * refreshes the gesture time on each attributed scroll so inertia and held
 * scrollbar drags stay attributed to the gesture that started them.
 */
export function isUserAttributableTimelineScroll(
  lastGestureAt: number | null,
  now: number,
): boolean {
  return lastGestureAt !== null && now - lastGestureAt <= TIMELINE_USER_SCROLL_ATTRIBUTION_MS;
}

/**
 * When a turn settles, the content under a reader parked near the end shifts:
 * the terminal message lands, streamed rows re-measure, and — if the reader
 * had folded the turn — the fold takes effect. (Turns no longer fold on their
 * own; they open by default and close only by hand.) A reader inside one
 * viewport of the end is watching that turn, so the end is where they were
 * looking; anyone further up is reading history and must be left alone.
 */
export function shouldSnapTimelineToEndAfterTurnSettle(input: {
  readonly distanceFromEnd: number | null;
  readonly scrollLength: number | undefined;
}): boolean {
  return (
    input.distanceFromEnd !== null &&
    typeof input.scrollLength === "number" &&
    input.scrollLength > 0 &&
    input.distanceFromEnd <= input.scrollLength
  );
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

/**
 * How long the pointer must have rested on the minimap rail before a click
 * counts, and how recently a wheel must NOT have happened.
 *
 * The rail is a strip up to 40px wide down the timeline's gutter, and one
 * click anywhere on it scrolls to the message at that height — the topmost
 * strip is the first message. A reader scrolling with two fingers on a
 * trackpad, with tap-to-click on and the pointer resting over the rail,
 * produces exactly that click, and was carried from the live edge to the
 * top of a 20,000-row conversation by a touch they did not mean. A
 * deliberate click arrives onto a hovered rail after a beat and never in the
 * middle of a wheel; an accidental tap arrives the instant the pointer
 * drifts on, or mid-scroll.
 */
/**
 * How long the pointer must settle on the rail before the rail answers.
 *
 * A pointer crossing the rail on its way to the first word of a message is
 * there for a few milliseconds; a reader consulting the rail rests on it. The
 * same dwell gates both answers the rail can give — opening a preview and
 * accepting a click — because both were firing on a pass-through.
 */
export const TIMELINE_MINIMAP_HOVER_DWELL_MS = 150;
export const TIMELINE_MINIMAP_CLICK_WHEEL_QUIET_MS = 400;

export function shouldAcceptTimelineMinimapClick(input: {
  /** When the rail became hovered, or null if it is not. */
  readonly hoveredSinceMs: number | null;
  /** The last wheel event over the timeline, or null if none. */
  readonly lastWheelAtMs: number | null;
  readonly nowMs: number;
}): boolean {
  if (input.hoveredSinceMs === null) return false;
  if (input.nowMs - input.hoveredSinceMs < TIMELINE_MINIMAP_HOVER_DWELL_MS) return false;
  if (
    input.lastWheelAtMs !== null &&
    input.nowMs - input.lastWheelAtMs < TIMELINE_MINIMAP_CLICK_WHEEL_QUIET_MS
  ) {
    return false;
  }
  return true;
}

/**
 * The row under the top of the viewport and where it sat, sampled on every
 * scroll event. What the reader was looking at, in terms that survive the
 * content changing under them: a row id and a pixel offset, not a scroll
 * position.
 */
export interface TimelineReadingAnchor {
  readonly rowId: string;
  /** The row's top relative to the viewport's top; negative when cut off. */
  readonly offset: number;
}

export interface TimelineAnchorState extends TimelineScrollExtentState {
  readonly data: ReadonlyArray<{ readonly id: string }>;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly positionByKey: (key: string) => number | undefined;
}

export function resolveTimelineReadingAnchor(
  state: TimelineAnchorState | undefined,
): TimelineReadingAnchor | null {
  if (state === undefined || typeof state.scroll !== "number" || state.data.length === 0) {
    return null;
  }
  const scroll = state.scroll;
  // Positions are monotonic, so the last row starting at or before the
  // viewport's top is the one under it. Binary search: a 20,000-row thread
  // samples this on every scroll event.
  let low = 0;
  let high = state.data.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const position = state.positionAtIndex(mid);
    if (typeof position !== "number") {
      // An unmeasured row: narrow towards the measured ones below it.
      high = mid - 1;
      continue;
    }
    if (position <= scroll) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found === -1) {
    const first = state.positionAtIndex(0);
    if (typeof first !== "number") return null;
    found = 0;
  }
  const row = state.data[found];
  const position = state.positionAtIndex(found);
  if (row === undefined || typeof position !== "number") return null;
  return { rowId: row.id, offset: position - scroll };
}

/**
 * How far, in viewports, the anchored row may move under a reader before a
 * scroll nobody asked for is treated as a jump and undone.
 */
export const TIMELINE_READING_JUMP_SCREENS = 2;

/**
 * How long after the app asks the list to scroll its scroll events count as
 * the app's own. Long enough for an animated scroll-to-end to land and for
 * the list's own follow-up frames; short enough that a jump a second later
 * is judged on its own.
 */
export const TIMELINE_PROGRAMMATIC_SCROLL_WINDOW_MS = 1_200;

/**
 * One scroll-to-end is a guess. The list is virtualised, so it jumps to where
 * it ESTIMATES the last row to be; every unmeasured row between the reader and
 * the end that turns out taller than its estimate — a long assistant message,
 * a tool card, a collapsed prompt — pushes the real end further down after
 * the jump has landed. So a scroll-to-end is re-issued each frame until the
 * measured distance to the end has stayed at zero for a few frames, or the
 * budget runs out. The reader taking the scroller back cancels it.
 */
export const TIMELINE_SCROLL_SETTLE_MAX_WAIT_MS = 2_000;
export const TIMELINE_SCROLL_SETTLE_STABLE_FRAMES = 3;
/** Sub-pixel layout rounding never reads as exactly zero. */
export const TIMELINE_AT_END_EPSILON_PX = 1;

/** Whether the list's viewport bottom sits on the measured end of the content. */
export function isTimelineSettledAtEnd(state: TimelineScrollExtentState | undefined): boolean {
  const distance = resolveTimelineDistanceFromEnd(state);
  return distance !== null && distance <= TIMELINE_AT_END_EPSILON_PX;
}

/** What kind of input the reader last gave the scroller. */
export type TimelineScrollGestureKind = "wheel" | "touch" | "pointer" | "key";

/**
 * The scroll position that puts the reader's anchored row back where it
 * was, or null when the scroll is fine.
 *
 * Fine means: the app asked for it (a scroll-to-end, a minimap jump, a fold
 * compensation — the caller says so); the row is gone (its position cannot
 * be known); the row moved by less than {@link TIMELINE_READING_JUMP_SCREENS}
 * viewports — a streamed row growing, a page of older rows prepended with
 * its compensation, a fold collapsing near the reader all look like that;
 * the reader grabbed the scrollbar or pressed a scroll key, either of which
 * can move any distance in one event; or the list is following the live
 * edge and moved the reader TOWARDS it, which is the pinning it exists for.
 *
 * Not fine is one scroll event that moved the reader screenfuls away from
 * the row they were on with none of that behind it — including one that
 * lands inside the attribution window of a wheel or a touch. A wheel moves
 * a few hundred pixels per event and a fling arrives as many of them; one
 * event spanning the whole conversation is not the wheel, whatever the
 * clock says, and crediting it to the wheel is how a reader was carried to
 * the top of twenty thousand rows and then told they had scrolled there.
 */
export function resolveTimelineReadingRestoreScroll(input: {
  readonly anchor: TimelineReadingAnchor | null;
  readonly state: TimelineAnchorState | undefined;
  readonly userAttributable: boolean;
  readonly gestureKind: TimelineScrollGestureKind | null;
  /**
   * What the app itself just asked the list to do: nothing, a scroll it
   * owns in any direction (a minimap jump, a fold compensation, a restore),
   * or a scroll TO THE END (a send, a settle, the pill). The last excuses
   * only movement towards the end — a scroll-to-end never lands at the top,
   * and the owner re-arms that expectation on every follow-mode pass, so
   * treating it as blanket permission left the guard blind while following.
   */
  readonly programmaticExpected: false | "any" | "towards-end";
  readonly followEnd: boolean;
}): number | null {
  const { anchor, state } = input;
  if (anchor === null || state === undefined) return null;
  if (input.programmaticExpected === "any") return null;
  if (typeof state.scroll !== "number" || typeof state.scrollLength !== "number") return null;
  if (state.scrollLength <= 0) return null;
  const position = state.positionByKey(anchor.rowId);
  if (typeof position !== "number") return null;
  const expectedScroll = position - anchor.offset;
  const moved = state.scroll - expectedScroll;
  if (Math.abs(moved) <= TIMELINE_READING_JUMP_SCREENS * state.scrollLength) return null;
  if (input.programmaticExpected === "towards-end" && moved > 0) return null;
  if (input.userAttributable && (input.gestureKind === "pointer" || input.gestureKind === "key")) {
    return null;
  }
  if (input.followEnd && moved > 0) return null;
  const maxScroll =
    typeof state.contentLength === "number"
      ? Math.max(0, state.contentLength - state.scrollLength)
      : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(maxScroll, expectedScroll));
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

/**
 * Whether the rail can sit in the open rather than fading in on hover.
 *
 * `sideGutter` is measured from the rendered message column, not predicted from
 * the viewport: the column is `max-w-5xl` inside a padded scroller, so a width
 * this file guessed at was wrong by hundreds of pixels and kept the rail
 * permanently drawn on top of the first characters of every message.
 */
export function resolveTimelineMinimapHasPersistentGutter(sideGutter: number): boolean {
  if (!Number.isFinite(sideGutter) || sideGutter <= 0) {
    return false;
  }

  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;

/**
 * Gutter left untouched between the rail and the message column.
 *
 * Selecting a paragraph starts at its first character, and the pointer reaches
 * that character from the left — through exactly the pixels the rail wants.
 * A rail that ends flush against the column turns every such approach into an
 * open preview instead of a selection, which is what this margin buys back.
 */
export const TIMELINE_MINIMAP_TEXT_SAFE_MARGIN = 12;

/** The active tick at full size — the `w-6` this rail has always drawn. */
export const TIMELINE_MINIMAP_TICK_MAX_WIDTH = 24;

/**
 * The shortest a tick may get before the rail is not worth drawing. Below this
 * the gutter cannot hold a rail *and* its margin, and the rail hides rather
 * than borrowing pixels from the text.
 */
export const TIMELINE_MINIMAP_TICK_MIN_WIDTH = 12;

export interface TimelineMinimapLane {
  /** Distance from the viewport's left edge to the rail's right edge. */
  readonly rightEdge: number;
  /** Width of the hover strip that opens the preview; 0 hides the rail. */
  readonly hitStripWidth: number;
  /** Length of the active tick; the shorter ticks scale off it. */
  readonly tickWidth: number;
}

const hiddenLane: TimelineMinimapLane = { rightEdge: 0, hitStripWidth: 0, tickWidth: 0 };

/**
 * Where the rail goes, given the measured gutter between the viewport's left
 * edge and the message column.
 *
 * The rail is anchored to the **column**, not to the viewport edge: its right
 * edge sits one margin short of the first character at every width. That is
 * the whole rule, and it replaces two failure modes of anchoring to the
 * viewport — a rail stranded a hundred pixels from the text it indexes on a
 * wide window, and a rail standing on the text on a narrow one.
 *
 * When the gutter is tight the rail shrinks rather than switching off, because
 * a navigation aid that vanishes at common window widths is not a fix for it
 * covering the text. Only a gutter too small for the shortest tick plus its
 * margin hides the rail entirely.
 */
export function resolveTimelineMinimapLane(sideGutter: number): TimelineMinimapLane {
  if (!Number.isFinite(sideGutter) || sideGutter <= 0) {
    return hiddenLane;
  }

  const room = Math.floor(sideGutter) - TIMELINE_MINIMAP_TEXT_SAFE_MARGIN;
  if (room < TIMELINE_MINIMAP_TICK_MIN_WIDTH) {
    return hiddenLane;
  }

  return {
    rightEdge: room,
    hitStripWidth: Math.min(TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH, room),
    tickWidth: Math.min(TIMELINE_MINIMAP_TICK_MAX_WIDTH, room),
  };
}

/**
 * How long a tick is, by how far it sits from the one under the pointer.
 *
 * The ladder is the rail's original 24/16/10/8 at full size, expressed as
 * fractions of the active tick so a shrunken rail keeps its shape.
 */
export function resolveTimelineMinimapTickWidth(tickWidth: number, activeDistance: number | null) {
  if (activeDistance === null) {
    return Math.round(tickWidth / 3);
  }
  if (activeDistance === 0) {
    return tickWidth;
  }
  if (activeDistance === 1) {
    return Math.round((tickWidth * 2) / 3);
  }
  if (activeDistance === 2) {
    return Math.round((tickWidth * 5) / 12);
  }
  return Math.round(tickWidth / 3);
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * How long a task run may go silent before the roster stops calling it live.
 *
 * Generous on purpose. A background agent reports a step per tool call, so
 * real gaps are seconds to minutes; an hour of silence from something that is
 * genuinely working would be extraordinary. The zombies this exists for had
 * been silent for **twenty-five hours**.
 */
export const ABANDONED_TASK_SILENCE_MS = 60 * 60 * 1000;

/**
 * Has this run gone quiet for so long that calling it "running" is a lie?
 *
 * `started` with no `completed` is the only sound liveness test for a
 * background agent — it outlives its turn, so nothing else in the timeline
 * says anything about it. But it is only sound while the completion can still
 * arrive. When a session is killed, the machine sleeps, or the CLI dies, the
 * `task.completed` never comes and that test never stops returning true: the
 * row sits there claiming to be running, across restarts, forever, because the
 * evidence it waits for no longer exists.
 *
 * Measured against the thread's newest activity rather than the wall clock, so
 * a thread that has simply been idle overnight does not bury the agent it left
 * running, and so this stays a pure function of its input.
 */
export function isAbandonedTaskRun(latestAt: string, newestActivityAt: string | null): boolean {
  if (newestActivityAt === null) return false;
  const silenceMs = computeElapsedMs(latestAt, newestActivityAt);
  return silenceMs !== null && silenceMs > ABANDONED_TASK_SILENCE_MS;
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
 * its task label, the model it is running on, when it started, and — once
 * finished — when it ended.
 */
export interface AgentRosterItem {
  readonly id: string;
  readonly label: string;
  /**
   * What is actually running under this row.
   *
   * The task feed carries backgrounded shell commands alongside delegated
   * agents, and the two want different chips: a shell command runs no model at
   * all, so inheriting the thread's — which is what a null model does — labels
   * a `npm run dev` with "claude-opus-5" and invites the reader to believe a
   * model is burning quota on it.
   */
  readonly kind: "agent" | "shell";
  /**
   * The model this agent runs on: the one its Task call named, or the thread's
   * own model when it named none. Null on a shell row, and on an agent row
   * only when neither is known.
   */
  readonly model: string | null;
  readonly startedAt: string;
  /** Null while the agent is still running. */
  readonly endedAt: string | null;
  readonly status: "running" | "done" | "failed";
  /** What the agent is doing right now (background agents report this). */
  readonly step?: string;
  /** Runtime-reported elapsed milliseconds, when the agent reports usage. */
  readonly durationMs?: number;
  /**
   * The OS process behind a shell row, when the server could find it.
   *
   * The runtime's own task id (`bzu9mezzp`) identifies the command to the CLI
   * and to nothing else. Somebody watching a long build wants the handle `ps`
   * and `kill` take, and absent this they go looking for it by hand. Never set
   * on an agent row, and absent whenever the process could not be named with
   * confidence — a wrong pid is worse than none.
   */
  readonly pid?: number;
}

/**
 * What the roster needs to name the model behind a delegation: the model this
 * thread's turns run on, and the driver behind it, since model aliases are
 * per-driver.
 */
export interface AgentModelContext {
  /** The thread's own model. Null when the thread has not resolved one yet. */
  readonly inheritedModel: string | null;
  readonly driverKind: ProviderDriverKind;
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
/**
 * Where an activity sits in its own lifecycle: started, then progress, then
 * completed. The tiebreak for two activities written in the same millisecond.
 */
function taskLifecycleRank(kind: string): number {
  if (kind === "task.started") return 0;
  if (kind === "task.completed") return 2;
  return 1;
}

function compareTaskActivitiesByLifecycle(
  left: AgentRosterActivity,
  right: AgentRosterActivity,
): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  return byTime === 0 ? taskLifecycleRank(left.kind) - taskLifecycleRank(right.kind) : byTime;
}

/**
 * A subagent's tool call labels itself "<subagent_type>: <task>" while the
 * task feed labels the same run with the bare "<task>". Stripping the prefix
 * lets the two be matched — the same split the model lookup uses.
 */
function stripSubagentTypePrefix(label: string): string {
  const separator = label.indexOf(": ");
  return separator > 0 ? label.slice(separator + 2) : label;
}

export function deriveAgentRoster(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  runningTurnId: TurnId | null = null,
  options: {
    readonly dismissedAgentIds?: ReadonlySet<string>;
    readonly activities?: ReadonlyArray<AgentRosterActivity>;
    readonly modelContext?: AgentModelContext | null;
  } = {},
): AgentRosterItem[] {
  const dismissed = options.dismissedAgentIds;
  const roster: AgentRosterItem[] = [];
  const seenLabels = new Set<string>();

  // A Task call that omits `model` does not run model-less — the subagent
  // inherits the model of the session that spawned it. So the thread's own
  // model is the truthful answer for those rows rather than a guess, and an
  // explicit `model` on the Task input outranks it. With neither, the row
  // stays blank; nothing here invents a name.
  const modelContext = options.modelContext ?? null;
  const resolveModel = (explicit: string | null): Pick<AgentRosterItem, "model"> => {
    const chosen = explicit ?? modelContext?.inheritedModel ?? null;
    // Task inputs name models by short alias ("sonnet"); threads use full
    // slugs ("claude-sonnet-5"). Alias both onto the slug so one row cannot
    // read in a different vocabulary than the next.
    const slug =
      modelContext === null
        ? normalizeCustomModelSlug(chosen)
        : normalizeModelSlug(chosen, modelContext.driverKind);
    return { model: slug };
  };

  interface TaskAccumulator {
    label: string;
    step: string | null;
    startedAt: string;
    latestAt: string;
    durationMs: number | null;
    completed: boolean;
    /** The runtime's own kind: `local_bash`, `local_agent`, `plan`, … */
    taskType: string | null;
    /** The process running a shell task, when the server resolved one. */
    pid: number | null;
  }
  const readString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  /**
   * One accumulator per RUN, not per task id.
   *
   * The CLI's task ids are unique per session, not globally — the server's own
   * projection SQL matches on `(thread, taskId)` for exactly this reason — so
   * one thread can hold two runs of the same id from two sessions. Keyed on the
   * id alone they merged: `startedAt` collapsed to the earlier run's, which is
   * where a row claiming hours of elapsed time comes from, and `completed`
   * latched from whichever run finished, which hid the live one entirely.
   *
   * A `task.started` for an id whose current run has already completed opens a
   * new run instead of reopening the old one.
   */
  const runsByTaskId = new Map<string, TaskAccumulator[]>();
  const currentRun = (taskId: string): TaskAccumulator | undefined => {
    const runs = runsByTaskId.get(taskId);
    return runs === undefined ? undefined : runs[runs.length - 1];
  };
  /**
   * The newest moment this thread knows about, used as "now".
   *
   * Read from the activities rather than the clock so this stays pure and
   * testable, and because it is the more truthful reference anyway: a thread
   * nobody has touched for a day has not been running an agent for a day.
   */
  let newestActivityAt: string | null = null;
  const taskActivities: Array<AgentRosterActivity> = [];
  for (const activity of options.activities ?? []) {
    if (newestActivityAt === null || activity.createdAt > newestActivityAt) {
      newestActivityAt = activity.createdAt;
    }
    if (
      activity.kind === "task.started" ||
      activity.kind === "task.progress" ||
      activity.kind === "task.completed"
    ) {
      taskActivities.push(activity);
    }
  }

  // Lifecycle order, not arrival order.
  //
  // A task that starts and finishes inside the same millisecond writes both
  // activities with the same `createdAt` and no sequence, and the projection
  // hands them back in row order — which for two rows written together is the
  // order of two random UUIDs. Read completed-then-started, the rule below
  // ("a start for an id whose run already finished opens a NEW run") opens a
  // run nobody will ever close, and the agent rail shows a finished command as
  // running with a timer counting up for as long as the thread stays open.
  // Observed on a `git commit && git push` that took under a second and then
  // claimed fifty-one minutes.
  //
  // Only the task activities are sorted: a thread holds tens of thousands of
  // activities and almost none of them are these.
  for (const activity of taskActivities.toSorted(compareTaskActivitiesByLifecycle)) {
    const payload = activity.payload as
      | {
          taskId?: unknown;
          taskType?: unknown;
          title?: unknown;
          detail?: unknown;
          pid?: unknown;
          usage?: { duration_ms?: unknown };
        }
      | undefined;
    const taskId = readString(payload?.taskId);
    if (taskId === null) continue;
    const detail = readString(payload?.detail);
    const title = readString(payload?.title);
    const durationMs =
      typeof payload?.usage?.duration_ms === "number" ? payload.usage.duration_ms : null;
    // What the task IS, straight from the runtime: `local_bash` for a
    // backgrounded shell command, `local_agent` for a delegation. Only
    // `task.started` carries it, so it is remembered on the run.
    const taskType = readString(payload?.taskType);
    // Arrives on its own `task.progress` row once the server has found the
    // process, so it is remembered on the run like taskType.
    const pid = typeof payload?.pid === "number" && payload.pid > 0 ? payload.pid : null;
    const existing = currentRun(taskId);
    // A second `task.started` after this id's run completed is a new run, not
    // more news about the finished one.
    const startsNewRun =
      existing === undefined || (activity.kind === "task.started" && existing.completed);
    if (startsNewRun) {
      const runs = runsByTaskId.get(taskId) ?? [];
      runs.push({
        // task.started's detail is the task itself; progress rows overwrite
        // detail with the current step, so the first one seen wins.
        label: detail ?? title ?? "Subagent",
        step: activity.kind === "task.progress" ? (title ?? detail) : null,
        startedAt: activity.createdAt,
        latestAt: activity.createdAt,
        durationMs,
        completed: activity.kind === "task.completed",
        taskType,
        pid,
      });
      runsByTaskId.set(taskId, runs);
      continue;
    }
    if (taskType !== null) existing.taskType = taskType;
    if (pid !== null) existing.pid = pid;
    if (activity.createdAt < existing.startedAt) {
      existing.startedAt = activity.createdAt;
    }
    if (activity.createdAt >= existing.latestAt) {
      existing.latestAt = activity.createdAt;
      // A progress row that names no step — the pid row the server appends
      // once it has found the process — must not blank the step on screen.
      if (activity.kind === "task.progress" && (title ?? detail) !== null) {
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
  // The Task tool call that spawned an agent names its model, and its `detail`
  // matches the task label (optionally behind a "<subagent_type>: " prefix).
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
  // Only the CURRENT run of each id can be live: an earlier one that never
  // reported a completion is not still running, it is a session that went away.
  for (const [taskId, runs] of runsByTaskId) {
    const task = runs[runs.length - 1];
    if (task === undefined) continue;
    if (task.completed) continue;
    if (isAbandonedTaskRun(task.latestAt, newestActivityAt)) continue;
    if (dismissed?.has(taskId)) continue;
    // The runtime says which it is. An earlier attempt matched the task label
    // against the work log's `command_execution` entries, which never agree:
    // the feed carries the Bash *description* ("Start the dev server") and the
    // work entry carries the command ("Bash: npm run dev"), so the branch could
    // not fire and a backgrounded build kept the thread's model beside it.
    const isShell = task.taskType === "local_bash";
    // Both the full label and its de-prefixed form, so the foreground-tool
    // dedup below matches whichever spelling the tool call carries. The task
    // feed's label is the bare task ("PR 179 walkthrough"); the same
    // delegation's tool call carries a "<subagent_type>: " prefix
    // ("hands: PR 179 walkthrough"), and without matching both the one
    // delegation was listed twice. Only an agent-kind task feeds this set: a
    // shell command has no tool-call twin, so its label must never swallow a
    // delegation that happens to share it ("Run tests" vs "hands: Run tests").
    if (!isShell) {
      seenLabels.add(task.label);
      seenLabels.add(stripSubagentTypePrefix(task.label));
    }
    roster.push({
      id: taskId,
      label: task.label,
      kind: isShell ? ("shell" as const) : ("agent" as const),
      // A shell row resolves no model at all rather than resolving to null:
      // `resolveModel` inherits the thread's model for a null input, which is
      // the whole bug.
      ...(isShell ? { model: null } : resolveModel(modelByLabel.get(task.label) ?? null)),
      startedAt: task.startedAt,
      endedAt: null,
      status: "running" as const,
      ...(task.step !== null ? { step: task.step } : {}),
      ...(task.durationMs !== null ? { durationMs: task.durationMs } : {}),
      ...(isShell && task.pid !== null ? { pid: task.pid } : {}),
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
      // Match on the de-prefixed label too: the tool call carries a
      // "<subagent_type>: " prefix the task feed does not.
      if (seenLabels.has(agent.label) || seenLabels.has(stripSubagentTypePrefix(agent.label))) {
        continue;
      }
      roster.push({
        id: key,
        label: agent.label,
        // Always an agent here: this loop reads `collab_agent_tool_call` only.
        kind: "agent" as const,
        ...resolveModel(agent.model),
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
export function deriveUnsettledTurnId(
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
  /**
   * Turns the reader has folded shut. A turn is OPEN unless it is in here: the
   * fold hides every commentary message between the user's prompt and the
   * final reply, and that commentary is where the agent says what it found
   * and why — the part a reader comes back for. Default-folded (the shape this
   * inherited from upstream) meant that context vanished the moment the next
   * turn started, and the reader had to know to click a "Worked for" row to
   * get it back. Now nothing is hidden until someone hides it.
   */
  collapsedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  /** Roster lines the user dismissed with the row's close control. */
  dismissedAgentIds?: ReadonlySet<string>;
  /** Thread activities — the background-agent task feed lives here. */
  threadActivities?: ReadonlyArray<AgentRosterActivity>;
  /** Thread model + tier, so roster rows can name the model each agent runs on. */
  agentModelContext?: AgentModelContext | null;
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
    const expanded = !(input.collapsedTurnIds?.has(fold.turnId) ?? false);
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
        expanded: !(input.collapsedTurnIds?.has(turnFold.turnId) ?? false),
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
    ...(input.agentModelContext === undefined ? {} : { modelContext: input.agentModelContext }),
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
            agent.durationMs === other.durationMs &&
            // The pid arrives on its own activity, tens of milliseconds after
            // the row is already on screen, and it is the only field that
            // changes when it does. Leaving it out of this comparison meant
            // the row was judged unchanged, React was handed the PREVIOUS row
            // object, and the chip never appeared — the timer kept counting
            // because it ticks its own text node without a commit, so the row
            // looked alive and simply never grew a pid.
            agent.pid === other.pid &&
            agent.kind === other.kind
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
