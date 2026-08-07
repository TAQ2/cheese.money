import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";

export const PERSISTED_STATE_KEY = "ch3:ui-state:v1";
const THREAD_CHANGED_FILES_EXPANSION_VERSION = 1;
const LEGACY_PERSISTED_STATE_KEYS = [
  "ch3:renderer-state:v8",
  "ch3:renderer-state:v7",
  "ch3:renderer-state:v6",
  "ch3:renderer-state:v5",
  "ch3:renderer-state:v4",
  "ch3:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export interface PersistedUiState {
  projectExpandedById?: Record<string, boolean>;
  projectOrder?: string[];
  threadOrder?: string[];
  manuallyUnreadThreadKeys?: string[];
  threadLastVisitedAtById?: Record<string, string>;
  speechVoice?: string;
  speechVoiceSpanish?: string;
  speechLanguageMode?: string;
  speechRate?: string;
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  threadChangedFilesExpansionVersion?: typeof THREAD_CHANGED_FILES_EXPANSION_VERSION;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
}

export interface UiThreadState {
  /**
   * Manual inbox order, top first, holding SCOPED thread keys (the same
   * `scopedThreadKey(scopeThreadRef(environmentId, id))` the sidebar rows key
   * on — bare thread ids collide across environments).
   *
   * Threads absent from this list are not ordered by it; the sidebar's own
   * sort still decides where they land. Only the active (unsettled) list reads
   * it.
   */
  threadOrder: string[];
  /**
   * Threads the user marked unread by hand, as scoped thread keys.
   *
   * Deliberately NOT the same mechanism as an unseen completion: that one is
   * a visit timestamp, so opening the thread clears it. This is a flag the
   * user set on purpose, and it survives being read — the whole point of
   * marking something unread is that it is still waiting when you come back.
   * Only the user clears it.
   */
  manuallyUnreadThreadKeys: string[];
  threadLastVisitedAtById: Record<string, string>;
  /** Engine voice id, e.g. `en-GB-RyanNeural`. Per device: a voice is a
      listening preference, not something to sync to another machine. */
  speechVoice: string;
  /** The voice used when a reply is detected as Spanish rather than English. */
  speechVoiceSpanish: string;
  /** "detect" routes per reply; "english"/"spanish" pin one voice for every reply. */
  speechLanguageMode: "detect" | "english" | "spanish";
  /** Rate adjustment the engine understands, e.g. `+20%`. */
  speechRate: string;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiState extends UiProjectState, UiThreadState, UiEndpointState {}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadOrder: [],
  manuallyUnreadThreadKeys: [],
  threadLastVisitedAtById: {},
  speechVoice: "en-GB-RyanNeural",
  speechVoiceSpanish: "es-MX-JorgeNeural",
  speechLanguageMode: "detect",
  speechRate: "+0%",
  threadChangedFilesExpandedById: {},
  defaultAdvertisedEndpointKey: null,
};

const LEGACY_PROJECT_CWD_PREFERENCE_PREFIX = "legacy-project-cwd:";
const LEGACY_PROJECT_EXPANSION_DEFAULT_KEY = "legacy-project-expansion-default";
let legacyKeysCleanedUp = false;

export function legacyProjectCwdPreferenceKey(cwd: string): string {
  return `${LEGACY_PROJECT_CWD_PREFERENCE_PREFIX}${normalizeProjectPathForComparison(cwd)}`;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function sanitizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => entry[0].length > 0 && typeof entry[1] === "boolean",
    ),
  );
}

function sanitizeTimestampRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0 &&
        Number.isFinite(Date.parse(entry[1])),
    ),
  );
}

export function parsePersistedState(parsed: PersistedUiState): UiState {
  const projectExpandedById =
    parsed.projectExpandedById === undefined
      ? (() => {
          const migrated: Record<string, boolean> = {};
          const collapsedProjectCwds = sanitizeStringArray(parsed.collapsedProjectCwds);
          const expandedProjectCwds = sanitizeStringArray(parsed.expandedProjectCwds);
          for (const cwd of collapsedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = false;
          }
          for (const cwd of expandedProjectCwds) {
            migrated[legacyProjectCwdPreferenceKey(cwd)] = true;
          }
          if (!Array.isArray(parsed.collapsedProjectCwds) && expandedProjectCwds.length > 0) {
            migrated[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] = false;
          }
          return migrated;
        })()
      : sanitizeBooleanRecord(parsed.projectExpandedById);
  const projectOrder =
    parsed.projectOrder === undefined
      ? sanitizeStringArray(parsed.projectOrderCwds).map(legacyProjectCwdPreferenceKey)
      : sanitizeStringArray(parsed.projectOrder);

  return {
    projectExpandedById,
    projectOrder,
    threadOrder: sanitizeStringArray(parsed.threadOrder),
    manuallyUnreadThreadKeys: sanitizeStringArray(parsed.manuallyUnreadThreadKeys),
    threadLastVisitedAtById: sanitizeTimestampRecord(parsed.threadLastVisitedAtById),
    speechVoice: parsed.speechVoice?.trim() || initialState.speechVoice,
    speechVoiceSpanish: parsed.speechVoiceSpanish?.trim() || initialState.speechVoiceSpanish,
    speechLanguageMode:
      parsed.speechLanguageMode === "english" || parsed.speechLanguageMode === "spanish"
        ? parsed.speechLanguageMode
        : initialState.speechLanguageMode,
    speechRate: parsed.speechRate?.trim() || initialState.speechRate,
    threadChangedFilesExpandedById:
      parsed.threadChangedFilesExpansionVersion === THREAD_CHANGED_FILES_EXPANSION_VERSION
        ? sanitizePersistedThreadChangedFilesExpanded(parsed.threadChangedFilesExpandedById)
        : {},
    defaultAdvertisedEndpointKey:
      typeof parsed.defaultAdvertisedEndpointKey === "string" &&
      parsed.defaultAdvertisedEndpointKey.length > 0
        ? parsed.defaultAdvertisedEndpointKey
        : null,
  };
}

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        return parsePersistedState(JSON.parse(legacyRaw) as PersistedUiState);
      }
      return initialState;
    }
    return parsePersistedState(JSON.parse(raw) as PersistedUiState);
  } catch {
    return initialState;
  }
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean") {
        nextTurns[turnId] = expanded;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const projectExpandedById = Object.fromEntries(
      Object.entries(state.projectExpandedById).filter(
        ([key]) => key !== LEGACY_PROJECT_EXPANSION_DEFAULT_KEY,
      ),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        projectExpandedById,
        projectOrder: state.projectOrder,
        threadOrder: state.threadOrder,
        manuallyUnreadThreadKeys: state.manuallyUnreadThreadKeys,
        threadLastVisitedAtById: state.threadLastVisitedAtById,
        speechVoice: state.speechVoice,
        speechVoiceSpanish: state.speechVoiceSpanish,
        speechLanguageMode: state.speechLanguageMode,
        speechRate: state.speechRate,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        threadChangedFilesExpansionVersion: THREAD_CHANGED_FILES_EXPANSION_VERSION,
        threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

export function markThreadVisited(state: UiState, threadId: string, visitedAt: string): UiState {
  const visitedAtMs = Date.parse(visitedAt);
  if (!Number.isFinite(visitedAtMs)) {
    return state;
  }
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: visitedAt,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  if (currentThreadState[turnId] === expanded) {
    return state;
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: expanded,
      },
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function resolveProjectExpanded(
  projectExpandedById: Readonly<Record<string, boolean>>,
  preferenceKeys: readonly string[],
): boolean {
  for (const key of preferenceKeys) {
    const expanded = projectExpandedById[key];
    if (expanded !== undefined) {
      return expanded;
    }
  }
  return projectExpandedById[LEGACY_PROJECT_EXPANSION_DEFAULT_KEY] ?? true;
}

export function setProjectExpanded(
  state: UiState,
  projectIds: string | readonly string[],
  expanded: boolean,
): UiState {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const nextEntries = ids.filter((projectId) => state.projectExpandedById[projectId] !== expanded);
  if (nextEntries.length === 0) {
    return state;
  }
  const projectExpandedById = { ...state.projectExpandedById };
  for (const projectId of nextEntries) {
    projectExpandedById[projectId] = expanded;
  }
  return {
    ...state,
    projectExpandedById,
  };
}

/**
 * Moves every dragged id to the target's slot, preserving the dragged ids'
 * relative order. Returns null when the move is a no-op (nothing dragged,
 * dropped on itself, target not in the list), so callers can keep the
 * previous state object identity.
 *
 * Shared by the project and thread reorders: the index arithmetic — in
 * particular pulling the dragged entries out before computing where the
 * target ended up — is the part that is easy to get subtly wrong.
 */
export function moveOrderedIds(
  currentOrder: readonly string[],
  draggedIds: readonly string[],
  targetIds: readonly string[],
): string[] | null {
  if (draggedIds.length === 0) {
    return null;
  }
  const draggedSet = new Set(draggedIds);
  const targetSet = new Set(targetIds);
  if (draggedIds.every((id) => targetSet.has(id))) {
    return null;
  }

  const originalTargetIndex = currentOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return null;
  }

  const nextOrder = [...currentOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = nextOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(nextOrder[i]!)) {
      removed.unshift(nextOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return null;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  nextOrder.splice(insertIndex, 0, ...removed);
  return nextOrder;
}

export function reorderProjects(
  state: UiState,
  currentProjectOrder: readonly string[],
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  const projectOrder = moveOrderedIds(currentProjectOrder, draggedProjectIds, targetProjectIds);
  if (projectOrder === null) {
    return state;
  }
  return {
    ...state,
    projectOrder,
  };
}

/**
 * Bounds the arrangement so it cannot grow for the life of the install.
 *
 * It is a cap and not a prune against "threads that still exist" on purpose:
 * the client only knows about environments that have finished loading, so
 * pruning would erase the arrangement of every thread on a server that
 * happened to still be connecting when the user dragged something.
 */
const MAX_REMEMBERED_THREAD_ORDER = 500;

/**
 * Writes a rearranged inbox back into the remembered order, leaving the
 * threads the current view does not show exactly where they were.
 *
 * The visible list is only ever a slice — a project scope hides other
 * projects, and settling or snoozing takes a thread out of the inbox without
 * it ceasing to exist. So the visible keys are spliced back into the SLOTS
 * they already occupied rather than moved to the front as a block: an
 * arrangement of `[Q1, P1, Q2, P2]` rearranged inside project P's scope
 * still reads `Q1` first afterwards.
 */
export function reorderThreads(
  state: UiState,
  input: {
    /** The active list exactly as it is rendered right now, top first. */
    visibleThreadOrder: readonly string[];
    draggedThreadKeys: readonly string[];
    targetThreadKeys: readonly string[];
  },
): UiState {
  const { draggedThreadKeys, targetThreadKeys, visibleThreadOrder } = input;
  const movedVisibleOrder = moveOrderedIds(visibleThreadOrder, draggedThreadKeys, targetThreadKeys);
  if (movedVisibleOrder === null) {
    return state;
  }
  return {
    ...state,
    threadOrder: spliceVisibleThreadOrder(state.threadOrder, movedVisibleOrder),
  };
}

/**
 * Puts one thread at the head of the arrangement, keeping everything else in
 * its relative order.
 */
export function moveThreadToTopOfOrder(
  state: UiState,
  threadKey: string,
  visibleThreadOrder: readonly string[],
): UiState {
  if (threadKey.length === 0) {
    return state;
  }
  const withoutThread = visibleThreadOrder.filter((key) => key !== threadKey);
  return {
    ...state,
    threadOrder: spliceVisibleThreadOrder(state.threadOrder, [threadKey, ...withoutThread]),
  };
}

/**
 * Sets or clears the hand-made unread mark on one thread.
 *
 * Nothing else in the app touches this list — in particular, visiting the
 * thread does not — so a marked thread stays marked through as many visits
 * as the user makes, until they unmark it.
 */
export function setThreadManuallyUnread(
  state: UiState,
  threadKey: string,
  unread: boolean,
): UiState {
  const alreadyMarked = state.manuallyUnreadThreadKeys.includes(threadKey);
  if (threadKey.length === 0 || alreadyMarked === unread) {
    return state;
  }
  return {
    ...state,
    manuallyUnreadThreadKeys: unread
      ? [threadKey, ...state.manuallyUnreadThreadKeys].slice(0, MAX_REMEMBERED_THREAD_ORDER)
      : state.manuallyUnreadThreadKeys.filter((key) => key !== threadKey),
  };
}

/** Forgets every hand-made position, returning the inbox to its own sort. */
export function resetThreadOrder(state: UiState): UiState {
  if (state.threadOrder.length === 0) {
    return state;
  }
  return { ...state, threadOrder: [] };
}

function spliceVisibleThreadOrder(
  storedOrder: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const visibleSet = new Set(visibleOrder);
  const slotCount = storedOrder.reduce(
    (count, key) => (visibleSet.has(key) ? count + 1 : count),
    0,
  );
  if (slotCount === 0) {
    return dedupeAndCap([...visibleOrder, ...storedOrder]);
  }

  const next: string[] = [];
  let emitted = 0;
  let seenSlots = 0;
  for (const key of storedOrder) {
    if (!visibleSet.has(key)) {
      next.push(key);
      continue;
    }
    seenSlots += 1;
    if (seenSlots === slotCount) {
      // The last slot absorbs the threads that were never arranged before
      // (created since the previous drag), keeping them beside the block
      // they were just arranged against.
      next.push(...visibleOrder.slice(emitted));
      emitted = visibleOrder.length;
      continue;
    }
    const nextVisible = visibleOrder[emitted];
    if (nextVisible !== undefined) {
      next.push(nextVisible);
      emitted += 1;
    }
  }
  return dedupeAndCap(next);
}

function dedupeAndCap(keys: readonly string[]): string[] {
  return [...new Set(keys)].slice(0, MAX_REMEMBERED_THREAD_ORDER);
}

interface UiStateStore extends UiState {
  markThreadVisited: (threadId: string, visitedAt: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  setThreadChangedFilesExpanded: (threadId: string, turnId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  setProjectExpanded: (projectIds: string | readonly string[], expanded: boolean) => void;
  reorderProjects: (
    currentProjectOrder: readonly string[],
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
  reorderThreads: (input: {
    visibleThreadOrder: readonly string[];
    draggedThreadKeys: readonly string[];
    targetThreadKeys: readonly string[];
  }) => void;
  moveThreadToTopOfOrder: (threadKey: string, visibleThreadOrder: readonly string[]) => void;
  setSpeechVoice: (voice: string) => void;
  setSpeechVoiceSpanish: (voice: string) => void;
  setSpeechLanguageMode: (mode: "detect" | "english" | "spanish") => void;
  setSpeechRate: (rate: string) => void;
  resetThreadOrder: () => void;
  setThreadManuallyUnread: (threadKey: string, unread: boolean) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded) =>
    set((state) => setThreadChangedFilesExpanded(state, threadId, turnId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  setProjectExpanded: (projectIds, expanded) =>
    set((state) => setProjectExpanded(state, projectIds, expanded)),
  reorderProjects: (currentProjectOrder, draggedProjectIds, targetProjectIds) =>
    set((state) =>
      reorderProjects(state, currentProjectOrder, draggedProjectIds, targetProjectIds),
    ),
  reorderThreads: (input) => set((state) => reorderThreads(state, input)),
  moveThreadToTopOfOrder: (threadKey, visibleThreadOrder) =>
    set((state) => moveThreadToTopOfOrder(state, threadKey, visibleThreadOrder)),
  setSpeechVoice: (voice) =>
    set((state) => (voice.trim() ? { ...state, speechVoice: voice.trim() } : state)),
  setSpeechVoiceSpanish: (voice) =>
    set((state) => (voice.trim() ? { ...state, speechVoiceSpanish: voice.trim() } : state)),
  setSpeechLanguageMode: (mode) => set((state) => ({ ...state, speechLanguageMode: mode })),
  setSpeechRate: (rate) =>
    set((state) => (rate.trim() ? { ...state, speechRate: rate.trim() } : state)),
  resetThreadOrder: () => set((state) => resetThreadOrder(state)),
  setThreadManuallyUnread: (threadKey, unread) =>
    set((state) => setThreadManuallyUnread(state, threadKey, unread)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
