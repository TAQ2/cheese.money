import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type TurnId,
} from "@ch3tools/contracts";
import { parseScopedThreadKey } from "@ch3tools/client-runtime/environment";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import {
  deriveTimelineEntries,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  PaintbrushIcon,
  MinusIcon,
  SquarePenIcon,
  TerminalIcon,
  PencilIcon,
  RotateCcwIcon,
  Undo2Icon,
  WrenchIcon,
  CopyIcon,
  EllipsisIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { shouldAutoExpandChangedFiles } from "./changedFilesPresentation";
import { MessageCopyButton } from "./MessageCopyButton";
import { MessageSpeakButton } from "./MessageSpeakButton";
import { WorkingTimer } from "./WorkingTimer";
import {
  computeStableMessagesTimelineRows,
  type AgentModelContext,
  type AgentRosterActivity,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  isUserAttributableTimelineScroll,
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapLane,
  TIMELINE_MINIMAP_HOVER_DWELL_MS,
  type TimelineMinimapLane,
  resolveTimelineMinimapTickWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineReadingAnchor,
  resolveTimelineReadingRestoreScroll,
  shouldAcceptTimelineMinimapClick,
  TIMELINE_PROGRAMMATIC_SCROLL_WINDOW_MS,
  type TimelineReadingAnchor,
  type TimelineScrollGestureKind,
  resolveTimelineMinimapTopPercent,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type MessagesTimelineTurnFold,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from "~/lib/elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@ch3tools/contracts/settings";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";

import { type ThreadFindHighlight } from "./findInThread";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  /** The server has a speech engine, so replies can be read aloud. */
  speechAvailable: boolean;
  onRevertUserMessage: (messageId: MessageId) => void;
  /** Opens the rewind flow already sitting on this message, for editing it. */
  onEditUserMessage: (messageId: MessageId) => void;
  /** Re-dispatches the turn a `provider.turn.start.failed` row belongs to. */
  onRetryTurnStart: (messageId: MessageId) => void;
  /**
   * The only message whose turn may still be retried: the one still waiting at
   * the end of the thread. A failed-turn row never leaves the log, so without
   * this a days-old failure kept an enabled Retry button and could re-dispatch
   * a turn on a thread that had moved on — including one the person had
   * already retyped. The decider refuses those, and this is the same rule
   * where the button lives, so the button is never offered on work it cannot
   * do. Null when nothing is retriable.
   */
  retriableMessageId: MessageId | null;
  /** Opens a separate new thread, pre-filled to investigate this failure. */
  onReportTurnStartFailure: (report: {
    detail: string;
    createdAt: string;
    messageId: MessageId | null;
  }) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
  onToggleWorkGroup: (groupId: string, anchorElement?: HTMLElement) => void;
  onDismissAgent: (agentId: string) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
  latestTurnId: TurnId | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
/**
 * The entries find has taken the reader to, for the two bodies that hide their
 * own text: a long user message clipped to its first lines, and a collapsed
 * proposed plan showing a preview. A match inside either is highlighted and
 * invisible, so one that has held the current match shows itself in full.
 *
 * It accumulates rather than tracking only the current match, because
 * re-collapsing the one behind changes the height of everything below it — and
 * a match revealed against a layout that is about to shrink lands nowhere. It
 * empties when the find bar closes, which is what puts those bodies back.
 *
 * It is separate from `TimelineRowCtx` on purpose — that context feeds every
 * row, and stepping through matches would re-render all of them.
 */
const TimelineFindRevealedEntriesCtx = createContext<ReadonlySet<string>>(new Set());
const EMPTY_FIND_REVEALED_ENTRIES: ReadonlySet<string> = new Set();

const FIND_HIGHLIGHT_NAME = "find-in-thread";
const FIND_ACTIVE_HIGHLIGHT_NAME = "find-in-thread-active";
/** Distance kept between the revealed match and the edge it scrolled past. */
const FIND_REVEAL_MARGIN_PX = 96;
/**
 * How long a reveal may keep correcting itself. Revealing a match changes the
 * layout it was measured against — the body holding it unfolds, and the list
 * re-measures the row a frame later — so one measurement is not enough, and an
 * unbounded number is a loop.
 */
const FIND_REVEAL_SETTLE_MS = 400;

/**
 * The rendered occurrences of `needle` under `root`, per entry, in reading
 * order.
 *
 * It reads the DOM rather than the messages because the highlight has to land
 * on the rendered text — including inside a Shiki code block, which the
 * markdown renderer emits as HTML that React never sees as text. The virtualised
 * list only mounts a screenful of rows, so this walks that screenful, not the
 * thread; the counter comes from the messages themselves, which is why it can
 * report matches this pass never sees.
 *
 * Only the marked content bodies are searched, so the chrome around a message —
 * timestamps, tool names, the fold's own label — never lights up under a query
 * the counter did not count. A match split across inline markup (`hello
 * **world**`) is not found, because a text node is where a range can be made.
 */
function collectRenderedFindRanges(
  root: HTMLElement,
  needle: string,
): { readonly all: Range[]; readonly byEntry: Map<string, Range[]> } {
  const all: Range[] = [];
  const byEntry = new Map<string, Range[]>();

  for (const scope of root.querySelectorAll("[data-find-scope]")) {
    const entryId = scope.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id");
    if (!entryId) continue;
    const entryRanges = byEntry.get(entryId) ?? [];
    byEntry.set(entryId, entryRanges);

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const text = node.nodeValue?.toLowerCase() ?? "";
      let cursor = text.indexOf(needle);
      while (cursor !== -1) {
        const range = document.createRange();
        range.setStart(node, cursor);
        range.setEnd(node, cursor + needle.length);
        all.push(range);
        entryRanges.push(range);
        cursor = text.indexOf(needle, cursor + needle.length);
      }
      node = walker.nextNode();
    }
  }

  return { all, byEntry };
}

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = <div className="h-10 sm:h-12" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  /** Thread activities — carries the background-agent task feed. */
  threadActivities?: ReadonlyArray<AgentRosterActivity>;
  /**
   * The thread's own model, the driver behind it and the viewer's tier. Lets
   * the subagent roster name the model a delegation inherited when its Task
   * call did not pick one.
   */
  agentModelContext?: AgentModelContext | null;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  /** Opens the rewind flow already sitting on this message, for editing it. */
  onEditUserMessage: (messageId: MessageId) => void;
  /** Re-dispatches the turn a `provider.turn.start.failed` row belongs to. */
  onRetryTurnStart: (messageId: MessageId) => void;
  /**
   * The only message whose turn may still be retried: the one still waiting at
   * the end of the thread. A failed-turn row never leaves the log, so without
   * this a days-old failure kept an enabled Retry button and could re-dispatch
   * a turn on a thread that had moved on — including one the person had
   * already retyped. The decider refuses those, and this is the same rule
   * where the button lives, so the button is never offered on work it cannot
   * do. Null when nothing is retriable.
   */
  retriableMessageId: MessageId | null;
  /** Opens a separate new thread, pre-filled to investigate this failure. */
  onReportTurnStartFailure: (report: {
    detail: string;
    createdAt: string;
    messageId: MessageId | null;
  }) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  speechAvailable: boolean;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  contentInsetEndAdjustment: number;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onManualNavigation: () => void;
  /**
   * Whether the timeline should stay pinned to the live edge. False once the
   * reader scrolls away, which is what keeps a streaming turn from pulling
   * them back down on its next token.
   */
  followEnd: boolean;
  hideEmptyPlaceholder?: boolean;
  topFadeEnabled?: boolean;
  /**
   * Present only while the thread has older activities to page in. Firing it
   * prepends rows above the reader; maintainVisibleContentPosition keeps the
   * viewport anchored, so it never disturbs scroll-follow.
   */
  onStartReached?: (() => void) | undefined;
  /**
   * Whether the owner has just asked the list to scroll (to the end, after a
   * send or a settle). A scroll event inside that window is the app's own,
   * not a jump to undo. See the reading-anchor guard in `handleScroll`.
   */
  isProgrammaticScrollExpected?: (() => boolean) | undefined;
  /**
   * The conversation's find, when its bar is open: what to highlight, and which
   * occurrence the reader is standing on. The timeline owns revealing it —
   * unfolding the turn that hides it and scrolling it into view.
   */
  find?: ThreadFindHighlight | undefined;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaryByAssistantMessageId,
  threadActivities,
  agentModelContext,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onEditUserMessage,
  onRetryTurnStart,
  retriableMessageId,
  onReportTurnStartFailure,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  speechAvailable,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  contentInsetEndAdjustment,
  onIsAtEndChange,
  onManualNavigation,
  followEnd,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  onStartReached,
  isProgrammaticScrollExpected,
  find,
}: MessagesTimelineProps) {
  const [collapsedTurnIds, setCollapsedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());

  const onToggleTurnFold = useCallback((turnId: TurnId) => {
    setCollapsedTurnIds((existing) => {
      const next = new Set(existing);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  }, []);
  // The reading-anchor guard's state: the row under the viewport's top as of
  // the last scroll event, and until when a scroll event is this component's
  // own doing (a minimap jump, a fold compensation, a restore). Both refs, not
  // state — read inside the scroll handler, never rendered.
  const readingAnchorRef = useRef<TimelineReadingAnchor | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const expectProgrammaticScroll = useCallback(() => {
    programmaticScrollUntilRef.current = Date.now() + TIMELINE_PROGRAMMATIC_SCROLL_WINDOW_MS;
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorElement?: HTMLElement) => {
      const anchorBottomBeforeToggle = anchorElement?.getBoundingClientRect().bottom ?? null;

      flushSync(() => {
        setExpandedWorkGroupIds((existing) => {
          const next = new Set(existing);
          if (next.has(groupId)) {
            next.delete(groupId);
          } else {
            next.add(groupId);
          }
          return next;
        });
      });

      if (anchorBottomBeforeToggle === null || !anchorElement) {
        return;
      }

      const delta = anchorElement.getBoundingClientRect().bottom - anchorBottomBeforeToggle;
      if (Math.abs(delta) < 0.5) {
        return;
      }

      const list = listRef.current;
      const currentScroll = list?.getState?.().scroll;
      if (list && typeof currentScroll === "number") {
        expectProgrammaticScroll();
        list.scrollToOffset({ offset: currentScroll + delta, animated: false });
      }
    },
    [expectProgrammaticScroll, listRef],
  );

  // Dismissed roster lines, per thread — a manual override for a delegation
  // whose completion never arrived.
  const [dismissedAgentIds, setDismissedAgentIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  useEffect(() => {
    setDismissedAgentIds(new Set<string>());
  }, [routeThreadKey]);
  const onDismissAgent = useCallback((agentId: string) => {
    setDismissedAgentIds((existing) => {
      if (existing.has(agentId)) {
        return existing;
      }
      const next = new Set(existing);
      next.add(agentId);
      return next;
    });
  }, []);
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId,
        collapsedTurnIds,
        expandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
        dismissedAgentIds,
        ...(threadActivities === undefined ? {} : { threadActivities }),
        ...(agentModelContext === undefined ? {} : { agentModelContext }),
      }),
    [
      timelineEntries,
      latestTurn,
      runningTurnId,
      collapsedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
      dismissedAgentIds,
      threadActivities,
      agentModelContext,
    ],
  );
  const rows = useStableRows(rawRows);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [minimapLane, setMinimapLane] = useState<TimelineMinimapLane>({
    rightEdge: 0,
    hitStripWidth: 0,
    tickWidth: 0,
  });

  const [timelineScroller, setTimelineScroller] = useState<HTMLElement | null>(null);
  const attachList = useCallback(
    (instance: LegendListRef | null) => {
      listRef.current = instance;
      setTimelineScroller(instance?.getScrollableNode() ?? null);
    },
    [listRef],
  );

  // A scroll gesture only records that the reader touched the scroller; the
  // scroll handler below is what cancels live-follow, and only when a scroll
  // actually moves the reader off the end shortly after a gesture. Gestures
  // used to cancel live-follow directly, which meant any click inside the
  // conversation — expanding a work log, selecting text — silently disarmed
  // the follow while the reader sat still at the end; the next turn fold then
  // collapsed the rows under them with nothing holding the view at the edge.
  // These listeners live as long as the scroller does. They used to be
  // attached one frame after the thread changed, from outside this component,
  // which missed every list that mounted later: opening a thread whose
  // messages were still loading left a timeline the reader could not scroll
  // away from while it streamed.
  const lastScrollGestureAtRef = useRef<number | null>(null);
  const lastScrollGestureKindRef = useRef<TimelineScrollGestureKind | null>(null);
  // Wheel specifically, and over the whole timeline viewport rather than the
  // scroller alone: the minimap rail sits beside the scroller, and a wheel
  // over it is what makes a tap on it an accident rather than a click.
  const lastWheelAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }
    const recordWheel = () => {
      lastWheelAtRef.current = Date.now();
    };
    timelineViewportElement.addEventListener("wheel", recordWheel, { passive: true });
    return () => {
      timelineViewportElement.removeEventListener("wheel", recordWheel);
    };
  }, [timelineViewportElement]);
  useEffect(() => {
    if (!timelineScroller) {
      return;
    }
    // The kind matters to the reading-anchor guard: a scrollbar grab or a
    // scroll key can move any distance in one event, a wheel or a touch
    // cannot.
    const recordGesture = (kind: TimelineScrollGestureKind) => () => {
      lastScrollGestureAtRef.current = Date.now();
      lastScrollGestureKindRef.current = kind;
    };
    const recordWheelGesture = recordGesture("wheel");
    const recordTouchGesture = recordGesture("touch");
    const recordPointerGesture = recordGesture("pointer");
    const recordKey = recordGesture("key");
    const recordKeyGesture = (event: globalThis.KeyboardEvent) => {
      if (TIMELINE_SCROLL_KEYS.has(event.key)) {
        recordKey();
      }
    };
    timelineScroller.addEventListener("wheel", recordWheelGesture, { passive: true });
    timelineScroller.addEventListener("touchmove", recordTouchGesture, { passive: true });
    timelineScroller.addEventListener("pointerdown", recordPointerGesture, { passive: true });
    timelineScroller.addEventListener("keydown", recordKeyGesture, { passive: true });
    return () => {
      timelineScroller.removeEventListener("wheel", recordWheelGesture);
      timelineScroller.removeEventListener("touchmove", recordTouchGesture);
      timelineScroller.removeEventListener("pointerdown", recordPointerGesture);
      timelineScroller.removeEventListener("keydown", recordKeyGesture);
    };
  }, [timelineScroller]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    const isAtEnd = resolveTimelineIsAtEnd(state);
    const now = Date.now();
    const userAttributable = isUserAttributableTimelineScroll(lastScrollGestureAtRef.current, now);
    // The reading-anchor guard. The reader is looking at a row; a scroll
    // event that moves that row screenfuls away with nothing behind it that
    // could — no scroll asked for by the app, no scrollbar grab or scroll
    // key, not the list pinning a following reader towards the end — is a
    // jump, whatever produced it, and their place is put back. A wheel does
    // not excuse it: one event spanning the conversation is not a wheel,
    // however recent the wheel was. The restore is itself app intent, so it
    // cannot trip the guard on its own next event, and it happens BEFORE the
    // jump can be read as the reader navigating away from the live edge.
    const restoreTo = resolveTimelineReadingRestoreScroll({
      anchor: readingAnchorRef.current,
      state,
      userAttributable,
      gestureKind: lastScrollGestureKindRef.current,
      // This component's own scrolls may go anywhere; the owner's are
      // scroll-to-ends, which only ever move towards the end.
      programmaticExpected:
        now < programmaticScrollUntilRef.current
          ? "any"
          : isProgrammaticScrollExpected?.() === true
            ? "towards-end"
            : false,
      followEnd,
    });
    if (restoreTo !== null && listRef.current) {
      console.warn("[timeline] restored the reading position after an unexpected jump", {
        from: state?.scroll,
        to: restoreTo,
        anchor: readingAnchorRef.current,
        gesture: userAttributable ? lastScrollGestureKindRef.current : null,
        following: followEnd,
        rows: state?.data.length,
      });
      expectProgrammaticScroll();
      listRef.current.scrollToOffset({ offset: restoreTo, animated: false });
      return;
    }
    readingAnchorRef.current = resolveTimelineReadingAnchor(state);
    if (isAtEnd !== undefined) {
      if (userAttributable) {
        lastScrollGestureAtRef.current = now;
        if (!isAtEnd) {
          onManualNavigation();
        }
      }
      onIsAtEndChange(isAtEnd);
    }
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [
    expectProgrammaticScroll,
    followEnd,
    isProgrammaticScrollExpected,
    listRef,
    minimapItems,
    minimapStripMap,
    onIsAtEndChange,
    onManualNavigation,
  ]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    // Where the message column actually starts, read off a rendered row rather
    // than derived from the viewport width. The column is `max-w-5xl` inside a
    // padded, scrollbar-guttered scroller, so every prediction of that edge was
    // a second source of truth beside the CSS — and a wrong one, which is how
    // the rail came to sit on the text it was supposed to stay clear of. With
    // no row rendered there is no measurable gutter, and the rail stays inert.
    const measure = () => {
      const viewportLeft = timelineViewportElement.getBoundingClientRect().left;
      const column = timelineViewportElement
        .querySelector("[data-timeline-root]")
        ?.getBoundingClientRect();
      const sideGutter = column ? Math.max(0, column.left - viewportLeft) : 0;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(sideGutter);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      const nextLane = resolveTimelineMinimapLane(sideGutter);
      // A fresh object every measure would re-render the whole timeline on
      // every resize tick; the widths it carries are what actually changed.
      setMinimapLane((current) =>
        current.rightEdge === nextLane.rightEdge &&
        current.hitStripWidth === nextLane.hitStripWidth &&
        current.tickWidth === nextLane.tickWidth
          ? current
          : nextLane,
      );
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length]);

  // ---------------------------------------------------------------------
  // Find in conversation — reveal and highlight
  // ---------------------------------------------------------------------
  const findQuery = find?.query.trim().length ? find.query : "";
  const findActiveEntryId = findQuery === "" ? null : (find?.activeEntryId ?? null);
  const findActiveOccurrenceIndex = find?.activeOccurrenceIndex ?? 0;
  // Set when the reader moves to another match, cleared once that match has
  // been put on screen. Without it every mutation of a streaming turn would
  // drag the view back to the match the reader has since scrolled away from.
  const findRevealPendingRef = useRef(false);
  const findRevealedTokenRef = useRef<string | null>(null);
  const findRevealDeadlineRef = useRef(0);
  // Set once the row holding the match has been scrolled to, so a match the
  // highlighter never finds inside it cannot scroll there again on every
  // mutation of a streaming turn.
  const findCoarseRevealedTokenRef = useRef<string | null>(null);
  const findRevealToken =
    findActiveEntryId === null
      ? null
      : `${findQuery}\u0000${findActiveEntryId}\u0000${findActiveOccurrenceIndex}`;

  /** The navigation a fold was last opened for, so it is opened once. */
  const findUnfoldedTokenRef = useRef<string | null>(null);
  const [findRevealedEntryIds, setFindRevealedEntryIds] = useState(EMPTY_FIND_REVEALED_ENTRIES);
  // Adjusted during render rather than in an effect, deliberately: a body that
  // unfolds to show the match has to be its final height BEFORE the reveal
  // below measures where that match is. Unfolding one commit later moves the
  // match after it was put on screen, which is how it ends up off it.
  if (find === undefined) {
    if (findRevealedEntryIds.size > 0) {
      setFindRevealedEntryIds(EMPTY_FIND_REVEALED_ENTRIES);
    }
  } else if (findActiveEntryId !== null && !findRevealedEntryIds.has(findActiveEntryId)) {
    setFindRevealedEntryIds(new Set(findRevealedEntryIds).add(findActiveEntryId));
  }

  // A match inside a folded turn has no row to scroll to: the fold removes it
  // from the list entirely. Unfolding is what makes it exist. The fold stays
  // open after the find bar closes — collapsing it would move the conversation
  // out from under the reader who just navigated there.
  //
  // Once per navigation, not once per render: this effect watches `rows`, and
  // folding a turn is itself a change to `rows`. Re-running it there would
  // reopen the fold the reader just closed, on every attempt, for as long as
  // the match stayed active. Stepping to another match and back is a new
  // token, so a deliberate return still reveals.
  useEffect(() => {
    if (findActiveEntryId === null) return;
    if (findRevealToken !== null && findRevealToken === findUnfoldedTokenRef.current) return;
    if (rows.some((row) => row.id === findActiveEntryId)) return;
    findUnfoldedTokenRef.current = findRevealToken;
    const entry = timelineEntries.find((candidate) => candidate.id === findActiveEntryId);
    const turnId =
      entry?.kind === "message"
        ? entry.message.turnId
        : entry?.kind === "proposed-plan"
          ? entry.proposedPlan.turnId
          : null;
    if (!turnId) return;
    setCollapsedTurnIds((existing) => {
      if (!existing.has(turnId)) return existing;
      const next = new Set(existing);
      next.delete(turnId);
      return next;
    });
  }, [findActiveEntryId, findRevealToken, rows, timelineEntries]);

  const findRevealTokenRef = useRef<string | null>(null);
  findRevealTokenRef.current = findRevealToken;
  // Read through a ref inside the highlight pass, and re-run it on this one
  // boolean rather than on `rows`: an unfold that mounts the active match's
  // row is the only row change the pass has to react to (see the dependency
  // note below). Depending on `rows` re-ran it on every streaming chunk.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const findActiveRowMounted =
    findActiveEntryId !== null && rows.some((row) => row.id === findActiveEntryId);
  useEffect(() => {
    if (findRevealToken === null || findRevealToken === findRevealedTokenRef.current) return;
    findRevealedTokenRef.current = findRevealToken;
    findRevealPendingRef.current = true;
    findRevealDeadlineRef.current = Date.now() + FIND_REVEAL_SETTLE_MS;
  }, [findRevealToken]);

  useEffect(() => {
    const registry = typeof CSS === "undefined" ? undefined : CSS.highlights;
    if (!registry) return;
    const clear = () => {
      registry.delete(FIND_HIGHLIGHT_NAME);
      registry.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
    };
    if (!timelineViewportElement || findQuery === "") {
      clear();
      return;
    }

    const needle = findQuery.toLowerCase();
    let frame = 0;
    const apply = () => {
      frame = 0;
      const { all, byEntry } = collectRenderedFindRanges(timelineViewportElement, needle);
      registry.set(FIND_HIGHLIGHT_NAME, new Highlight(...all));

      const activeRange =
        findActiveEntryId === null
          ? undefined
          : byEntry.get(findActiveEntryId)?.[findActiveOccurrenceIndex];
      // No range for the active match means its row is not mounted — the list
      // renders a screenful. Scrolling to the row is what mounts it; the next
      // pass, once it has, is what lands on the match itself. The two steps
      // never share a frame, because a scroll measured against a layout that a
      // scroll already in flight is about to change lands nowhere.
      if (!activeRange) {
        registry.delete(FIND_ACTIVE_HIGHLIGHT_NAME);
        if (!findRevealPendingRef.current) return;
        if (findRevealTokenRef.current === findCoarseRevealedTokenRef.current) return;
        const index = rowsRef.current.findIndex((row) => row.id === findActiveEntryId);
        if (index === -1) return;
        findCoarseRevealedTokenRef.current = findRevealTokenRef.current;
        onManualNavigation();
        expectProgrammaticScroll();
        void listRef.current?.scrollToIndex({ index, animated: false, viewOffset: 24 });
        return;
      }
      registry.set(FIND_ACTIVE_HIGHLIGHT_NAME, new Highlight(activeRange));

      if (!findRevealPendingRef.current || !timelineScroller) return;
      const matchRect = activeRange.getBoundingClientRect();
      if (matchRect.height === 0) return;
      const viewRect = timelineScroller.getBoundingClientRect();
      // Correct first, then keep watching for a short window: the row holding
      // the match is measured by the list a frame after it unfolds, and a
      // reveal that trusted its first measurement lands above the viewport.
      if (
        matchRect.top < viewRect.top + FIND_REVEAL_MARGIN_PX ||
        matchRect.bottom > viewRect.bottom - FIND_REVEAL_MARGIN_PX
      ) {
        const currentScroll = listRef.current?.getState?.().scroll ?? timelineScroller.scrollTop;
        onManualNavigation();
        expectProgrammaticScroll();
        listRef.current?.scrollToOffset({
          offset: currentScroll + (matchRect.top - viewRect.top) - FIND_REVEAL_MARGIN_PX,
          animated: false,
        });
      }
      if (Date.now() > findRevealDeadlineRef.current) {
        findRevealPendingRef.current = false;
        return;
      }
      if (frame === 0) {
        frame = requestAnimationFrame(apply);
      }
    };

    apply();
    // Virtualised rows mount and unmount as the list scrolls, and a streaming
    // reply rewrites its own text — both change what there is to highlight.
    const observer = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(apply);
      }
    });
    observer.observe(timelineViewportElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      clear();
    };
  }, [
    expectProgrammaticScroll,
    findActiveEntryId,
    findActiveOccurrenceIndex,
    findQuery,
    listRef,
    onManualNavigation,
    // Whether the active match's row is in the row model is a dependency on
    // purpose. Reading rows only through a ref lost a real case: from the end
    // of a long thread, a query whose first match sits in a folded turn has no
    // row to scroll to, so the pass returns; the unfold effect then opens the
    // turn — but the rows it adds mount far above the viewport, so nothing in
    // the mounted screenful mutates, the observer never fires, and the counter
    // reads "1 of 3" over a view that never moves. Re-running when that row
    // appears is what turns an unfold into a reveal. Depending on `rows`
    // itself did the same job at the price of a second pass per streaming
    // chunk, on top of the one the observer already runs.
    findActiveRowMounted,
    timelineScroller,
    timelineViewportElement,
  ]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      threadRef: parseScopedThreadKey(routeThreadKey),
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      speechAvailable,
      onRevertUserMessage,
      onEditUserMessage,
      onRetryTurnStart,
      retriableMessageId,
      onReportTurnStartFailure,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onDismissAgent,
    }),
    [
      onDismissAgent,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      speechAvailable,
      onRevertUserMessage,
      onEditUserMessage,
      onRetryTurnStart,
      retriableMessageId,
      onReportTurnStartFailure,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
      latestTurnId: latestTurn?.turnId ?? null,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking, latestTurn?.turnId],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-5xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    if (hideEmptyPlaceholder) {
      return null;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineFindRevealedEntriesCtx value={findRevealedEntryIds}>
        <TimelineRowActivityCtx value={activityState}>
          <div ref={setTimelineViewportElement} className="relative h-full min-h-0">
            <LegendList<MessagesTimelineRow>
              ref={attachList}
              data={rows}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              renderItem={renderItem}
              estimatedItemSize={90}
              initialScrollAtEnd
              contentInsetEndAdjustment={contentInsetEndAdjustment}
              maintainScrollAtEnd={
                followEnd
                  ? {
                      animated: false,
                      on: {
                        dataChange: true,
                        itemLayout: true,
                        layout: true,
                      },
                    }
                  : false
              }
              maintainVisibleContentPosition={{
                data: true,
                size: false,
              }}
              onScroll={handleScroll}
              {...(onStartReached === undefined
                ? {}
                : { onStartReached, onStartReachedThreshold: 0.25 })}
              className={cn(
                "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5",
                topFadeEnabled && "chat-timeline-scroll-fade",
              )}
              ListHeaderComponent={
                topFadeEnabled ? TIMELINE_LIST_FADE_HEADER : TIMELINE_LIST_HEADER
              }
              ListFooterComponent={TIMELINE_LIST_FOOTER}
            />
            <TimelineMinimap
              items={minimapItems}
              bottomInset={contentInsetEndAdjustment}
              hasPersistentGutter={minimapHasPersistentGutter}
              lane={minimapLane}
              stripMap={minimapStripMap}
              lastWheelAtRef={lastWheelAtRef}
              onSelect={(item) => {
                onManualNavigation();
                expectProgrammaticScroll();
                void listRef.current?.scrollToIndex({
                  index: item.rowIndex,
                  animated: true,
                  viewOffset: 24,
                });
              }}
            />
          </div>
        </TimelineRowActivityCtx>
      </TimelineFindRevealedEntriesCtx>
    </TimelineRowCtx>
  );
});

const TIMELINE_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(rows, index)),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

function TimelineMinimap({
  bottomInset,
  hasPersistentGutter,
  lane,
  items,
  lastWheelAtRef,
  stripMap,
  onSelect,
}: {
  bottomInset: number;
  hasPersistentGutter: boolean;
  lane: TimelineMinimapLane;
  items: ReadonlyArray<TimelineMinimapItem>;
  /** The last wheel over the timeline; a click mid-wheel is not a click. */
  lastWheelAtRef: React.RefObject<number | null>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndexState] = useState<number | null>(null);
  const activeIndexRef = useRef<number | null>(null);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIndexRef = useRef<number | null>(null);

  const setActiveIndex = useCallback((next: number | null) => {
    activeIndexRef.current = next;
    setActiveIndexState(next);
  }, []);

  const cancelDwell = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelDwell, [cancelDwell]);
  // When the pointer arrived on the rail. A click counts only after a beat of
  // hovering (see `shouldAcceptTimelineMinimapClick`): a tap-to-click during a
  // two-finger scroll, with the pointer resting over the rail, otherwise
  // carries the reader to whatever message sits at that height.
  const hoveredSinceRef = useRef<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      if (hoveredSinceRef.current === null && nextIndex !== null) {
        hoveredSinceRef.current = Date.now();
      }
      pendingIndexRef.current = nextIndex;

      if (nextIndex === null) {
        cancelDwell();
        setActiveIndex(null);
        return;
      }
      // Open: track the pointer directly, no second wait.
      if (activeIndexRef.current !== null) {
        setActiveIndex(nextIndex);
        return;
      }
      // Closed: the pointer has to settle. Sweeping in from the left margin to
      // reach the first word of a message crosses the rail in a few
      // milliseconds, and that used to be enough to open a preview over the
      // words the reader was reaching for.
      if (dwellTimerRef.current !== null) {
        return;
      }
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        setActiveIndex(pendingIndexRef.current);
      }, TIMELINE_MINIMAP_HOVER_DWELL_MS);
    },
    [cancelDwell, resolveActiveIndexFromPointer, setActiveIndex],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      const base = activeIndexRef.current ?? 0;
      setActiveIndex(Math.max(0, Math.min(items.length - 1, base + delta)));
    },
    [items.length, setActiveIndex],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute top-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      style={{ bottom: safeBottomInset }}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            // The rail lives inside the measured gutter, a margin short of the
            // text; a gutter too small for even a stub of one hides it.
            lane.hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          onBlur={() => {
            cancelDwell();
            setActiveIndex(null);
          }}
          onClick={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) {
              return;
            }
            if (
              !shouldAcceptTimelineMinimapClick({
                hoveredSinceMs: hoveredSinceRef.current,
                lastWheelAtMs: lastWheelAtRef.current,
                nowMs: Date.now(),
              })
            ) {
              return;
            }
            const nextIndex = resolveActiveIndexFromPointer(event);
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex(activeIndexRef.current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) {
                onSelect(activeItem);
              }
            }
          }}
          onMouseLeave={() => {
            hoveredSinceRef.current = null;
            cancelDwell();
            setActiveIndex(null);
          }}
          onMouseMove={updateActiveIndexFromPointer}
          onMouseDown={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) {
              return;
            }
            event.preventDefault();
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            left: Math.max(0, lane.rightEdge - lane.hitStripWidth),
            width: lane.hitStripWidth,
          }}
          // A hidden rail is out of the tab order too. `pointer-events-none`
          // stops the mouse but not Tab, and focus opens the preview card —
          // 320px of it, at the viewport's left edge, over the first words of
          // a message. That is the bug this component is fixing, reached by
          // keyboard instead of by pointer.
          tabIndex={lane.hitStripWidth > 0 ? undefined : -1}
          type="button"
        >
          <div
            className="absolute top-0 h-full w-px bg-border/15"
            style={{ left: Math.round(lane.tickWidth / 2) }}
          />
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0 && "bg-muted-foreground/75",
                )}
                data-in-view="false"
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) {
                    stripMap.set(item.id, node);
                  } else {
                    stripMap.delete(item.id);
                  }
                }}
                style={{
                  top,
                  width: resolveTimelineMinimapTickWidth(lane.tickWidth, activeDistance),
                }}
              />
            );
          })}
          {activeItem ? (
            <span
              className="pointer-events-auto absolute w-80 cursor-text select-text"
              data-minimap-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{
                // Flush against the strip: the pointer reaches the card without
                // crossing dead space, which is what the old 22rem-wide
                // interactive area was compensating for — over the text.
                left: lane.hitStripWidth,
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
          row.kind === "work" ||
          row.kind === "work-toggle"
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "agent-roster" ? <AgentRosterTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages = row.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = displayedUserMessage.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }
  const elementContextState = extractTrailingElementContexts(visibleText);
  const elementContexts = [
    ...displayedUserMessage.elementContexts,
    ...elementContextState.contexts,
  ];
  const previewImages = userImages.filter((image) => image.name.startsWith("preview-annotation-"));
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-accent p-3">
        {regularImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {regularImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(regularImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {previewAnnotations.map((annotation, index) => (
          <UserMessagePreviewAnnotationCard
            key={annotation.id}
            annotation={annotation}
            image={previewImages[index] ?? null}
          />
        ))}
        {elementContexts.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {elementContexts.map((context) => (
              <UserMessageElementContextChip
                key={`${context.header}:${context.body}`}
                context={context}
              />
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          messageId={row.message.id}
          text={elementContextState.promptText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatShortTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            <EditUserMessageButton messageId={row.message.id} />
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} variant="ghost" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Edit this message and send it again.
 *
 * There is no separate edit path on the server: this opens the rewind dialog
 * on this message, where the text is editable and confirming truncates the
 * thread back to it, restores that turn's files where a checkpoint allows,
 * and resends. Disabled while a turn is running for the same reason the
 * dialog refuses then — a rewind cannot land under a live turn.
 */
function EditUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onEditUserMessage(messageId)}
            aria-label="Edit and resend this message"
          />
        }
      >
        <PencilIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Edit and resend</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Retries a turn that never started, for the message that is already durably
 * saved on the thread. Unlike `EditUserMessageButton` this does not rewind or
 * truncate anything — the message never ran, there is nothing after it to
 * discard — it just re-dispatches the same turn.
 */
function RetryTurnStartButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isWorking}
            onClick={(event) => {
              stopRowToggle(event);
              ctx.onRetryTurnStart(messageId);
            }}
            aria-label="Retry sending this message"
          />
        }
      >
        <RotateCcwIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Retry</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Low-emphasis escape hatch beside Retry: opens a separate new thread,
 * pre-filled to investigate this failure, instead of retrying in place. A
 * text link on purpose, not a `Button`: retrying is the expected action,
 * this is the fallback for when it keeps happening.
 */
function ReportTurnStartFailureLink({
  detail,
  createdAt,
  messageId,
}: {
  detail: string | undefined;
  createdAt: string;
  messageId: MessageId | undefined;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <button
      type="button"
      className="mr-1 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      onClick={(event) => {
        stopRowToggle(event);
        ctx.onReportTurnStartFailure({
          detail: detail ?? "",
          createdAt,
          messageId: messageId ?? null,
        });
      }}
    >
      Report
    </button>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The "Worked for ..." control. Rendered twice per folded turn — once above the
 * turn's work and once under its terminal reply — so a long answer never puts
 * the toggle out of reach.
 */
function TurnFoldToggle({ fold }: { fold: MessagesTimelineTurnFold }) {
  const ctx = use(TimelineRowCtx);
  const Icon = fold.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <button
      type="button"
      aria-expanded={fold.expanded}
      data-scroll-anchor-ignore
      onClick={() => ctx.onToggleTurnFold(fold.turnId)}
      className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <span>{fold.label}</span>
      <Icon className="size-3.5" />
    </button>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <TurnFoldToggle fold={{ turnId: row.turnId, label: row.label, expanded: row.expanded }} />
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <div data-find-scope="true">
          <ChatMarkdown
            text={messageText}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            isStreaming={Boolean(row.message.streaming)}
            skills={ctx.skills}
          />
        </div>
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center justify-end gap-2 text-xs tabular-nums">
            {/* The duration reads as content, not an action: it stays legible
                at rest while the action cluster keeps fading in on hover. */}
            {row.assistantTurnFold ? (
              <div className="me-auto min-w-0">
                <TurnFoldToggle fold={row.assistantTurnFold} />
              </div>
            ) : null}
            {/* The row's actions fade out with the pointer, EXCEPT while a
                read-aloud is working, loaded or failed: a sixty-second
                synthesis behind an invisible spinner is indistinguishable
                from a button that did nothing, and the audio then arrives
                with no visible way to stop it. */}
            <div className="flex items-center gap-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100 has-[[data-speech-active]]:opacity-100">
              <AssistantCopyButton row={row} />
              <AssistantSpeakButton row={row} />
              {!row.message.streaming && (
                <Tooltip>
                  <TooltipTrigger
                    render={<p className="text-muted-foreground text-xs tabular-nums" />}
                  >
                    {formatShortTimestamp(row.message.updatedAt, ctx.timestampFormat)}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {formatChatTimestampTooltip(row.message.updatedAt, ctx.timestampFormat)}
                  </TooltipPopup>
                </Tooltip>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * Read-aloud, on finished replies only. There is nothing to listen to while a
 * message is still streaming, and the copy state already models exactly that
 * question, so it decides here too.
 */
function AssistantSpeakButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const copyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  // No length ceiling here: the button splits anything over the service's
  // per-request limit and reads the parts in order. Hiding it was the wrong
  // answer to "this reply is long" — a long reply is the one most worth
  // listening to rather than reading.
  if (!ctx.speechAvailable || !copyState.visible || !copyState.text) {
    return null;
  }

  return <MessageSpeakButton environmentId={ctx.activeThreadEnvironmentId} text={copyState.text} />;
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const revealedByFind = use(TimelineFindRevealedEntriesCtx).has(row.id);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        forceExpanded={revealedByFind}
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const agents = row.runningAgents;
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {row.createdAt ? (
            <>
              Working for <WorkingTimer startedAt={row.createdAt} />
              {agents.length > 0
                ? ` · ${agents.length} subagent${agents.length === 1 ? "" : "s"} running`
                : null}
            </>
          ) : agents.length > 0 ? (
            // Turn settled, delegation still running in the background.
            `${agents.length} subagent${agents.length === 1 ? "" : "s"} running`
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Live subagent roster: one bullet per delegation that is still running —
 * task label, the model it is running on, and a running timer. A model that
 * is metered on the viewer's tier wears the warning tone and its multiplier,
 * so a fleet of agents quietly burning 4× quota reads at a glance.
 * Finished agents leave on their own; the close control clears a line whose
 * completion never arrived (interrupted or restarted session).
 */
function AgentRosterTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "agent-roster" }> }) {
  const { onDismissAgent } = use(TimelineRowCtx);
  return (
    <div className="py-0.5 pl-1.5" data-testid="agent-roster">
      <ul className="flex flex-col gap-0.5 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        {row.agents.map((agent) => (
          <li key={agent.id} className="group/agent flex min-w-0 items-baseline gap-2">
            <span aria-hidden className="shrink-0">
              {"\u2022"}
            </span>
            <span className="min-w-0 truncate">
              {agent.label}
              {agent.step ? (
                <span className="text-muted-foreground/45"> — {agent.step}</span>
              ) : null}
            </span>
            {agent.kind === "shell" || agent.model ? (
              <span
                data-testid="agent-roster-model"
                title={
                  agent.kind === "shell"
                    ? "A shell command this agent left running — no model"
                    : undefined
                }
                className="max-w-[12rem] shrink-0 truncate rounded bg-muted/60 px-1 text-muted-foreground/80"
              >
                {/* A command runs no model, so it says what it is instead:
                    reading "claude-opus-5" beside a build script suggests one
                    is being spent on it. */}
                {agent.kind === "shell" ? "sh" : agent.model}
              </span>
            ) : null}
            {agent.kind === "shell" ? (
              /* The CLI's own id for the task — the one its Read and
                 TaskOutput tools take — so the row names both handles. */
              <span
                data-testid="agent-roster-task-id"
                title="The CLI's id for this background task"
                className="shrink-0 rounded bg-muted/60 px-1 font-mono text-muted-foreground/80"
              >
                {agent.id}
              </span>
            ) : null}
            {agent.pid === undefined ? null : (
              /* The task id is a handle for the CLI and for nothing else. This
                 is the one `ps` and `kill` take, and it is on the row so it
                 comes along with whatever the reader copies. */
              <span
                data-testid="agent-roster-pid"
                title={`Process ${agent.pid} on this machine was running the command when it started`}
                className="shrink-0 rounded bg-muted/60 px-1 text-muted-foreground/80"
              >
                pid {agent.pid}
              </span>
            )}
            <span className="shrink-0">
              <WorkingTimer startedAt={agent.startedAt} />
            </span>
            <AgentIdCopyButton agentId={agent.id} agentLabel={agent.label} pid={agent.pid} />
            <button
              type="button"
              aria-label={`Dismiss ${agent.label}`}
              title="Remove this line"
              className="shrink-0 px-1 leading-none text-muted-foreground/40 transition-colors hover:text-foreground"
              onClick={() => onDismissAgent(agent.id)}
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/**
 * Copy an agent's id, and say so.
 *
 * A click that changes nothing on screen reads as a click that did nothing, so
 * the icon becomes a tick for a moment. Same two-second window the rest of the
 * app uses for a copy, from the same hook.
 */
function AgentIdCopyButton({
  agentId,
  agentLabel,
  pid,
}: {
  agentId: string;
  agentLabel: string;
  /** The OS process behind a shell row, when the server could name one. */
  pid?: number | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "agent id" });
  // Both handles, because they answer different questions and the person
  // copying a backgrounded command usually wants the second: the runtime's id
  // is what the CLI polls, and the pid is what `ps` and `kill` take. Copying
  // the id alone sent people back to the row to read the number off the screen.
  const copied = pid === undefined ? agentId : `${agentId} · pid ${pid}`;
  return (
    <button
      type="button"
      aria-label={`Copy agent id for ${agentLabel}`}
      title={
        isCopied ? "Copied" : pid === undefined ? "Copy this agent's id" : "Copy the id and the pid"
      }
      className={cn(
        "shrink-0 px-1 leading-none transition-colors",
        isCopied ? "text-emerald-500" : "text-muted-foreground/40 hover:text-foreground",
      )}
      onClick={() => copyToClipboard(copied, undefined)}
    >
      {isCopied ? (
        <CheckIcon className="size-3" aria-hidden />
      ) : (
        <CopyIcon className="size-3" aria-hidden />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  );
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry));
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? "1 tool call"
      : `${nonEmptyEntries.length} tool calls`
    : "Work Log";

  if (nonEmptyEntries.length === 0) return null;

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 font-medium text-[11px] text-muted-foreground/65">
          {groupLabel}
        </p>
      )}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </section>
  );
});

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const labelNoun = row.onlyToolEntries
    ? row.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : row.hiddenCount === 1
      ? "log entry"
      : "log entries";

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={(event) => {
        const anchorElement =
          event.currentTarget.closest<HTMLElement>("[data-timeline-row-id]") ?? event.currentTarget;
        ctx.onToggleWorkGroup(row.groupId, anchorElement);
      }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground/82">
          Show fewer {row.onlyToolEntries ? "tool calls" : "log entries"}
        </span>
      ) : (
        <span className="font-medium text-foreground/82">
          +{row.hiddenCount} previous {labelNoun}
        </span>
      )}
    </button>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const activity = use(TimelineRowActivityCtx);
  const isLatestTurn = activity.latestTurnId === turnSummary.turnId;
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const [autoExpanded] = useState(() =>
    shouldAutoExpandChangedFiles(checkpointFiles, isLatestTurn),
  );
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(autoExpanded);
  const expanded = persistedExpanded ?? (isLatestTurn && autoExpanded);

  return (
    <ChangedFilesCard
      turnId={turnSummary.turnId}
      files={checkpointFiles}
      expanded={expanded}
      showCompactPreview={isLatestTurn}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onExpandedChange={(nextExpanded) =>
        setExpanded(routeThreadKey, turnSummary.turnId, nextExpanded)
      }
      onToggleAllDirectories={() => setAllDirectoriesExpanded((current) => !current)}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageElementContextChip = memo(function UserMessageElementContextChip(props: {
  context: ParsedElementContextEntry;
}) {
  const tooltipText = props.context.body
    ? `${props.context.header}\n${props.context.body}`
    : props.context.header;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs text-foreground/85">
            <MousePointerClickIcon className="size-3 shrink-0" />
            <span className="truncate">{props.context.header}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
});

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation;
  image: NonNullable<TimelineMessage["attachments"]>[number] | null;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="mb-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-xs font-medium text-foreground/90">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-[10px] text-muted-foreground",
            props.annotation.comment && "mt-1",
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  messageId: MessageId;
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealedByFind = use(TimelineFindRevealedEntriesCtx).has(props.messageId);
  // Find opens this body by pressing the same control the reader would, rather
  // than by holding it open beside the control. Forcing it open separately
  // leaves a button reading "Show full message" under a message already shown
  // in full, whose next press does nothing — and takes away the reader's
  // ability to collapse what the search opened.
  if (revealedByFind && !expanded) setExpanded(true);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-find-scope="true"
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const renderInlineMarkdownSegment = (text: string, key: string) => {
    const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? "";
    const textWithoutLeadingWhitespace = text.slice(leadingWhitespace.length);
    const trailingWhitespace = /\s+$/.exec(textWithoutLeadingWhitespace)?.[0] ?? "";
    const content = textWithoutLeadingWhitespace.slice(
      0,
      textWithoutLeadingWhitespace.length - trailingWhitespace.length,
    );

    return (
      <Fragment key={key}>
        {leadingWhitespace ? <span aria-hidden="true">{leadingWhitespace}</span> : null}
        {content ? (
          <ChatMarkdown
            text={content}
            cwd={props.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            skills={props.skills}
            className="text-foreground"
            lineBreaks
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    );
  };

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-sm leading-relaxed text-foreground">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-foreground"
                  lineBreaks
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard key={segment.comment.id} comment={segment.comment} />
          ),
        )}
      </div>
    );
  }

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            renderInlineMarkdownSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <ChatMarkdown
          key="user-message-terminal-context-inline-text"
          text={props.text}
          cwd={props.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={props.skills}
          className="text-foreground"
          lineBreaks
        />,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === "files" &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.requestKind === "command") return "terminal";
  if (workEntry.requestKind === "file-read") return "eye";
  if (workEntry.requestKind === "file-change") return "square-pen";

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "terminal";
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (workEntry.itemType === "web_search") return "globe";
  if (workEntry.itemType === "image_view") return "eye";

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return "hammer";
  }

  return workToneIcon(workEntry.tone).iconName;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const activity = use(TimelineRowActivityCtx);
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const entryIconName = showWarningIndicator ? "x" : workEntryIconName(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const expandedBody = buildToolCallExpandedBody(workEntry, workspaceRoot);
  const canExpand = expandedBody !== null;
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-muted-foreground/65"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground/82";
  const turnSettled = !activity.activeTurnInProgress;
  // Explicitly in flight. Kept apart from the neutral bucket because that one
  // means "no status at all" and renders as "Empty" — the wrong word for a
  // call that is running, and a worse one for an agent that is.
  const isInProgress = workEntry.toolLifecycleStatus === "inProgress";
  /**
   * A settled turn implies a finished call — for a FOREGROUND one.
   *
   * A background agent outlives the turn that spawned it by design, so the
   * turn ending is no evidence at all about the agent: its completion arrives
   * on the task feed as `task.completed`, which is what `deriveAgentRoster`
   * waits for and what this row never sees. Inferring success from the parent
   * turn painted a green check on an agent that was still working — and on one
   * that had been killed, which is the same lie from the other end.
   */
  const settledImpliesFinished = workEntry.itemType !== "collab_agent_tool_call";
  const showSuccessIndicator =
    !isInProgress &&
    (workEntryIndicatesToolSuccess(workEntry) ||
      (turnSettled && settledImpliesFinished && workEntryIndicatesToolNeutralStatus(workEntry)));
  // Running, and still claimed by a live turn — or a background agent, whose
  // turn's ending says nothing.
  const showRunningIndicator = isInProgress && (!turnSettled || !settledImpliesFinished);
  const showNeutralIndicator =
    !showRunningIndicator &&
    !showSuccessIndicator &&
    (isInProgress || (!turnSettled && workEntryIndicatesToolNeutralStatus(workEntry)));
  // An in-progress row whose turn has settled and which cannot outlive it is
  // the one case with no answer: nothing reported an ending, and nothing is
  // going to. Say that rather than claiming either outcome.
  const neutralIndicatorTooltip = isInProgress ? "No result reported" : "Empty";
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            {workEntry.sourceActivityKind === "provider.turn.start.failed" &&
              workEntry.retryMessageId &&
              workEntry.retryMessageId === ctx.retriableMessageId && (
                <RetryTurnStartButton messageId={workEntry.retryMessageId} />
              )}
            {workEntry.sourceActivityKind === "provider.turn.start.failed" && (
              <ReportTurnStartFailureLink
                detail={workEntry.detail}
                createdAt={workEntry.createdAt}
                messageId={workEntry.retryMessageId}
              />
            )}
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showRunningIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    {/* A static mark, not a spinner: these rows sit on screen
                        for the length of a build and a repainting one costs a
                        frame budget for no information. */}
                    <EllipsisIcon
                      data-testid="work-entry-running"
                      className="block size-3 shrink-0 text-muted-foreground/70"
                      aria-hidden
                    />
                  </TooltipTrigger>
                  <TooltipPopup>Running</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>{neutralIndicatorTooltip}</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
            {expandedBody}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
