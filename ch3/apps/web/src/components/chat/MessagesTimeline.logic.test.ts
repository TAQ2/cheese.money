import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@ch3tools/contracts";
import {
  type AgentModelContext,
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  deriveAgentRoster,
  deriveRunningAgentIndicators,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  isUserAttributableTimelineScroll,
  resolveTimelineReadingAnchor,
  resolveTimelineReadingRestoreScroll,
  resolveTimelineMinimapLane,
  resolveTimelineMinimapTickWidth,
  shouldAcceptTimelineMinimapClick,
  type TimelineAnchorState,
  TIMELINE_MINIMAP_TEXT_SAFE_MARGIN,
  TIMELINE_MINIMAP_TICK_MIN_WIDTH,
  isTimelineSettledAtEnd,
  resolveTimelineDistanceFromEnd,
  shouldSnapTimelineToEndAfterTurnSettle,
  TIMELINE_USER_SCROLL_ATTRIBUTION_MS,
} from "./MessagesTimeline.logic";

describe("isTimelineSettledAtEnd", () => {
  it("is settled only when the viewport bottom sits on the measured end", () => {
    expect(isTimelineSettledAtEnd({ contentLength: 5000, scroll: 4200, scrollLength: 800 })).toBe(
      true,
    );
    // Sub-pixel rounding from layout is not a gap.
    expect(isTimelineSettledAtEnd({ contentLength: 5000.6, scroll: 4200, scrollLength: 800 })).toBe(
      true,
    );
    // A row that measured taller than its estimate moved the end away.
    expect(isTimelineSettledAtEnd({ contentLength: 5240, scroll: 4200, scrollLength: 800 })).toBe(
      false,
    );
  });

  it("is never settled on a list that has not reported its extent", () => {
    expect(isTimelineSettledAtEnd(undefined)).toBe(false);
    expect(isTimelineSettledAtEnd({ scroll: 0, scrollLength: 800 })).toBe(false);
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          turnId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      // Folded by the reader. Nothing folds on its own any more, so a test of
      // the folded shape has to ask for it.
      collapsedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    // No fold input at all: this is the DEFAULT, and the default is open. The
    // commentary is on the page until the reader folds it, never the reverse.
    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it("repeats the fold on the terminal assistant message so it also reads under the reply", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      collapsedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    const terminalRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.id === "assistant-final-entry",
    );

    expect(terminalRow?.assistantTurnFold).toEqual({
      turnId: "turn-1",
      label: foldRow?.label,
      expanded: false,
    });

    // Expanding from either control moves both — they are one fold.
    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    const expandedTerminalRow = expandedRows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.id === "assistant-final-entry",
    );
    const commentaryRow = expandedRows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.id === "assistant-thought-entry",
    );

    expect(expandedTerminalRow?.assistantTurnFold?.expanded).toBe(true);
    // Commentary carries no metadata row, so it gets no footer control.
    expect(commentaryRow?.assistantTurnFold).toBeUndefined();
  });

  it("leaves the terminal message without a footer fold when the turn never folded", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Hi",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:02Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Hello",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:02Z",
            updatedAt: "2026-01-01T00:00:03Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );
    expect(assistantRow?.showAssistantMeta).toBe(true);
    expect(assistantRow?.assistantTurnFold).toBeUndefined();
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            turnId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      collapsedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        turnId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps a folded previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestTurn still points at the
    // previous, settled turn — a fold the reader closed must stay closed
    // through that window rather than springing open because a turn is live.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      collapsedTurnIds: new Set(["turn-1" as never]),
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "assistant-thought-entry",
      "work-entry-1",
      "working-indicator-row",
    ]);
  });

  it("does not fold the session's running turn when latestTurn regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            turnId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningTurnId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.turnId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("running-work-entry");
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
  });

  it("models work log overflow expansion as inserted list rows", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "edit",
          detail: "Editing MessagesTimeline.tsx",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-3", "work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 2,
      expanded: false,
      onlyToolEntries: true,
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-1",
      "work-2",
      "work-3",
      "work-toggle:work-entry-1",
    ]);
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("re-renders the roster row when a pid arrives on its own activity", () => {
    // The defect this exists for: the pid lands ~60 ms after the row is on
    // screen, on its own `task.progress`. `isRowUnchanged` did not compare
    // `pid`, so the stability layer handed React the previous row object and
    // the chip never appeared — while the self-ticking timer kept counting,
    // which made the row look alive and simply pid-less forever.
    const withoutPid = {
      kind: "agent-roster" as const,
      id: "agent-roster-row",
      agents: [
        {
          id: "bgxgvh6h5",
          label: "Background sleeper",
          kind: "shell" as const,
          model: null,
          meteredMultiplier: null,
          startedAt: "2026-09-02T16:09:45.186Z",
          endedAt: null,
          status: "running" as const,
        },
      ],
    };
    const withPid = {
      ...withoutPid,
      agents: [{ ...withoutPid.agents[0]!, pid: 78419 }],
    };
    const first = computeStableMessagesTimelineRows([withoutPid], {
      byId: new Map(),
      result: [],
    });
    const second = computeStableMessagesTimelineRows([withPid], first);
    expect(second).not.toBe(first);
    expect((second.result[0] as typeof withPid).agents[0]?.pid).toBe(78419);
  });

  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});

describe("deriveAgentRoster", () => {
  // Mirrors the activity store exactly: background agents report a stable
  // taskId, the task in task.started's detail, the current step in
  // task.progress's title, and elapsed time in usage.duration_ms.
  const taskActivity = (input: {
    kind: "task.started" | "task.progress" | "task.completed";
    taskId: string;
    createdAt: string;
    detail?: string;
    title?: string;
    durationMs?: number;
    /** The process the server matched a backgrounded command to. */
    pid?: number;
    /** The runtime's own kind — `local_bash` or `local_agent`. */
    taskType?: string;
  }) => ({
    kind: input.kind,
    turnId: "turn-1",
    createdAt: input.createdAt,
    payload: {
      taskId: input.taskId,
      ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
      ...(input.pid === undefined ? {} : { pid: input.pid }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.durationMs === undefined ? {} : { usage: { duration_ms: input.durationMs } }),
    },
  });

  // Real data, from a `git commit && git push` that finished in under a second:
  // both activities carry the same createdAt and no sequence, and the
  // projection returned them completed-first because the row order of two rows
  // written together is the order of two random UUIDs. The rail showed that
  // finished command as running, with a timer that reached fifty-one minutes.
  it("lists one row when a delegation shows in both the task feed and its prefixed tool call", () => {
    // The bug: the task feed labels the run "PR 179 walkthrough" and the same
    // delegation's Task tool call labels it "hands: PR 179 walkthrough", so the
    // dedup missed and the one subagent appeared twice — the second row copying
    // a synthetic "<turnId>:<label>" id instead of the real task id.
    const roster = deriveAgentRoster(
      [
        {
          id: "work-collab-1",
          kind: "work" as const,
          createdAt: "2026-09-06T00:00:01Z",
          entry: {
            id: "collab-1",
            createdAt: "2026-09-06T00:00:01Z",
            firstCreatedAt: "2026-09-06T00:00:01Z",
            label: "Task",
            detail: "hands: PR 179 walkthrough",
            tone: "tool" as const,
            itemType: "collab_agent_tool_call" as const,
            agentModel: "claude-opus-5",
            toolLifecycleStatus: "inProgress" as const,
            turnId: "turn-1" as never,
          },
        },
      ],
      "turn-1" as never,
      {
        activities: [
          taskActivity({
            kind: "task.started",
            taskId: "a8156f74872927b47",
            createdAt: "2026-09-06T00:00:01Z",
            detail: "PR 179 walkthrough",
            taskType: "local_agent",
          }),
        ],
      },
    );

    expect(roster).toHaveLength(1);
    expect(roster[0]?.id).toBe("a8156f74872927b47");
    expect(roster[0]?.kind).toBe("agent");
  });

  it("keeps a delegation beside a shell command that happens to share its label", () => {
    // A backgrounded "Run tests" and a delegated "hands: Run tests" are two
    // things. The label dedup exists for a delegation that shows in both the
    // task feed and its own tool call; a shell command has no such twin and
    // must not swallow the agent.
    const roster = deriveAgentRoster(
      [
        {
          id: "work-collab-2",
          kind: "work" as const,
          createdAt: "2026-09-06T00:00:01Z",
          entry: {
            id: "collab-2",
            createdAt: "2026-09-06T00:00:01Z",
            firstCreatedAt: "2026-09-06T00:00:01Z",
            label: "Task",
            detail: "hands: Run tests",
            tone: "tool" as const,
            itemType: "collab_agent_tool_call" as const,
            agentModel: "claude-opus-5",
            toolLifecycleStatus: "inProgress" as const,
            turnId: "turn-1" as never,
          },
        },
      ],
      "turn-1" as never,
      {
        activities: [
          taskActivity({
            kind: "task.started",
            taskId: "bshell1",
            createdAt: "2026-09-06T00:00:01Z",
            detail: "Run tests",
            taskType: "local_bash",
          }),
        ],
      },
    );

    expect(roster.map((row) => row.kind)).toEqual(["shell", "agent"]);
  });

  it("carries the pid of the process running a backgrounded command", () => {
    // The CLI's task id ("bzu9mezzp") is a handle for the CLI. Somebody watching
    // a twenty-minute build wants the one `ps` and `kill` take, and copying the
    // row is how they take it with them.
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "bzu9mezzp",
          createdAt: "2026-08-29T17:19:56.000Z",
          detail: "Build arm64 dmg in background",
          taskType: "local_bash",
          pid: 4242,
        }),
      ],
    });

    expect(roster).toHaveLength(1);
    expect(roster[0]?.kind).toBe("shell");
    expect(roster[0]?.pid).toBe(4242);
  });

  it("leaves the pid off when the server could not name a process", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "bzu9mezzp",
          createdAt: "2026-08-29T17:19:56.000Z",
          detail: "Build arm64 dmg in background",
          taskType: "local_bash",
        }),
      ],
    });

    expect(roster[0]?.pid).toBeUndefined();
  });

  it("merges a pid that arrives on its own row, and keeps the step that row does not carry", () => {
    // The server finds the process after the task is already on screen and
    // appends a progress row carrying only the pid. The row is the id the CLI
    // polls plus the pid the OS takes — and the step the last real progress
    // row set stays put.
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "btfofidmw",
          createdAt: "2026-08-29T17:19:56.000Z",
          detail: "Run 700-pair raw parity gate in background",
          taskType: "local_bash",
        }),
        taskActivity({
          kind: "task.progress",
          taskId: "btfofidmw",
          createdAt: "2026-08-29T17:19:57.000Z",
          title: "Loading pairs",
        }),
        taskActivity({
          kind: "task.progress",
          taskId: "btfofidmw",
          createdAt: "2026-08-29T17:19:58.000Z",
          pid: 55473,
        }),
      ],
    });

    expect(roster).toHaveLength(1);
    expect(roster[0]?.id).toBe("btfofidmw");
    expect(roster[0]?.kind).toBe("shell");
    expect(roster[0]?.pid).toBe(55473);
    expect(roster[0]?.step).toBe("Loading pairs");
  });

  it("never claims a pid for a delegated agent, which is not a process", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "agent-1",
          createdAt: "2026-08-29T17:19:56.000Z",
          detail: "Review the diff",
          taskType: "local_agent",
          pid: 4242,
        }),
      ],
    });

    expect(roster[0]?.kind).toBe("agent");
    expect(roster[0]?.pid).toBeUndefined();
  });

  it("does not resurrect a task whose completion arrives before its start", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.completed",
          taskId: "bv0q3msum",
          createdAt: "2026-08-29T00:20:18.438Z",
          detail: "Commit and push FIX-8",
          taskType: "local_bash",
          durationMs: 812,
        }),
        taskActivity({
          kind: "task.started",
          taskId: "bv0q3msum",
          createdAt: "2026-08-29T00:20:18.438Z",
          detail: "Commit and push FIX-8",
          taskType: "local_bash",
        }),
      ],
    });
    // A finished command is not a live one. The rail may drop it entirely or
    // show it as completed; what it must never do is call it running.
    expect(roster.some((agent) => agent.status === "running")).toBe(false);
  });

  // The rule this must not break: the same id genuinely running twice — a
  // command re-run later in the thread — is two runs, and the second one is
  // live.
  it("opens a new run when a completed id starts again later", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "same-id",
          createdAt: "2026-08-29T00:20:18.000Z",
          detail: "First run",
          taskType: "local_bash",
        }),
        taskActivity({
          kind: "task.completed",
          taskId: "same-id",
          createdAt: "2026-08-29T00:20:19.000Z",
          detail: "First run",
          taskType: "local_bash",
        }),
        taskActivity({
          kind: "task.started",
          taskId: "same-id",
          createdAt: "2026-08-29T00:30:00.000Z",
          detail: "Second run",
          taskType: "local_bash",
        }),
      ],
    });
    expect(roster.some((agent) => agent.status === "running")).toBe(true);
  });

  it("keeps a background agent alive across later turns", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "a48",
          createdAt: "2026-01-01T00:00:00Z",
          detail: "Adversarial review of origination re-forecast",
        }),
        taskActivity({
          kind: "task.progress",
          taskId: "a48",
          createdAt: "2026-01-01T00:03:00Z",
          title: "Running Run honest walk-forward",
          detail: "Running Run honest walk-forward",
          durationMs: 140126,
        }),
      ],
    });
    expect(roster).toHaveLength(1);
    const agent = roster[0]!;
    expect(agent.label).toBe("Adversarial review of origination re-forecast");
    expect(agent.step).toBe("Running Run honest walk-forward");
    expect(agent.durationMs).toBe(140126);
    expect(agent.status).toBe("running");
    expect(agent.startedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("recovers the model from the Task tool call that spawned the agent", () => {
    const roster = deriveAgentRoster(
      [
        {
          id: "tool-entry",
          kind: "work" as const,
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "tool-entry",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            label: "Subagent task",
            tone: "tool" as const,
            itemType: "collab_agent_tool_call" as const,
            detail: "Recite pi very long",
            toolLifecycleStatus: "inProgress" as const,
            agentModel: "haiku",
          },
        },
      ],
      null,
      {
        activities: [
          taskActivity({
            kind: "task.started",
            taskId: "a08",
            createdAt: "2026-01-01T00:00:02Z",
            detail: "Recite pi very long",
          }),
        ],
      },
    );
    expect(roster).toHaveLength(1);
    expect(roster[0]?.model).toBe("haiku");
  });

  it("tags a backgrounded shell command as sh, using the runtime's own task type", () => {
    // The shapes the runtime actually emits, which is the point: the feed
    // carries the Bash *description* while the work log carries the command,
    // so no label match between them can ever succeed. `taskType` is the only
    // thing that says which kind of task this is.
    const roster = deriveAgentRoster(
      [
        {
          id: "bash-entry",
          kind: "work" as const,
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "bash-entry",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            label: "Command run",
            tone: "tool" as const,
            itemType: "command_execution" as const,
            detail: "Bash: npm run dev",
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      null,
      {
        activities: [
          taskActivity({
            kind: "task.started",
            taskId: "b01",
            createdAt: "2026-01-01T00:00:02Z",
            taskType: "local_bash",
            detail: "Start the dev server",
          }),
        ],
        // A thread model is present precisely so the inheritance this guards
        // against would fire if the kind were not read.
        modelContext: {
          inheritedModel: "claude-opus-5",
          driverKind: ProviderDriverKind.make("claudeAgent"),
        },
      },
    );
    expect(roster).toHaveLength(1);
    expect(roster[0]?.kind).toBe("shell");
    expect(roster[0]?.model).toBeNull();
  });

  it("leaves a delegation as an agent, model and all", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "a01",
          createdAt: "2026-01-01T00:00:02Z",
          taskType: "local_agent",
          detail: "Review the diff",
        }),
      ],
      modelContext: {
        inheritedModel: "claude-opus-5",
        driverKind: ProviderDriverKind.make("claudeAgent"),
      },
    });
    expect(roster[0]?.kind).toBe("agent");
    expect(roster[0]?.model).toBe("claude-opus-5");
  });

  it("treats a re-used task id as a new run, not more news about the old one", () => {
    // The CLI's ids are unique per session, not globally, and one thread can
    // hold two sessions. Keyed on the id alone the second run inherited the
    // first's completion and vanished, and its start time collapsed to the
    // first's — which is where a row claiming hours of elapsed time came from.
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "a0cd35f",
          createdAt: "2026-01-01T14:38:37Z",
          taskType: "local_agent",
          detail: "Fix audit findings",
        }),
        taskActivity({
          kind: "task.completed",
          taskId: "a0cd35f",
          createdAt: "2026-01-01T14:58:20Z",
        }),
        taskActivity({
          kind: "task.started",
          taskId: "a0cd35f",
          createdAt: "2026-01-01T17:47:14Z",
          taskType: "local_agent",
          detail: "Fix audit findings",
        }),
      ],
    });

    expect(roster).toHaveLength(1);
    // The live run, dated when IT started — not 3 hours earlier.
    expect(roster[0]?.startedAt).toBe("2026-01-01T17:47:14Z");
  });

  it("drops the id once its current run completes", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "a0cd35f",
          createdAt: "2026-01-01T17:47:14Z",
          taskType: "local_agent",
          detail: "Fix audit findings",
        }),
        taskActivity({
          kind: "task.completed",
          taskId: "a0cd35f",
          createdAt: "2026-01-01T17:53:31Z",
        }),
      ],
    });
    expect(roster).toHaveLength(0);
  });

  it("matches the model through a subagent_type prefix", () => {
    const roster = deriveAgentRoster(
      [
        {
          id: "tool-entry",
          kind: "work" as const,
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "tool-entry",
            createdAt: "2026-01-01T00:00:01Z",
            turnId: "turn-1" as never,
            label: "Subagent task",
            tone: "tool" as const,
            itemType: "collab_agent_tool_call" as const,
            detail: "general-purpose: Duplicate approval card on MySQL",
            toolLifecycleStatus: "inProgress" as const,
            agentModel: "sonnet",
          },
        },
      ],
      null,
      {
        activities: [
          taskActivity({
            kind: "task.started",
            taskId: "a7e",
            createdAt: "2026-01-01T00:00:02Z",
            detail: "Duplicate approval card on MySQL",
          }),
        ],
      },
    );
    expect(roster[0]?.model).toBe("sonnet");
  });

  // A Task call that omits `model` runs on the parent session's model, so the
  // thread's own selection is the honest answer for those rows.
  const agentToolEntry = (input: { detail: string; agentModel?: string }) => ({
    id: "tool-entry",
    kind: "work" as const,
    createdAt: "2026-01-01T00:00:01Z",
    entry: {
      id: "tool-entry",
      createdAt: "2026-01-01T00:00:01Z",
      turnId: "turn-1" as never,
      label: "Subagent task",
      tone: "tool" as const,
      itemType: "collab_agent_tool_call" as const,
      detail: input.detail,
      toolLifecycleStatus: "inProgress" as const,
      ...(input.agentModel === undefined ? {} : { agentModel: input.agentModel }),
    },
  });
  const startedTask = (detail: string) =>
    taskActivity({
      kind: "task.started",
      taskId: "a08",
      createdAt: "2026-01-01T00:00:02Z",
      detail,
    });
  const claudeContext = (inheritedModel: string | null): AgentModelContext => ({
    inheritedModel,
    driverKind: ProviderDriverKind.make("claudeAgent"),
  });

  it("prefers the model the Task call named over the thread's own", () => {
    const roster = deriveAgentRoster(
      [agentToolEntry({ detail: "Recite pi", agentModel: "sonnet" })],
      null,
      {
        activities: [startedTask("Recite pi")],
        modelContext: claudeContext("claude-opus-5"),
      },
    );
    expect(roster[0]?.model).toBe("claude-sonnet-5");
  });

  it("falls back to the thread's model when the Task call named none", () => {
    const roster = deriveAgentRoster([agentToolEntry({ detail: "Recite pi" })], null, {
      activities: [startedTask("Recite pi")],
      modelContext: claudeContext("claude-opus-5"),
    });
    expect(roster[0]?.model).toBe("claude-opus-5");
  });

  it("names no model when neither the Task call nor the thread has one", () => {
    const roster = deriveAgentRoster([agentToolEntry({ detail: "Recite pi" })], null, {
      activities: [startedTask("Recite pi")],
      modelContext: claudeContext(null),
    });
    expect(roster[0]?.model).toBeNull();
  });

  it("inherits the thread's model on a foreground delegation too", () => {
    const roster = deriveAgentRoster(
      [
        foregroundEntry({
          id: "f1",
          createdAt: "2026-01-01T00:00:10Z",
          turnId: "turn-9",
          status: "inProgress",
          detail: "explorer: map the repo",
          agentModel: null,
        }),
      ],
      "turn-9" as never,
      { modelContext: claudeContext("claude-opus-5") },
    );
    expect(roster[0]?.model).toBe("claude-opus-5");
  });

  it("leaves the model untouched when no thread context is supplied", () => {
    const roster = deriveAgentRoster(
      [agentToolEntry({ detail: "Recite pi", agentModel: "haiku" })],
      null,
      { activities: [startedTask("Recite pi")] },
    );
    expect(roster[0]?.model).toBe("haiku");
  });

  it("drops a background agent once it reports completion", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        taskActivity({
          kind: "task.started",
          taskId: "a7e",
          createdAt: "2026-01-01T00:00:00Z",
          detail: "Duplicate approval card on MySQL",
        }),
        taskActivity({
          kind: "task.completed",
          taskId: "a7e",
          createdAt: "2026-01-01T00:20:00Z",
          title: "Duplicate approval card on MySQL",
        }),
      ],
    });
    expect(roster).toHaveLength(0);
  });

  it("honours a dismissed line", () => {
    const activities = [
      taskActivity({
        kind: "task.started",
        taskId: "a48",
        createdAt: "2026-01-01T00:00:00Z",
        detail: "Blind independent origination re-forecast",
      }),
    ];
    expect(deriveAgentRoster([], null, { activities })).toHaveLength(1);
    expect(
      deriveAgentRoster([], null, { activities, dismissedAgentIds: new Set(["a48"]) }),
    ).toHaveLength(0);
  });

  const foregroundEntry = (input: {
    id: string;
    createdAt: string;
    turnId: string;
    status?: "inProgress" | "completed";
    detail?: string;
    /** Null stands for a Task call that named no model at all. */
    agentModel?: string | null;
  }) => ({
    id: input.id,
    kind: "work" as const,
    createdAt: input.createdAt,
    entry: {
      id: input.id,
      createdAt: input.createdAt,
      turnId: input.turnId as never,
      label: "Subagent task",
      tone: "tool" as const,
      itemType: "collab_agent_tool_call" as const,
      ...(input.status ? { toolLifecycleStatus: input.status } : {}),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.agentModel === null ? {} : { agentModel: input.agentModel ?? "sonnet" }),
    },
  });

  it("lists a foreground delegation only while its turn is running", () => {
    const entries = [
      foregroundEntry({
        id: "f1",
        createdAt: "2026-01-01T00:00:10Z",
        turnId: "turn-9",
        status: "inProgress",
        detail: "explorer: map the repo",
      }),
    ];
    const live = deriveAgentRoster(entries, "turn-9" as never);
    expect(live).toHaveLength(1);
    expect(live[0]?.model).toBe("sonnet");
    // A different turn is running: the old in-flight marker is an orphan.
    expect(deriveAgentRoster(entries, "turn-10" as never)).toHaveLength(0);
    // Nothing running at all: nothing foreground can still be alive.
    expect(deriveAgentRoster(entries, null)).toHaveLength(0);
  });

  it("does not list the same delegation twice across both sources", () => {
    const roster = deriveAgentRoster(
      [
        foregroundEntry({
          id: "f1",
          createdAt: "2026-01-01T00:00:10Z",
          turnId: "turn-9",
          status: "inProgress",
          detail: "Blind independent origination re-forecast",
        }),
      ],
      "turn-9" as never,
      {
        activities: [
          taskActivity({
            kind: "task.started",
            taskId: "afd",
            createdAt: "2026-01-01T00:00:00Z",
            detail: "Blind independent origination re-forecast",
          }),
        ],
      },
    );
    expect(roster).toHaveLength(1);
    expect(roster[0]?.id).toBe("afd");
  });

  it("keeps the indicator row after the turn settles", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
      threadActivities: [
        taskActivity({
          kind: "task.started",
          taskId: "a48",
          createdAt: "2026-01-01T00:00:00Z",
          detail: "Adversarial review",
        }),
      ],
    });
    const rosterRow = rows.find((row) => row.kind === "agent-roster");
    expect(rosterRow).toBeDefined();
    expect(rosterRow?.kind === "agent-roster" ? rosterRow.agents : []).toHaveLength(1);
  });
});

describe("deriveRunningAgentIndicators", () => {
  const agentEntry = (input: {
    id: string;
    createdAt: string;
    toolCallId?: string;
    firstCreatedAt?: string;
    status: "inProgress" | "completed" | "failed";
    label?: string;
    turnId?: string;
  }) => ({
    id: input.id,
    kind: "work" as const,
    createdAt: input.createdAt,
    entry: {
      id: input.id,
      createdAt: input.createdAt,
      turnId: (input.turnId ?? "turn-1") as never,
      label: input.label ?? "researcher: dig into the data",
      tone: "tool" as const,
      itemType: "collab_agent_tool_call" as const,
      toolLifecycleStatus: input.status,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.firstCreatedAt ? { firstCreatedAt: input.firstCreatedAt } : {}),
    },
  });

  it("reports in-flight agents with their start time", () => {
    // Foreground delegations are live only inside their own running turn.
    const agents = deriveRunningAgentIndicators(
      [
        agentEntry({ id: "a", createdAt: "2026-01-01T00:00:10Z", status: "inProgress" }),
        agentEntry({
          id: "b",
          createdAt: "2026-01-01T00:00:20Z",
          status: "inProgress",
          label: "checker: verify the estimate",
        }),
      ],
      "turn-1" as never,
    );
    expect(agents).toHaveLength(2);
    expect(agents[0]?.startedAt).toBe("2026-01-01T00:00:10Z");
  });

  it("dedupes interleaved lifecycle updates by tool call id, keeping the earliest start", () => {
    const agents = deriveRunningAgentIndicators(
      [
        agentEntry({
          id: "a1",
          toolCallId: "tool-a",
          createdAt: "2026-01-01T00:00:10Z",
          status: "inProgress",
        }),
        agentEntry({
          id: "b1",
          toolCallId: "tool-b",
          createdAt: "2026-01-01T00:00:11Z",
          status: "inProgress",
        }),
        // A later streamed update for tool-a: newer createdAt, preserved
        // firstCreatedAt — elapsed must anchor on the original start.
        agentEntry({
          id: "a2",
          toolCallId: "tool-a",
          createdAt: "2026-01-01T00:05:00Z",
          firstCreatedAt: "2026-01-01T00:00:10Z",
          status: "inProgress",
        }),
      ],
      "turn-1" as never,
    );
    expect(agents).toHaveLength(2);
    expect(agents.find((agent) => agent.id === "tool-a")?.startedAt).toBe("2026-01-01T00:00:10Z");
  });

  it("drops agents whose latest update completed or failed", () => {
    const agents = deriveRunningAgentIndicators(
      [
        agentEntry({
          id: "a1",
          toolCallId: "tool-a",
          createdAt: "2026-01-01T00:00:10Z",
          status: "inProgress",
        }),
        agentEntry({
          id: "a2",
          toolCallId: "tool-a",
          createdAt: "2026-01-01T00:04:00Z",
          status: "completed",
        }),
      ],
      null,
    );
    expect(agents).toHaveLength(0);
  });

  it("scopes to the running turn when both sides know their turn", () => {
    const agents = deriveRunningAgentIndicators(
      [
        agentEntry({
          id: "stale",
          createdAt: "2026-01-01T00:00:10Z",
          status: "inProgress",
          turnId: "turn-0",
        }),
        agentEntry({ id: "live", createdAt: "2026-01-01T00:01:00Z", status: "inProgress" }),
      ],
      "turn-1" as never,
    );
    expect(agents).toHaveLength(1);
    // Identity is now turn + task text (nothing else survives the store).
    expect(agents[0]?.id).toContain("turn-1");
  });
});

describe("deriveAgentRoster — abandoned runs", () => {
  const activity = (
    kind: string,
    taskId: string,
    createdAt: string,
    extra: Record<string, unknown> = {},
  ) => ({
    kind,
    turnId: null,
    createdAt,
    payload: { taskId, ...extra },
  });

  it("keeps a task that started and never finished while the thread is still near it", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        activity("task.started", "t1", "2026-08-18T02:00:00.000Z", {
          taskType: "local_agent",
          detail: "Map web UI surfaces",
        }),
        activity("task.progress", "t1", "2026-08-18T02:05:00.000Z", { title: "Reading files" }),
        activity("message", "t1", "2026-08-18T02:20:00.000Z"),
      ],
    });
    expect(roster.map((item) => item.id)).toEqual(["t1"]);
  });

  // The reported bug, with its real numbers: both tasks started at 00:21 on the
  // 17th, went quiet, and the thread carried on for another twenty-five hours.
  it("drops a run that has been silent for a day", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        activity("task.started", "add1f3af3372027d8", "2026-08-17T00:21:56.309Z", {
          taskType: "local_agent",
          detail: "Map web UI surfaces for dialog",
        }),
        activity("task.progress", "add1f3af3372027d8", "2026-08-17T00:24:36.000Z", {
          title: "Read relay dialog and env hooks",
        }),
        activity("message", "x", "2026-08-18T02:11:00.000Z"),
      ],
    });
    expect(roster).toEqual([]);
  });

  it("does not bury an agent just because the thread went idle overnight", () => {
    // Nothing newer than the agent's own last step: the thread is asleep, not
    // the agent. Dropping it here would hide the only live thing on screen.
    const roster = deriveAgentRoster([], null, {
      activities: [
        activity("task.started", "t2", "2026-08-17T00:00:00.000Z", {
          taskType: "local_agent",
          detail: "Long job",
        }),
        activity("task.progress", "t2", "2026-08-17T00:30:00.000Z", { title: "Still going" }),
      ],
    });
    expect(roster.map((item) => item.id)).toEqual(["t2"]);
  });

  it("still drops it once the completion arrives, however late", () => {
    const roster = deriveAgentRoster([], null, {
      activities: [
        activity("task.started", "t3", "2026-08-18T02:00:00.000Z", {
          taskType: "local_agent",
          detail: "Short job",
        }),
        activity("task.completed", "t3", "2026-08-18T02:04:00.000Z", { status: "stopped" }),
      ],
    });
    expect(roster).toEqual([]);
  });
});

describe("resolveTimelineMinimapLane", () => {
  // Reported as: dragging across the first words of a message opens the
  // minimap preview instead of selecting them. The rail was anchored to the
  // viewport's left edge and sized against a content column 768px wide, while
  // the rendered one is `max-w-5xl` — so it stood on the text.
  it.each([24, 26, 35, 52, 68, 160, 400])(
    "keeps the rail one margin clear of the text with a %ipx gutter",
    (sideGutter) => {
      const lane = resolveTimelineMinimapLane(sideGutter);
      expect(lane.rightEdge + TIMELINE_MINIMAP_TEXT_SAFE_MARGIN).toBeLessThanOrEqual(sideGutter);
      // Ticks are drawn from the strip's left edge and grow toward the text, so
      // the longest one has to fit inside the strip to stay off the column.
      expect(lane.tickWidth).toBeLessThanOrEqual(lane.hitStripWidth);
    },
  );

  it("still draws a rail at the gutter the bug was reported at", () => {
    // 1280px window: the message column starts 26px into the timeline. The
    // rail shrinks to fit beside it rather than switching off, which is the
    // half of this fix a width-capped strip got wrong.
    const lane = resolveTimelineMinimapLane(26);
    expect(lane.hitStripWidth).toBeGreaterThan(0);
    expect(lane.tickWidth).toBeGreaterThanOrEqual(TIMELINE_MINIMAP_TICK_MIN_WIDTH);
    expect(lane.rightEdge).toBe(14);
  });

  it("follows the column instead of stranding the rail at the viewport edge", () => {
    // 1600px window: a viewport-anchored rail sat 108px from the text it
    // indexes. Anchored to the column it keeps the same 12px it has anywhere.
    const lane = resolveTimelineMinimapLane(160);
    expect(lane.rightEdge).toBe(148);
    expect(lane.hitStripWidth).toBe(40);
    expect(lane.tickWidth).toBe(24);
  });

  it("hides the rail only when the gutter cannot hold the shortest one", () => {
    expect(resolveTimelineMinimapLane(23).hitStripWidth).toBe(0);
    expect(resolveTimelineMinimapLane(0).hitStripWidth).toBe(0);
    expect(resolveTimelineMinimapLane(-10).hitStripWidth).toBe(0);
    expect(resolveTimelineMinimapLane(Number.NaN).hitStripWidth).toBe(0);
  });
});

describe("resolveTimelineMinimapTickWidth", () => {
  it("keeps the rail's original 24/16/10/8 ladder at full size", () => {
    expect(resolveTimelineMinimapTickWidth(24, 0)).toBe(24);
    expect(resolveTimelineMinimapTickWidth(24, 1)).toBe(16);
    expect(resolveTimelineMinimapTickWidth(24, 2)).toBe(10);
    expect(resolveTimelineMinimapTickWidth(24, 5)).toBe(8);
    expect(resolveTimelineMinimapTickWidth(24, null)).toBe(8);
  });

  it("scales the ladder down with a shrunken rail", () => {
    expect(resolveTimelineMinimapTickWidth(12, 0)).toBe(12);
    expect(resolveTimelineMinimapTickWidth(12, 1)).toBe(8);
    expect(resolveTimelineMinimapTickWidth(12, null)).toBe(4);
  });
});

describe("shouldAcceptTimelineMinimapClick", () => {
  it("accepts a click onto a rail hovered for a beat with no wheel in flight", () => {
    expect(
      shouldAcceptTimelineMinimapClick({
        hoveredSinceMs: 1_000,
        lastWheelAtMs: null,
        nowMs: 1_400,
      }),
    ).toBe(true);
    expect(
      shouldAcceptTimelineMinimapClick({ hoveredSinceMs: 1_000, lastWheelAtMs: 500, nowMs: 1_400 }),
    ).toBe(true);
  });

  it("ignores a click that lands the instant the pointer drifts onto the rail", () => {
    // A tap-to-click during a two-finger scroll, pointer resting over the
    // rail: the rail became hovered as the pointer arrived, not before.
    expect(
      shouldAcceptTimelineMinimapClick({
        hoveredSinceMs: 1_000,
        lastWheelAtMs: null,
        nowMs: 1_050,
      }),
    ).toBe(false);
    expect(
      shouldAcceptTimelineMinimapClick({ hoveredSinceMs: null, lastWheelAtMs: null, nowMs: 1_050 }),
    ).toBe(false);
  });

  it("ignores a click in the middle of a wheel", () => {
    expect(
      shouldAcceptTimelineMinimapClick({ hoveredSinceMs: 0, lastWheelAtMs: 1_200, nowMs: 1_400 }),
    ).toBe(false);
  });
});

describe("timeline reading anchor", () => {
  // Rows 100px each: row i starts at i * 100. Viewport 700px.
  const rows = Array.from({ length: 2_000 }, (_, i) => ({ id: `row-${i}` }));
  const state = (scroll: number, shift = 0): TimelineAnchorState => ({
    data: rows,
    scroll,
    scrollLength: 700,
    contentLength: rows.length * 100 + shift,
    positionAtIndex: (index) => (index < rows.length ? index * 100 + shift : undefined),
    positionByKey: (key) => {
      const index = Number(key.slice("row-".length));
      return Number.isInteger(index) && index < rows.length ? index * 100 + shift : undefined;
    },
  });
  const quiet = {
    userAttributable: false,
    gestureKind: null,
    programmaticExpected: false as const,
    followEnd: false,
  } as const;

  it("anchors on the row under the viewport's top, with its offset", () => {
    expect(resolveTimelineReadingAnchor(state(150_030))).toEqual({
      rowId: "row-1500",
      offset: -30,
    });
    expect(resolveTimelineReadingAnchor(state(0))).toEqual({ rowId: "row-0", offset: 0 });
  });

  it("leaves a scroll the app asked for alone", () => {
    const anchor = resolveTimelineReadingAnchor(state(150_030));
    expect(
      resolveTimelineReadingRestoreScroll({
        ...quiet,
        anchor,
        state: state(0),
        programmaticExpected: "any",
      }),
    ).toBeNull();
  });

  it("lets a scroll-to-end excuse only movement towards the end", () => {
    // The owner re-arms "I asked for the end" on every follow-mode pass, so
    // it must not cover a jump to the top — nothing that asks for the end
    // lands there.
    const anchor = resolveTimelineReadingAnchor(state(150_030));
    expect(
      resolveTimelineReadingRestoreScroll({
        ...quiet,
        anchor,
        state: state(199_300),
        programmaticExpected: "towards-end",
      }),
    ).toBeNull();
    expect(
      resolveTimelineReadingRestoreScroll({
        ...quiet,
        anchor,
        state: state(0),
        programmaticExpected: "towards-end",
        userAttributable: true,
        gestureKind: "wheel",
        followEnd: true,
      }),
    ).toBe(150_030);
  });

  it("leaves a scrollbar grab or a scroll key alone, however far they went", () => {
    const anchor = resolveTimelineReadingAnchor(state(150_030));
    for (const gestureKind of ["pointer", "key"] as const) {
      expect(
        resolveTimelineReadingRestoreScroll({
          ...quiet,
          anchor,
          state: state(0),
          userAttributable: true,
          gestureKind,
        }),
      ).toBeNull();
    }
  });

  it("leaves small movement and compensated prepends alone", () => {
    const anchor = resolveTimelineReadingAnchor(state(150_030));
    // A streamed row above grew by a screen: the row moved, within tolerance.
    expect(
      resolveTimelineReadingRestoreScroll({ ...quiet, anchor, state: state(150_030, 700) }),
    ).toBeNull();
    // A page of older rows prepended AND the scroll compensated: no change.
    expect(
      resolveTimelineReadingRestoreScroll({
        ...quiet,
        anchor,
        state: state(150_030 + 50_000, 50_000),
      }),
    ).toBeNull();
  });

  it("leaves the list pinning a following reader towards the end alone", () => {
    const anchor = resolveTimelineReadingAnchor(state(0));
    expect(
      resolveTimelineReadingRestoreScroll({
        ...quiet,
        anchor,
        state: state(199_300),
        followEnd: true,
      }),
    ).toBeNull();
  });

  it("restores the reader's row after a jump nobody asked for", () => {
    const anchor = resolveTimelineReadingAnchor(state(150_030));
    // Catapulted to the top: rows where they were, scroll at 0.
    expect(resolveTimelineReadingRestoreScroll({ ...quiet, anchor, state: state(0) })).toBe(
      150_030,
    );
    // A page prepended WITHOUT compensation: rows moved down, scroll did not.
    expect(
      resolveTimelineReadingRestoreScroll({ ...quiet, anchor, state: state(150_030, 50_000) }),
    ).toBe(200_030);
  });

  it("does not credit a whole-conversation jump to a wheel, even inside its window", () => {
    // The reported case: a slight wheel-up, then one event to the top within
    // the attribution window — and while still following the live edge.
    const anchor = resolveTimelineReadingAnchor(state(150_030));
    expect(
      resolveTimelineReadingRestoreScroll({
        ...quiet,
        anchor,
        state: state(0),
        userAttributable: true,
        gestureKind: "wheel",
        followEnd: true,
      }),
    ).toBe(150_030);
    // A wheel-sized move inside that same window is the wheel.
    expect(
      resolveTimelineReadingRestoreScroll({
        ...quiet,
        anchor,
        state: state(149_800),
        userAttributable: true,
        gestureKind: "wheel",
        followEnd: true,
      }),
    ).toBeNull();
  });

  it("does nothing when the anchored row is gone", () => {
    const anchor = { rowId: "row-gone", offset: 0 };
    expect(resolveTimelineReadingRestoreScroll({ ...quiet, anchor, state: state(0) })).toBeNull();
  });
});

describe("isUserAttributableTimelineScroll", () => {
  it("attributes a scroll inside the gesture window to the reader", () => {
    expect(
      isUserAttributableTimelineScroll(1_000, 1_000 + TIMELINE_USER_SCROLL_ATTRIBUTION_MS),
    ).toBe(true);
  });

  it("treats a scroll with no recent gesture as the layout moving, not the reader", () => {
    expect(isUserAttributableTimelineScroll(null, 5_000)).toBe(false);
    expect(
      isUserAttributableTimelineScroll(1_000, 1_001 + TIMELINE_USER_SCROLL_ATTRIBUTION_MS),
    ).toBe(false);
  });
});

describe("resolveTimelineDistanceFromEnd", () => {
  it("measures the gap between the viewport bottom and the content end", () => {
    expect(
      resolveTimelineDistanceFromEnd({ contentLength: 10_000, scroll: 9_000, scrollLength: 800 }),
    ).toBe(200);
  });

  it("never reports a negative distance while a clamp is settling", () => {
    expect(
      resolveTimelineDistanceFromEnd({ contentLength: 500, scroll: 400, scrollLength: 800 }),
    ).toBe(0);
  });

  it("reports nothing for a list that has not measured itself", () => {
    expect(resolveTimelineDistanceFromEnd(undefined)).toBeNull();
    expect(resolveTimelineDistanceFromEnd({ scroll: 100, scrollLength: 800 })).toBeNull();
  });
});

describe("shouldSnapTimelineToEndAfterTurnSettle", () => {
  it("snaps a reader who was within one viewport of the end", () => {
    expect(
      shouldSnapTimelineToEndAfterTurnSettle({ distanceFromEnd: 799, scrollLength: 800 }),
    ).toBe(true);
    expect(shouldSnapTimelineToEndAfterTurnSettle({ distanceFromEnd: 0, scrollLength: 800 })).toBe(
      true,
    );
  });

  it("leaves a reader further up reading history alone", () => {
    expect(
      shouldSnapTimelineToEndAfterTurnSettle({ distanceFromEnd: 801, scrollLength: 800 }),
    ).toBe(false);
  });

  it("does nothing without a measurement to decide from", () => {
    expect(
      shouldSnapTimelineToEndAfterTurnSettle({ distanceFromEnd: null, scrollLength: 800 }),
    ).toBe(false);
    expect(
      shouldSnapTimelineToEndAfterTurnSettle({ distanceFromEnd: 100, scrollLength: undefined }),
    ).toBe(false);
    expect(shouldSnapTimelineToEndAfterTurnSettle({ distanceFromEnd: 100, scrollLength: 0 })).toBe(
      false,
    );
  });
});
