import { ProjectId, ThreadId } from "@ch3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  legacyProjectCwdPreferenceKey,
  markThreadUnread,
  markThreadVisited,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  moveThreadToTopOfOrder,
  reorderProjects,
  reorderThreads,
  resetThreadOrder,
  setThreadManuallyUnread,
  resolveProjectExpanded,
  setDefaultAdvertisedEndpointKey,
  setProjectExpanded,
  setThreadChangedFilesExpanded,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
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
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("stores server timestamps without moving visit state backwards", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState();
    const visited = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.700Z");

    expect(visited.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
    expect(markThreadVisited(visited, threadId, "2026-02-25T12:30:00.000Z")).toBe(visited);
    expect(markThreadVisited(visited, threadId, "not-a-date")).toBe(visited);
  });

  it("marks a completed thread unread using the server completion timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
    expect(markThreadUnread(next, threadId, null)).toBe(next);
  });

  it("resolves project expansion from logical, physical, and legacy preference keys", () => {
    const physicalKey = "environment:/repo/project";
    const legacyKey = legacyProjectCwdPreferenceKey("/repo/project");

    expect(resolveProjectExpanded({ logical: false, [physicalKey]: true }, ["logical"])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [physicalKey]: false }, ["new-logical", physicalKey])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [legacyKey]: false }, ["new-logical", legacyKey])).toBe(false);
    expect(resolveProjectExpanded({}, ["new-logical"])).toBe(true);
  });

  it("sets expansion for every stable key belonging to a logical project", () => {
    const initialState = makeUiState();
    const keys = ["logical", "environment-a:/repo", "environment-b:/repo"];

    const next = setProjectExpanded(initialState, keys, false);

    expect(next.projectExpandedById).toEqual({
      logical: false,
      "environment-a:/repo": false,
      "environment-b:/repo": false,
    });
    expect(setProjectExpanded(next, keys, false)).toBe(next);
  });

  it("reorders from the current atom-derived project order", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const currentOrder = [project1, project2, project3];

    const next = reorderProjects(makeUiState(), currentOrder, [project1], [project3]);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("moves grouped project members together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const currentOrder = [keyALocal, keyARemote, keyB, keyC];

    const next = reorderProjects(makeUiState(), currentOrder, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("does not reorder missing or identical groups", () => {
    const currentOrder = ["env-local:proj-a", "env-local:proj-b"];
    const state = makeUiState();

    expect(reorderProjects(state, currentOrder, ["env-local:missing"], ["env-local:proj-b"])).toBe(
      state,
    );
    expect(reorderProjects(state, currentOrder, ["env-local:proj-a"], ["env-local:proj-a"])).toBe(
      state,
    );
  });

  it("reorders the inbox from the order the sidebar is actually rendering", () => {
    const visibleThreadOrder = ["env-local:thread-a", "env-local:thread-b", "env-local:thread-c"];

    const next = reorderThreads(makeUiState(), {
      visibleThreadOrder,
      draggedThreadKeys: ["env-local:thread-c"],
      targetThreadKeys: ["env-local:thread-a"],
    });

    expect(next.threadOrder).toEqual([
      "env-local:thread-c",
      "env-local:thread-a",
      "env-local:thread-b",
    ]);
  });

  it("leaves threads the current view does not show exactly where they were", () => {
    // Arranged globally as Q1, P1, Q2, P2; rearranged inside project P's
    // scope. Q1 was put at the top by hand and has to stay there.
    const state = makeUiState({
      threadOrder: ["q1", "p1", "q2", "p2"],
    });

    const next = reorderThreads(state, {
      visibleThreadOrder: ["p1", "p2"],
      draggedThreadKeys: ["p2"],
      targetThreadKeys: ["p1"],
    });

    expect(next.threadOrder).toEqual(["q1", "p2", "q2", "p1"]);
  });

  it("keeps threads created since the last drag beside the block they were arranged against", () => {
    const state = makeUiState({ threadOrder: ["a", "b"] });

    const next = reorderThreads(state, {
      visibleThreadOrder: ["fresh", "a", "b"],
      draggedThreadKeys: ["b"],
      targetThreadKeys: ["a"],
    });

    expect(next.threadOrder).toEqual(["fresh", "b", "a"]);
  });

  it("does not reorder the inbox on a drop that changes nothing", () => {
    const state = makeUiState();
    const visibleThreadOrder = ["env-local:thread-a", "env-local:thread-b"];

    expect(
      reorderThreads(state, {
        visibleThreadOrder,
        draggedThreadKeys: ["env-local:thread-a"],
        targetThreadKeys: ["env-local:thread-a"],
      }),
    ).toBe(state);
    expect(
      reorderThreads(state, {
        visibleThreadOrder,
        draggedThreadKeys: ["env-local:thread-a"],
        targetThreadKeys: ["env-local:gone"],
      }),
    ).toBe(state);
  });

  it("moves a thread to the head of the arrangement without disturbing the rest", () => {
    const state = makeUiState({ threadOrder: ["q1", "a", "q2", "b"] });

    const next = moveThreadToTopOfOrder(state, "b", ["a", "b", "c"]);

    // b leads the visible block; the threads this view cannot see keep their
    // slots.
    expect(next.threadOrder).toEqual(["q1", "b", "q2", "a", "c"]);
  });

  it("resets to the sidebar's own sort", () => {
    const state = makeUiState({ threadOrder: ["a", "b"] });

    const alreadyUnordered = makeUiState();

    expect(resetThreadOrder(state).threadOrder).toEqual([]);
    expect(resetThreadOrder(alreadyUnordered)).toBe(alreadyUnordered);
  });

  it("marks a thread unread by hand and only the user clears it", () => {
    const marked = setThreadManuallyUnread(makeUiState(), "env-local:thread-a", true);

    expect(marked.manuallyUnreadThreadKeys).toEqual(["env-local:thread-a"]);
    // Marking twice is not a change, so the state object is reused.
    expect(setThreadManuallyUnread(marked, "env-local:thread-a", true)).toBe(marked);
    expect(
      setThreadManuallyUnread(marked, "env-local:thread-a", false).manuallyUnreadThreadKeys,
    ).toEqual([]);
  });

  it("stores explicit changed-file expansion choices", () => {
    const threadId = ThreadId.make("thread-1");
    const collapsed = setThreadChangedFilesExpanded(makeUiState(), threadId, "turn-1", false);

    expect(collapsed.threadChangedFilesExpandedById).toEqual({
      [threadId]: {
        "turn-1": false,
      },
    });
    expect(
      setThreadChangedFilesExpanded(collapsed, threadId, "turn-1", true)
        .threadChangedFilesExpandedById,
    ).toEqual({
      [threadId]: {
        "turn-1": true,
      },
    });
  });

  it("stores the endpoint preference by stable key", () => {
    const next = setDefaultAdvertisedEndpointKey(makeUiState(), "desktop-core:lan:http");

    expect(next.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
    expect(setDefaultAdvertisedEndpointKey(next, "desktop-core:lan:http")).toBe(next);
    expect(setDefaultAdvertisedEndpointKey(next, "")).toMatchObject({
      defaultAdvertisedEndpointKey: null,
    });
  });
});

describe("parsePersistedState", () => {
  it("hydrates raw UI-owned state without server entities", () => {
    const parsed = parsePersistedState({
      projectExpandedById: {
        logical: false,
        invalid: "no" as unknown as boolean,
      },
      projectOrder: ["physical-b", "", "physical-a", "physical-b"],
      threadOrder: ["env-local:thread-b", "", "env-local:thread-a", "env-local:thread-b"],
      manuallyUnreadThreadKeys: ["env-local:thread-a", ""],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
        invalid: "not-a-date",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 1,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });

    expect(parsed).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadOrder: ["env-local:thread-b", "env-local:thread-a"],
      manuallyUnreadThreadKeys: ["env-local:thread-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      // Absent from the payload, so the read-aloud preferences fall back to
      // their defaults rather than landing undefined.
      speechVoice: "en-GB-RyanNeural",
      speechVoiceSpanish: "es-MX-JorgeNeural",
      speechLanguageMode: "detect",
      speechRate: "+0%",
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
  });

  it("ignores changed-file expansion values saved with legacy folder semantics", () => {
    const parsed = parsePersistedState({
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
    });

    expect(parsed.threadChangedFilesExpandedById).toEqual({});
  });

  it("migrates legacy CWD project preferences into local alias keys", () => {
    const parsed = parsePersistedState({
      collapsedProjectCwds: ["/repo/b"],
      expandedProjectCwds: ["/repo/a"],
      projectOrderCwds: ["/repo/b", "/repo/a"],
    });
    const projectAKey = legacyProjectCwdPreferenceKey("/repo/a");
    const projectBKey = legacyProjectCwdPreferenceKey("/repo/b");

    expect(parsed.projectOrder).toEqual([projectBKey, projectAKey]);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectAKey])).toBe(true);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectBKey])).toBe(false);
    expect(resolveProjectExpanded(parsed.projectExpandedById, ["unknown"])).toBe(true);
  });

  it("preserves legacy expanded-only semantics for one-way migration", () => {
    const parsed = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/a"),
      ]),
    ).toBe(true);
    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/b"),
      ]),
    ).toBe(false);
  });
});

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("uiStateStore persistence", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists raw UI preferences including thread visit markers", () => {
    const state = makeUiState({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadOrder: ["env-local:thread-b", "env-local:thread-a"],
      manuallyUnreadThreadKeys: ["env-local:thread-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
    });

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted).toEqual({
      speechVoice: "en-GB-RyanNeural",
      speechVoiceSpanish: "es-MX-JorgeNeural",
      speechLanguageMode: "detect",
      speechRate: "+0%",
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadOrder: ["env-local:thread-b", "env-local:thread-a"],
      manuallyUnreadThreadKeys: ["env-local:thread-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 1,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
    });
  });

  it("drops the temporary expanded-only migration fallback when rewriting state", () => {
    const migrated = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    persistState(migrated);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(resolveProjectExpanded(persisted.projectExpandedById ?? {}, ["unknown"])).toBe(true);
  });
});

describe("speech language mode persistence", () => {
  it("keeps the pinned modes through a parse and rejects unknown values", () => {
    const parse = (mode: string) =>
      parsePersistedState({ speechLanguageMode: mode }).speechLanguageMode;
    expect(parse("spanish")).toBe("spanish");
    expect(parse("english")).toBe("english");
    expect(parse("detect")).toBe("detect");
    expect(parse("klingon")).toBe("detect");
  });
});
