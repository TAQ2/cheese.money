import { parseScopedThreadKey, scopeThreadRef } from "@ch3tools/client-runtime/environment";
import type { EnvironmentId, KanbanCardType } from "@ch3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIcon,
  GripVerticalIcon,
  LoaderIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "../../lib/utils";
import { readEnvironmentSupportsKanban, useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { canSettle } from "@ch3tools/client-runtime/state/thread-settled";
// Structural check instead of AsyncResult.isFailure: the thread actions
// return unions of differently-typed failures, which defeats the generic.
function isCommandFailure(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { readonly _tag?: string })._tag === "Failure"
  );
}
import { resolveSidebarV2Status } from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import {
  KANBAN_ALL_FILTERS,
  adjacentKanbanColumn,
  buildKanbanBoard,
  kanbanCardType,
  kanbanProjectKey,
  kanbanPushTarget,
  planKanbanMove,
  resolveKanbanColumn,
  type KanbanBoardSettings,
  type KanbanColumnCells,
  type KanbanFilters,
} from "./Kanban.logic";
import { KanbanCard } from "./KanbanCard";
import {
  KANBAN_CUSTOM_ACCENTS,
  KANBAN_TYPE_COLOR_CHOICES,
  KANBAN_WIP_OPTIONS,
  isBuiltinKanbanColumn,
  kanbanColumnConfig,
  resolveKanbanCardTypes,
  resolveKanbanColumns,
  type KanbanCardTypeConfig,
  type KanbanColumnConfig,
  type KanbanColumnId,
} from "./kanbanConfig";

/** Drag payload type for column reordering — distinct from the cards' plain
    text payload so a column drop can never be misread as a card move. */
const KANBAN_COLUMN_DRAG_TYPE = "application/x-ch3-kanban-column";

/** Coarse clock for column derivation — snooze wakes and settle windows only
    need minute resolution, and a coarse tick keeps the board memo stable. */
function useMinuteNow(): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date().toISOString()), 30_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

/**
 * Reports which threads in one environment have a terminal subprocess running
 * (an orchestration script, a long build) — those cards stay submerged in the
 * agent lane even while the conversation itself is idle. One probe per
 * environment because the terminal metadata subscription is per-environment.
 */
function TerminalActivityProbe({
  environmentId,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly onChange: (environmentId: EnvironmentId, threadIds: ReadonlyArray<string>) => void;
}) {
  const sessions = useKnownTerminalSessions({ environmentId, threadId: null });
  const runningThreadIds = useMemo(
    () =>
      [
        ...new Set(
          sessions
            .filter((session) => session.state.hasRunningSubprocess)
            .map((session) => String(session.target.threadId)),
        ),
      ].toSorted(),
    [sessions],
  );
  const serialized = runningThreadIds.join("\n");
  useEffect(() => {
    onChange(environmentId, runningThreadIds);
    // serialized stands in for runningThreadIds: same ids, same array identity
    // churn from the subscription must not re-fire the parent update. On
    // unmount (environment removed) the entry is cleared so its threads do
    // not stay submerged forever.
    return () => onChange(environmentId, []);
  }, [environmentId, onChange, serialized]);
  return null;
}

export function KanbanBoardView() {
  const router = useRouter();
  const threads = useThreadShells();
  const projects = useProjects();
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const updateKanban = useAtomCommand(threadEnvironment.updateKanban);
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread } = useThreadActions();
  const { environments } = useEnvironments();
  const now = useMinuteNow();

  const [runningTerminalsByEnv, setRunningTerminalsByEnv] = useState<
    Readonly<Record<string, ReadonlyArray<string>>>
  >({});
  const handleTerminalActivity = useCallback(
    (environmentId: EnvironmentId, threadIds: ReadonlyArray<string>) => {
      setRunningTerminalsByEnv((current) => {
        const key = String(environmentId);
        const previous = current[key] ?? [];
        if (
          previous.length === threadIds.length &&
          previous.every((id, index) => id === threadIds[index])
        ) {
          return current;
        }
        return { ...current, [key]: threadIds };
      });
    },
    [],
  );
  const runningTerminalThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [environmentId, threadIds] of Object.entries(runningTerminalsByEnv)) {
      for (const threadId of threadIds) {
        keys.add(`${environmentId}:${threadId}`);
      }
    }
    return keys;
  }, [runningTerminalsByEnv]);

  const [filters, setFilters] = useState<KanbanFilters>({ cardType: "all", projectKey: "all" });
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [notice, setNotice] = useState<{
    readonly text: string;
    readonly columnId: KanbanColumnId | null;
  } | null>(null);
  // F3: rejection feedback lands ON the rejecting column, not 1200px away in
  // the header — the header chip stays as a fallback for column-less notices.
  const showNotice = useCallback(
    (text: string, columnId: KanbanColumnId | null = null) => setNotice({ text, columnId }),
    [],
  );
  const [dragOverColumn, setDragOverColumn] = useState<KanbanColumnId | null>(null);
  const [snoozeChoice, setSnoozeChoice] = useState<{
    readonly thread: SidebarThreadSummary;
    readonly from: KanbanColumnId;
  } | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnLabel, setNewColumnLabel] = useState("");
  const [typeManagerOpen, setTypeManagerOpen] = useState(false);
  const [newTypeLabel, setNewTypeLabel] = useState("");
  const [newTypeGlow, setNewTypeGlow] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<{
    readonly thread: SidebarThreadSummary;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  // In-flight re-categorizations, keyed by scoped thread key. Completion is
  // observed, not assumed: the classifier's write bumps kanban.classifiedAt
  // past the baseline captured at request time, and only that (or the
  // deadline) resolves the entry — never a timer pretending to know.
  const [reclassifying, setReclassifying] = useState<
    Readonly<
      Record<
        string,
        {
          readonly from: KanbanColumnId;
          readonly baseline: string | null;
          readonly deadlineMs: number;
          readonly title: string;
        }
      >
    >
  >({});
  const [toast, setToast] = useState<{
    readonly text: string;
    readonly tone: "success" | "error";
  } | null>(null);
  // You/Agents lane split: fraction of the lane area the user band takes.
  // Defaults to the middle; the divider drags it live and double-click
  // resets. Deliberately ephemeral — every visit starts at the spec's 50/50.
  const [laneSplit, setLaneSplit] = useState(0.5);
  const laneDragRef = useRef<{ readonly top: number; readonly height: number } | null>(null);

  const handleDividerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const grid = event.currentTarget.parentElement;
    const userLane = grid?.querySelector(".kanban-gutter-user");
    const agentLane = grid?.querySelector(".kanban-gutter-agent");
    if (!userLane || !agentLane) {
      return;
    }
    const top = userLane.getBoundingClientRect().top;
    const height = agentLane.getBoundingClientRect().bottom - top;
    if (height <= 0) {
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No capturable pointer (synthetic events, exotic inputs): the drag
      // still works while the pointer stays over the handle.
    }
    laneDragRef.current = { top, height };
  }, []);
  const handleDividerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = laneDragRef.current;
    if (drag === null) {
      return;
    }
    // Clamped so neither lane can vanish under the divider.
    const ratio = Math.min(Math.max((event.clientY - drag.top) / drag.height, 0.15), 0.85);
    setLaneSplit(ratio);
  }, []);
  const handleDividerPointerUp = useCallback(() => {
    laneDragRef.current = null;
  }, []);

  useEffect(() => {
    if (notice === null) {
      return;
    }
    const timeout = setTimeout(() => setNotice(null), 5_000);
    return () => clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timeout = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(timeout);
  }, [toast]);

  const columns = useMemo(
    () => resolveKanbanColumns(settings.kanbanCustomColumns, settings.kanbanColumnOrder),
    [settings.kanbanCustomColumns, settings.kanbanColumnOrder],
  );
  const cardTypes = useMemo(
    () => resolveKanbanCardTypes(settings.kanbanCustomCardTypes),
    [settings.kanbanCustomCardTypes],
  );

  const boardSettings: KanbanBoardSettings = useMemo(
    () => ({
      now,
      autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
      wipLimits: settings.kanbanWipLimits,
      runningTerminalThreadKeys,
      columns,
      cardTypes,
    }),
    [
      now,
      settings.sidebarAutoSettleAfterDays,
      settings.kanbanWipLimits,
      runningTerminalThreadKeys,
      columns,
      cardTypes,
    ],
  );

  const board = useMemo(
    () => buildKanbanBoard(threads, boardSettings, filters),
    [threads, boardSettings, filters],
  );
  // WIP planning must see the whole column, not the filtered view — a filter
  // must never open a hole in a limit or pick the wrong displacement victim.
  const planningBoard = useMemo(
    () => buildKanbanBoard(threads, boardSettings, KANBAN_ALL_FILTERS),
    [threads, boardSettings],
  );

  // The filter only offers projects with live work on the board: at least one
  // thread that is neither archived nor settled. A project you registered
  // once and finished months ago is noise in this dropdown.
  const filterableProjects = useMemo(() => {
    const activeProjectKeys = new Set(
      threads
        .filter(
          (thread) =>
            thread.archivedAt == null && resolveKanbanColumn(thread, boardSettings) !== "settled",
        )
        .map(kanbanProjectKey),
    );
    return projects.filter((project) =>
      activeProjectKeys.has(`${project.environmentId}:${project.id}`),
    );
  }, [threads, projects, boardSettings]);

  // If the selected project loses its last live thread, fall back to All
  // instead of filtering the board by an option that no longer exists.
  useEffect(() => {
    if (
      filters.projectKey !== "all" &&
      !filterableProjects.some(
        (project) => `${project.environmentId}:${project.id}` === filters.projectKey,
      )
    ) {
      setFilters((current) => ({ ...current, projectKey: "all" }));
    }
  }, [filterableProjects, filters.projectKey]);

  // Title + workspace root per project: the card renders a favicon from the
  // root (folder-icon fallback) plus the name, so a card's project is always
  // legible instead of a tooltip-only dot.
  const projectMeta = useMemo(() => {
    const meta = new Map<string, { readonly title: string; readonly cwd: string }>();
    for (const project of projects) {
      meta.set(`${project.environmentId}:${project.id}`, {
        title: project.title,
        cwd: project.workspaceRoot,
      });
    }
    return meta;
  }, [projects]);

  const dispatchKanban = useCallback(
    (
      thread: SidebarThreadSummary,
      input: {
        readonly stage?: KanbanColumnId;
        readonly cardType?: KanbanCardType;
        readonly deadline?: string | null;
        readonly pinned?: boolean;
        readonly reclassify?: true;
      },
    ) => {
      // Version skew: every kanban command (moves, type, deadline, pin) is
      // gated, mirroring settle/snooze.
      if (!readEnvironmentSupportsKanban(thread.environmentId)) {
        showNotice("This environment's server does not support the Kanban board yet.");
        return Promise.resolve(false);
      }
      const { stage, ...rest } = input;
      return updateKanban({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          ...(stage !== undefined && stage !== "snoozed" && stage !== "settled" ? { stage } : {}),
          ...rest,
          source: "user",
        },
      }).then((result) => {
        // F1: the client-side guards speak up, so a server refusal must too —
        // otherwise the card silently snaps back and the user learns nothing.
        if (isCommandFailure(result)) {
          showNotice(
            "The server rejected that change — the card kept its place.",
            stage !== undefined && stage !== "snoozed" && stage !== "settled" ? stage : null,
          );
          return false;
        }
        return true;
      });
    },
    [showNotice, updateKanban],
  );

  const moveCardTo = useCallback(
    (thread: SidebarThreadSummary, target: KanbanColumnId) => {
      const from = resolveKanbanColumn(thread, boardSettings);
      if (from === target) {
        return;
      }
      const plan = planKanbanMove({
        card: thread,
        from,
        target,
        board: planningBoard,
        columns,
        cardTypes,
      });
      if (plan.kind === "blocked") {
        if (plan.reason.length > 0) {
          showNotice(plan.reason, target);
        }
        return;
      }
      const ref = scopeThreadRef(thread.environmentId, thread.id);

      if (target === "snoozed") {
        // The wake time is the user's call — open the preset chooser instead
        // of guessing a duration.
        setSnoozeChoice({ thread, from });
        return;
      }
      if (target === "settled") {
        // Guard FIRST: a blocked move must be a total no-op — unsnoozing and
        // then refusing to settle would yank the card out of Snoozed anyway.
        if (!canSettle(thread, { now: new Date().toISOString() })) {
          showNotice("Can't settle: the conversation is running or waiting on you.", "settled");
          return;
        }
        if (from === "snoozed") {
          void unsnoozeThread(ref);
        }
        void settleThread(ref).then((result) => {
          if (isCommandFailure(result)) {
            showNotice("Couldn't settle — the server refused.", "settled");
          }
        });
        return;
      }

      // Leaving a derived column re-activates the underlying lifecycle state.
      if (from === "snoozed") {
        void unsnoozeThread(ref);
      }
      if (from === "settled") {
        void unsettleThread(ref);
      }

      // An urgent card entering a full column displaces the newest non-urgent,
      // un-pinned occupant one column to the left — WIP protection with an
      // escape hatch. Same-column pushes are meaningless; skip the dispatch.
      if (plan.pushThread) {
        if (kanbanPushTarget(target, columns) === target) {
          showNotice("Nowhere to push left from here — the column runs over its limit.", target);
        } else {
          void dispatchKanban(plan.pushThread, { stage: kanbanPushTarget(target, columns) });
        }
      }
      void dispatchKanban(thread, { stage: target, pinned: true });
    },
    [
      planningBoard,
      boardSettings,
      cardTypes,
      columns,
      dispatchKanban,
      settleThread,
      showNotice,
      snoozeThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );

  const handleArrowMove = useCallback(
    (thread: SidebarThreadSummary, direction: -1 | 1) => {
      const from = resolveKanbanColumn(thread, boardSettings);
      const target = adjacentKanbanColumn(from, direction, columns);
      if (target !== null) {
        moveCardTo(thread, target);
      }
    },
    [boardSettings, columns, moveCardTo],
  );

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [router],
  );

  // Drag-reorder for custom columns: drop the dragged column at the target's
  // position (after it when moving right, before it when moving left). The
  // whole visible order is persisted; the resolver pins Snoozed/Settled to
  // the ends, so even a drop on an endpoint lands in the nearest legal slot.
  const reorderColumn = useCallback(
    (draggedId: KanbanColumnId, targetId: KanbanColumnId) => {
      if (draggedId === targetId) {
        return;
      }
      const ids = columns.map((entry) => entry.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) {
        return;
      }
      ids.splice(from, 1);
      // Post-removal, index `to` lands after the target when moving right and
      // before it when moving left — exactly the intuitive drop in each case.
      const insertAt = Math.min(Math.max(to, 1), ids.length - 1);
      ids.splice(insertAt, 0, draggedId);
      updateSettings({ kanbanColumnOrder: ids });
    },
    [columns, updateSettings],
  );

  const handleDrop = useCallback(
    (event: DragEvent, target: KanbanColumnId) => {
      event.preventDefault();
      setDragOverColumn(null);
      const draggedColumnId = event.dataTransfer.getData(KANBAN_COLUMN_DRAG_TYPE);
      if (draggedColumnId.length > 0) {
        reorderColumn(draggedColumnId, target);
        return;
      }
      const ref = parseScopedThreadKey(event.dataTransfer.getData("text/plain"));
      if (ref === null) {
        return;
      }
      const thread = threads.find(
        (entry) => entry.environmentId === ref.environmentId && entry.id === ref.threadId,
      );
      if (thread) {
        moveCardTo(thread, target);
      }
    },
    [moveCardTo, reorderColumn, threads],
  );

  const setColumnWip = useCallback(
    (columnId: KanbanColumnId, value: string) => {
      updateSettings({
        kanbanWipLimits: {
          ...settings.kanbanWipLimits,
          [columnId]: value === "inf" ? null : Number(value),
        },
      });
    },
    [settings.kanbanWipLimits, updateSettings],
  );

  const addColumn = useCallback(() => {
    const label = newColumnLabel.trim();
    if (label.length === 0) {
      return;
    }
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    const id = `custom-${slug.length > 0 ? slug : "column"}-${Math.random().toString(36).slice(2, 6)}`;
    const accent =
      KANBAN_CUSTOM_ACCENTS[settings.kanbanCustomColumns.length % KANBAN_CUSTOM_ACCENTS.length]!;
    // A saved order does not know the new id; splice it in at the default
    // spot (before Final review) so it appears where an orderless board
    // would have put it instead of falling to the resolver's fallback.
    const orderPatch =
      settings.kanbanColumnOrder.length > 0
        ? {
            kanbanColumnOrder: columns.flatMap((entry) =>
              entry.id === "final-review" ? [id, entry.id] : [entry.id],
            ),
          }
        : {};
    updateSettings({
      kanbanCustomColumns: [...settings.kanbanCustomColumns, { id, label, accent }],
      ...orderPatch,
    });
    setNewColumnLabel("");
    setAddingColumn(false);
  }, [columns, newColumnLabel, settings.kanbanColumnOrder, settings.kanbanCustomColumns, updateSettings]);

  const deleteColumn = useCallback(
    (columnId: KanbanColumnId) => {
      updateSettings({
        kanbanCustomColumns: settings.kanbanCustomColumns.filter((entry) => entry.id !== columnId),
        kanbanColumnOrder: settings.kanbanColumnOrder.filter((entry) => entry !== columnId),
        kanbanWipLimits: Object.fromEntries(
          Object.entries(settings.kanbanWipLimits).filter(([key]) => key !== columnId),
        ),
      });
      showNotice("Column removed — its cards fall back to Exploration.");
    },
    [
      settings.kanbanColumnOrder,
      settings.kanbanCustomColumns,
      settings.kanbanWipLimits,
      showNotice,
      updateSettings,
    ],
  );

  const usedTypeGlows = useMemo(
    () => new Set(cardTypes.map((entry) => entry.glow.toLowerCase())),
    [cardTypes],
  );
  const availableTypeColors = useMemo(
    () => KANBAN_TYPE_COLOR_CHOICES.filter((color) => !usedTypeGlows.has(color.toLowerCase())),
    [usedTypeGlows],
  );

  const addCardType = useCallback(() => {
    const label = newTypeLabel.trim();
    const glow = newTypeGlow ?? availableTypeColors[0];
    if (label.length === 0 || glow === undefined) {
      return;
    }
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    const id = `type-${slug.length > 0 ? slug : "custom"}-${Math.random().toString(36).slice(2, 6)}`;
    updateSettings({
      kanbanCustomCardTypes: [...settings.kanbanCustomCardTypes, { id, label, glow }],
    });
    setNewTypeLabel("");
    setNewTypeGlow(null);
  }, [
    availableTypeColors,
    newTypeGlow,
    newTypeLabel,
    settings.kanbanCustomCardTypes,
    updateSettings,
  ]);

  const deleteCardType = useCallback(
    (id: string) => {
      updateSettings({
        kanbanCustomCardTypes: settings.kanbanCustomCardTypes.filter((entry) => entry.id !== id),
      });
    },
    [settings.kanbanCustomCardTypes, updateSettings],
  );

  const runCategorization = useCallback(
    (thread: SidebarThreadSummary) => {
      setCardMenu(null);
      // The classification reactor refuses to read a running turn — surface
      // that up front instead of spinning until the timeout.
      if (resolveSidebarV2Status(thread) === "working") {
        setToast({
          text: "Can't re-categorize while the agent is working — try again when the turn finishes.",
          tone: "error",
        });
        return;
      }
      const key = `${thread.environmentId}:${thread.id}`;
      // Unpin + request: the user explicitly asked the model to re-file this
      // card, so the classifier may move it again.
      setReclassifying((current) => ({
        ...current,
        [key]: {
          from: resolveKanbanColumn(thread, boardSettings),
          baseline: thread.kanban?.classifiedAt ?? null,
          deadlineMs: Date.now() + 120_000,
          title: thread.title,
        },
      }));
      void dispatchKanban(thread, { pinned: false, reclassify: true }).then((accepted) => {
        if (!accepted) {
          setReclassifying(({ [key]: _dropped, ...rest }) => rest);
        }
      });
    },
    [boardSettings, dispatchKanban],
  );

  // Resolve pending re-categorizations from observed state: the classifier's
  // write bumps classifiedAt, and the resulting column is read back off the
  // thread itself — the toast reports what actually happened, not what was
  // requested. The deadline catches the reactor's silent refusals (archived
  // mid-flight, empty context, a turn that started while the model read).
  const hasReclassifying = Object.keys(reclassifying).length > 0;
  const [reclassifyTick, setReclassifyTick] = useState(0);
  useEffect(() => {
    if (!hasReclassifying) {
      return;
    }
    const interval = setInterval(() => setReclassifyTick((tick) => tick + 1), 5_000);
    return () => clearInterval(interval);
  }, [hasReclassifying]);
  useEffect(() => {
    const entries = Object.entries(reclassifying);
    if (entries.length === 0) {
      return;
    }
    const nowMs = Date.now();
    const resolved: string[] = [];
    let nextToast: { readonly text: string; readonly tone: "success" | "error" } | null = null;
    for (const [key, entry] of entries) {
      const thread = threads.find(
        (candidate) => `${candidate.environmentId}:${candidate.id}` === key,
      );
      if (thread === undefined || thread.archivedAt != null) {
        resolved.push(key);
        continue;
      }
      const classifiedAt = thread.kanban?.classifiedAt ?? null;
      if (classifiedAt !== null && classifiedAt !== entry.baseline) {
        const to = resolveKanbanColumn(thread, boardSettings);
        const label = kanbanColumnConfig(to, columns).label;
        nextToast = {
          text:
            to === entry.from
              ? `Categorized to “${label}” (stays put)`
              : `Categorized to “${label}” — moved from “${kanbanColumnConfig(entry.from, columns).label}”`,
          tone: "success",
        };
        resolved.push(key);
        continue;
      }
      if (nowMs >= entry.deadlineMs) {
        nextToast = {
          text: `No answer from the classifier — “${entry.title}” kept its place.`,
          tone: "error",
        };
        resolved.push(key);
      }
    }
    if (resolved.length > 0) {
      setReclassifying((current) => {
        const next = { ...current };
        for (const key of resolved) {
          delete next[key];
        }
        return next;
      });
      if (nextToast !== null) {
        setToast(nextToast);
      }
    }
  }, [threads, reclassifying, reclassifyTick, boardSettings, columns]);

  const confirmSnooze = useCallback(
    (choice: { thread: SidebarThreadSummary; from: KanbanColumnId }, preset: SnoozePreset) => {
      setSnoozeChoice(null);
      const ref = scopeThreadRef(choice.thread.environmentId, choice.thread.id);
      // Snoozing out of Settled must also unsettle, or the card silently
      // returns to Settled on wake instead of the board.
      if (choice.from === "settled") {
        void unsettleThread(ref);
      }
      void snoozeThread(ref, preset.snoozedUntil).then((result) => {
        if (isCommandFailure(result)) {
          showNotice("Couldn't snooze — the server refused.", "snoozed");
        }
      });
    },
    [showNotice, snoozeThread, unsettleThread],
  );

  return (
    <div
      data-testid="kanban-board"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      {environments.map((environment) => (
        <TerminalActivityProbe
          key={environment.environmentId}
          environmentId={environment.environmentId}
          onChange={handleTerminalActivity}
        />
      ))}
      <header className="flex flex-none flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="text-sm font-semibold">Kanban</h1>
        <select
          aria-label="Filter by card type"
          className="rounded-md border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground"
          value={filters.cardType}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              cardType: event.target.value as KanbanFilters["cardType"],
            }))
          }
        >
          <option value="all">All types</option>
          {cardTypes.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by project"
          className="max-w-48 rounded-md border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground"
          value={filters.projectKey}
          onChange={(event) =>
            setFilters((current) => ({ ...current, projectKey: event.target.value }))
          }
        >
          <option value="all">All projects</option>
          {filterableProjects.map((project) => (
            <option
              key={`${project.environmentId}:${project.id}`}
              value={`${project.environmentId}:${project.id}`}
            >
              {project.title}
            </option>
          ))}
        </select>
        {notice ? (
          <span className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive-foreground">
            {notice.text}
          </span>
        ) : null}
        <span className="flex-1" />
        {editMode ? (
          addingColumn ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                addColumn();
              }}
            >
              <input
                autoFocus
                aria-label="New column name"
                placeholder="Column name…"
                className="w-36 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary"
                value={newColumnLabel}
                onChange={(event) => setNewColumnLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setAddingColumn(false);
                    setNewColumnLabel("");
                  }
                }}
              />
              <button
                type="submit"
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
              >
                Add
              </button>
            </form>
          ) : (
            <button
              type="button"
              data-testid="kanban-add-column"
              title="Add a column — it becomes a stage cards can be filed into"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setAddingColumn(true)}
            >
              <PlusIcon className="size-3.5" />
              Column
            </button>
          )
        ) : null}
        {editMode ? (
          <div className="relative">
          <button
            type="button"
            data-testid="kanban-add-type"
            title="Create and manage card types"
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
              typeManagerOpen && "bg-accent text-foreground",
            )}
            onClick={() => setTypeManagerOpen((open) => !open)}
          >
            <PlusIcon className="size-3.5" />
            Type
          </button>
          {typeManagerOpen ? (
            <div className="absolute top-full right-0 z-40 mt-1 w-64 rounded-lg border border-border bg-popover p-2 shadow-2xl">
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  addCardType();
                }}
              >
                <input
                  aria-label="New card type name"
                  placeholder="Type name…"
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary"
                  value={newTypeLabel}
                  onChange={(event) => setNewTypeLabel(event.target.value)}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  {availableTypeColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use color ${color}`}
                      className={cn(
                        "size-5 rounded-full border-2",
                        (newTypeGlow ?? availableTypeColors[0]) === color
                          ? "border-foreground"
                          : "border-transparent",
                      )}
                      style={{ backgroundColor: color }}
                      onClick={() => setNewTypeGlow(color)}
                    />
                  ))}
                  {availableTypeColors.length === 0 ? (
                    <span className="text-[10px] text-muted-foreground">
                      All colors are in use — delete a type first.
                    </span>
                  ) : null}
                </div>
                <button
                  type="submit"
                  disabled={newTypeLabel.trim().length === 0 || availableTypeColors.length === 0}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40"
                >
                  Create type
                </button>
              </form>
              {settings.kanbanCustomCardTypes.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                  {settings.kanbanCustomCardTypes.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-1.5 text-xs">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: entry.glow }}
                      />
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      <button
                        type="button"
                        aria-label={`Delete type ${entry.label}`}
                        className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-destructive-foreground"
                        onClick={() => deleteCardType(entry.id)}
                      >
                        <Trash2Icon className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          </div>
        ) : null}
        <button
          type="button"
          data-testid="kanban-metrics-toggle"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
            metricsOpen && "bg-accent text-foreground",
          )}
          onClick={() => setMetricsOpen((open) => !open)}
        >
          <ChartNoAxesColumnIcon className="size-3.5" />
          Metrics
        </button>
        <button
          type="button"
          data-testid="kanban-edit-toggle"
          title="Edit the board — add columns and card types, delete or drag custom columns"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
            editMode && "border-primary/50 bg-accent text-foreground",
          )}
          onClick={() =>
            setEditMode((open) => {
              if (open) {
                setAddingColumn(false);
                setNewColumnLabel("");
                setTypeManagerOpen(false);
              }
              return !open;
            })
          }
        >
          <PencilIcon className="size-3.5" />
          {editMode ? "Done" : "Edit"}
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {cardMenu ? (
          <>
            <button
              type="button"
              aria-label="Close menu"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setCardMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setCardMenu(null);
              }}
            />
            <div
              className="fixed z-50 min-w-44 rounded-lg border border-border bg-popover p-1 shadow-2xl"
              style={{ left: cardMenu.x, top: cardMenu.y }}
            >
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => runCategorization(cardMenu.thread)}
              >
                Run categorization
              </button>
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => {
                  const thread = cardMenu.thread;
                  setCardMenu(null);
                  openThread(thread);
                }}
              >
                Open conversation
              </button>
            </div>
          </>
        ) : null}
        {/* Non-blocking status stack: pointer-events pass straight through,
            so a running classification never costs the user the board. */}
        {hasReclassifying || toast !== null ? (
          <div className="pointer-events-none absolute top-3 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
            {hasReclassifying ? (
              <div
                data-testid="kanban-reclassify-loader"
                className="flex items-center gap-2 rounded-full border border-border bg-popover/95 px-3 py-1.5 text-xs shadow-lg"
              >
                <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                <span>
                  {Object.keys(reclassifying).length === 1
                    ? `Re-categorizing “${Object.values(reclassifying)[0]!.title}”…`
                    : `Re-categorizing ${Object.keys(reclassifying).length} cards…`}
                </span>
              </div>
            ) : null}
            {toast !== null ? (
              <div
                data-testid="kanban-toast"
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs shadow-lg",
                  toast.tone === "success"
                    ? "border-border bg-popover/95 text-foreground"
                    : "border-destructive/40 bg-destructive/15 text-destructive-foreground",
                )}
              >
                {toast.text}
              </div>
            ) : null}
          </div>
        ) : null}
        {snoozeChoice ? (
          <div className="absolute top-4 left-1/2 z-40 flex w-max max-w-[36rem] -translate-x-1/2 flex-col gap-2 rounded-xl border border-border bg-popover p-3 shadow-2xl">
            <span className="text-xs text-muted-foreground">
              Snooze &ldquo;{snoozeChoice.thread.title}&rdquo; until
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {resolveSnoozePresets(new Date()).map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                  onClick={() => confirmSnooze(snoozeChoice, preset)}
                >
                  {preset.label} · {preset.whenLabel}
                </button>
              ))}
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                onClick={() => setSnoozeChoice(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {/* One scrollport for the whole board: both bands move together, so a
            column's two halves can never drift out of alignment. */}
        <div className="kanban-scrollport min-h-0 flex-1 overflow-x-auto overflow-y-hidden py-3">
          <div
            className="kanban-grid"
            // Track widths live in the stylesheet; the column count and the
            // live lane split are data, the two things CSS cannot read off
            // the board.
            style={
              {
                gridTemplateColumns: `var(--kanban-gutter) repeat(${board.length}, var(--kanban-col))`,
                "--kanban-user-fr": `${Math.round(laneSplit * 1000)}fr`,
                "--kanban-agent-fr": `${Math.round((1 - laneSplit) * 1000)}fr`,
              } as CSSProperties
            }
          >
            <div className="kanban-band-agent" aria-hidden="true" />
            <div className="kanban-gutter kanban-gutter-user" data-testid="kanban-lane-user">
              <span className="kanban-gutter-label">You</span>
            </div>
            <div className="kanban-gutter kanban-gutter-agent" data-testid="kanban-lane-agent">
              <span className="kanban-gutter-label">Agents</span>
            </div>
            {board.map((cell, index) => (
              <KanbanColumn
                key={cell.columnId}
                cell={cell}
                // Column 1 is the label gutter. Explicit tracks, because a
                // band spanning every cell of its row would otherwise push
                // auto-placed columns out of the explicit grid entirely.
                track={index + 2}
                dragOver={dragOverColumn === cell.columnId}
                noticeText={notice?.columnId === cell.columnId ? notice.text : null}
                columns={columns}
                cardTypes={cardTypes}
                editMode={editMode}
                onDeleteColumn={isBuiltinKanbanColumn(cell.columnId) ? null : deleteColumn}
                onCardContextMenu={(thread, x, y) => setCardMenu({ thread, x, y })}
                projectMeta={projectMeta}
                onDragEnter={() => setDragOverColumn(cell.columnId)}
                onDragLeaveColumn={() => setDragOverColumn(null)}
                onDrop={handleDrop}
                onSetWip={setColumnWip}
                onOpen={openThread}
                onMove={handleArrowMove}
                onSetType={(thread, cardType) => {
                  void dispatchKanban(thread, {
                    cardType,
                    // Choosing "deadline" without a date seeds one a week out so
                    // the card immediately shows an editable date field.
                    ...(cardType === "deadline" && thread.kanban?.deadline == null
                      ? { deadline: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString() }
                      : {}),
                  });
                }}
                onSetDeadline={(thread, deadline) => void dispatchKanban(thread, { deadline })}
                onTogglePin={(thread) =>
                  void dispatchKanban(thread, { pinned: thread.kanban?.pinned !== true })
                }
              />
            ))}
            {/* Stacked above the columns and the sticky gutter, so the line
                between the bands never breaks. Also the lane resize handle. */}
            <div
              className="kanban-divider"
              data-testid="kanban-lane-divider"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the You and Agents lanes"
              title="Drag to resize the lanes — double-click to reset to the middle"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              onPointerCancel={handleDividerPointerUp}
              onDoubleClick={() => setLaneSplit(0.5)}
            />
          </div>
        </div>

        {metricsOpen ? (
          <KanbanMetricsPanel
            board={board}
            threads={threads}
            columns={columns}
            cardTypes={cardTypes}
            now={now}
            onClose={() => setMetricsOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function KanbanColumn({
  cell,
  track,
  dragOver,
  noticeText,
  columns,
  cardTypes,
  editMode,
  onDeleteColumn,
  onCardContextMenu,
  projectMeta,
  onDragEnter,
  onDragLeaveColumn,
  onDrop,
  onSetWip,
  onOpen,
  onMove,
  onSetType,
  onSetDeadline,
  onTogglePin,
}: {
  readonly cell: KanbanColumnCells;
  /** 1-based grid column track this column occupies in both bands. */
  readonly track: number;
  readonly dragOver: boolean;
  /** Rejection message anchored to THIS column (F3). */
  readonly noticeText: string | null;
  readonly columns: ReadonlyArray<KanbanColumnConfig>;
  readonly cardTypes: ReadonlyArray<KanbanCardTypeConfig>;
  /** Board edit mode: shows delete affordances and enables column drag. */
  readonly editMode: boolean;
  /** Present only for user-created columns — built-ins cannot be deleted. */
  readonly onDeleteColumn: ((columnId: KanbanColumnId) => void) | null;
  readonly onCardContextMenu: (thread: SidebarThreadSummary, x: number, y: number) => void;
  readonly projectMeta: ReadonlyMap<string, { readonly title: string; readonly cwd: string }>;
  readonly onDragEnter: () => void;
  readonly onDragLeaveColumn: () => void;
  readonly onDrop: (event: DragEvent, target: KanbanColumnId) => void;
  readonly onSetWip: (columnId: KanbanColumnId, value: string) => void;
  readonly onOpen: (thread: SidebarThreadSummary) => void;
  readonly onMove: (thread: SidebarThreadSummary, direction: -1 | 1) => void;
  readonly onSetType: (thread: SidebarThreadSummary, cardType: KanbanCardType) => void;
  readonly onSetDeadline: (thread: SidebarThreadSummary, deadline: string | null) => void;
  readonly onTogglePin: (thread: SidebarThreadSummary) => void;
}) {
  const config = kanbanColumnConfig(cell.columnId, columns);
  const occupancy = cell.userCards.length;
  const atLimit = cell.limit !== null && occupancy >= cell.limit;
  const isDerived = cell.columnId === "snoozed" || cell.columnId === "settled";
  const isEmpty =
    cell.userCards.length === 0 && cell.waitingCards.length === 0 && cell.agentCards.length === 0;
  const cardProps = (thread: SidebarThreadSummary, lane: "user" | "agent" | "waiting") => {
    const meta = projectMeta.get(`${thread.environmentId}:${thread.projectId}`);
    return {
    thread,
    lane,
    compact: isDerived,
    cardTypes,
    projectTitle: meta?.title ?? "Unknown project",
    projectCwd: meta?.cwd ?? "",
    canMoveLeft: adjacentKanbanColumn(cell.columnId, -1, columns) !== null,
    canMoveRight: adjacentKanbanColumn(cell.columnId, 1, columns) !== null,
    onContextMenu: onCardContextMenu,
    onOpen,
    onMove,
    onSetType,
    onSetDeadline,
    onTogglePin,
    };
  };

  return (
    <section
      data-testid={`kanban-column-${cell.columnId}`}
      className={cn(
        "kanban-column",
        dragOver && "kanban-column-dragover",
        isEmpty && "kanban-column-empty",
        noticeText !== null && "kanban-column-rejected",
      )}
      // The accent every tint in this column is mixed from — one hue in, a
      // header, a rail, a pill and a wash out.
      style={{ "--kanban-accent": config.accent, gridColumn: track } as CSSProperties}
      onDragOver={(event) => {
        event.preventDefault();
        onDragEnter();
      }}
      onDragLeave={(event) => {
        // Child boundary crossings fire dragleave too; only clear when the
        // pointer actually left the column.
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          onDragLeaveColumn();
        }
      }}
      onDrop={(event) => onDrop(event, cell.columnId)}
    >
      {/* Custom columns become drag handles in edit mode — the whole header
          drags, and the trash appears only then, so it can never intercept
          an attempted drag outside edit mode. */}
      <div
        className={cn("kanban-column-head", editMode && onDeleteColumn !== null && "cursor-grab")}
        title={config.hint}
        draggable={editMode && onDeleteColumn !== null}
        onDragStart={(event) => {
          event.dataTransfer.setData(KANBAN_COLUMN_DRAG_TYPE, cell.columnId);
          event.dataTransfer.effectAllowed = "move";
        }}
      >
        <div className="flex items-center gap-1.5">
          {editMode && onDeleteColumn !== null ? (
            <GripVerticalIcon
              aria-hidden="true"
              className="size-3 flex-none text-muted-foreground/60"
            />
          ) : null}
          <h2 className="kanban-column-title truncate text-xs font-semibold">{config.label}</h2>
          {editMode && onDeleteColumn !== null ? (
            <button
              type="button"
              aria-label={`Delete column ${config.label}`}
              title="Delete this column — its cards fall back to Exploration"
              className="rounded p-0.5 text-muted-foreground/50 hover:bg-accent hover:text-destructive-foreground"
              onClick={() => onDeleteColumn(cell.columnId)}
            >
              <Trash2Icon className="size-3" />
            </button>
          ) : null}
          <span className="flex-1" />
          {isDerived ? (
            <span className="kanban-column-count rounded-full px-1.5 text-[10px] tabular-nums">
              {occupancy}
            </span>
          ) : (
            // F8: one control states occupancy AND limit — the pill IS the
            // dropdown, so there is nothing to duplicate and the ⌄ affords it.
            <span
              className={cn(
                "relative inline-flex cursor-pointer items-center rounded-full border px-1.5 text-[10px] tabular-nums",
                atLimit
                  ? "border-transparent bg-warning font-semibold text-neutral-950"
                  : "kanban-column-count border-border/60 hover:border-border",
              )}
              title="Work-in-progress limit — click to change"
            >
              {occupancy}/{cell.limit === null ? "∞" : cell.limit}
              <span aria-hidden="true" className="ml-0.5 opacity-70">
                ⌄
              </span>
              <select
                aria-label={`WIP limit for ${config.label}`}
                className="absolute inset-0 cursor-pointer opacity-0"
                value={cell.limit === null ? "inf" : String(cell.limit)}
                onChange={(event) => onSetWip(cell.columnId, event.target.value)}
              >
                {KANBAN_WIP_OPTIONS.map((option) => (
                  <option
                    key={option === null ? "inf" : option}
                    value={option === null ? "inf" : option}
                  >
                    WIP {option === null ? "∞" : option}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>
        {/* F15: the taxonomy stays visible while it applies, not only when
            there is nothing to apply it to. */}
        <p className="kanban-column-hint truncate text-[10px] leading-tight text-muted-foreground/70">
          {config.hint}
        </p>
        {noticeText !== null ? (
          <p className="mt-0.5 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] leading-snug text-destructive-foreground">
            {noticeText}
          </p>
        ) : null}
      </div>

      <div className="kanban-cell">
        {cell.userCards.map((thread) => (
          <KanbanCard key={`${thread.environmentId}:${thread.id}`} {...cardProps(thread, "user")} />
        ))}
        {cell.waitingCards.length > 0 ? (
          <div className="mt-1 flex flex-col gap-2 rounded-lg border border-dashed border-border p-1.5">
            <span className="px-1 text-[10px] tracking-wide text-muted-foreground uppercase">
              Waiting to rise — column at limit
            </span>
            {cell.waitingCards.map((thread) => (
              <KanbanCard
                key={`${thread.environmentId}:${thread.id}`}
                {...cardProps(thread, "waiting")}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Always rendered, empty or not: the agent lane is a band, not a strip
          that appears under whichever column happens to be busy. */}
      <div className="kanban-cell kanban-cell-agent" data-testid={`kanban-agent-${cell.columnId}`}>
        {cell.agentCards.map((thread) => (
          <KanbanCard
            key={`${thread.environmentId}:${thread.id}`}
            {...cardProps(thread, "agent")}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The flow instrumentation from the prototype, demoted per spec to a hidden
 * side panel: live WIP per column, class-of-service mix, and a Little's Law
 * estimate from the last week's settle throughput.
 */
function KanbanMetricsPanel({
  board,
  threads,
  columns,
  cardTypes,
  now,
  onClose,
}: {
  readonly board: ReadonlyArray<KanbanColumnCells>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly columns: ReadonlyArray<KanbanColumnConfig>;
  readonly cardTypes: ReadonlyArray<KanbanCardTypeConfig>;
  readonly now: string;
  readonly onClose: () => void;
}) {
  const active = threads.filter((thread) => thread.archivedAt == null);
  const wip = board
    .filter((cell) => cell.columnId !== "snoozed" && cell.columnId !== "settled")
    .reduce(
      (sum, cell) =>
        sum + cell.userCards.length + cell.agentCards.length + cell.waitingCards.length,
      0,
    );
  const weekAgoMs = Date.parse(now) - 7 * 24 * 3_600_000;
  const settledLastWeek = active.filter(
    (thread) => thread.settledAt !== null && Date.parse(thread.settledAt) >= weekAgoMs,
  ).length;
  const throughputPerDay = settledLastWeek / 7;
  const predictedLeadDays = throughputPerDay > 0 ? wip / throughputPerDay : null;
  const typeCounts = cardTypes.map((entry) => ({
    ...entry,
    count: active.filter((thread) => kanbanCardType(thread) === entry.id).length,
  }));

  return (
    <aside
      data-testid="kanban-metrics-panel"
      // F2: an overlay sheet — the metrics must not steal a column's width.
      className="absolute inset-y-0 right-0 z-30 flex w-64 flex-none flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4 shadow-2xl"
    >
      <div className="flex items-center">
        <h2 className="text-xs font-semibold tracking-wide uppercase">Flow metrics</h2>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close metrics"
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <dl className="flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Work in progress</dt>
          <dd className="font-semibold tabular-nums">{wip}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Settled, last 7 days</dt>
          <dd className="font-semibold tabular-nums">{settledLastWeek}</dd>
        </div>
        <div className="flex justify-between" title="Little's Law: lead time = WIP ÷ throughput">
          <dt className="text-muted-foreground">Predicted lead time</dt>
          <dd className="font-semibold tabular-nums">
            {predictedLeadDays === null ? "—" : `${predictedLeadDays.toFixed(1)}d`}
          </dd>
        </div>
      </dl>

      <div>
        <h3 className="mb-1.5 text-[10px] tracking-wide text-muted-foreground uppercase">
          Columns
        </h3>
        <dl className="flex flex-col gap-1 text-xs">
          {board.map((cell) => (
            <div key={cell.columnId} className="flex justify-between">
              <dt className="text-muted-foreground">
                {kanbanColumnConfig(cell.columnId, columns).label}
              </dt>
              <dd className="tabular-nums">
                {cell.userCards.length + cell.agentCards.length + cell.waitingCards.length}
                {cell.limit !== null ? ` / ${cell.limit}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <h3 className="mb-1.5 text-[10px] tracking-wide text-muted-foreground uppercase">
          Card types
        </h3>
        <dl className="flex flex-col gap-1 text-xs">
          {typeCounts.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: entry.glow }}
                />
                {entry.label}
              </dt>
              <dd className="tabular-nums">{entry.count}</dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}
