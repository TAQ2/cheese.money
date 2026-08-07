import { describe, expect, it } from "vite-plus/test";

import { readProviderSessionIdFromCursor } from "./providerSessionId.ts";

describe("readProviderSessionIdFromCursor", () => {
  it("reads Claude's resume id", () => {
    // Shape taken from a real cursor written by ClaudeAdapter.
    expect(
      readProviderSessionIdFromCursor({
        threadId: "4dececf9-88c7-4a1b-9f0e-000000000000",
        resume: "2fb31ee6-83ef-4f87-98d7-b6c14d2a0114",
        resumeSessionAt: "2026-07-30T11:00:00.000Z",
        turnCount: 12,
      }),
    ).toBe("2fb31ee6-83ef-4f87-98d7-b6c14d2a0114");
  });

  it("reads OpenCode's sessionId, which is not a UUID", () => {
    expect(
      readProviderSessionIdFromCursor({
        schemaVersion: 1,
        sessionId: "ses_04c6377ebffeAX96J3nseZl2Uz",
      }),
    ).toBe("ses_04c6377ebffeAX96J3nseZl2Uz");
  });

  it("prefers resume over sessionId when a cursor carries both", () => {
    expect(
      readProviderSessionIdFromCursor({ resume: "from-resume", sessionId: "from-session" }),
    ).toBe("from-resume");
  });

  it("returns null when the thread has no cursor yet", () => {
    expect(readProviderSessionIdFromCursor(null)).toBeNull();
    expect(readProviderSessionIdFromCursor(undefined)).toBeNull();
  });

  it("returns null for cursors without an id, rather than inventing one", () => {
    expect(readProviderSessionIdFromCursor({ turnCount: 3 })).toBeNull();
    expect(readProviderSessionIdFromCursor({ resume: 42 })).toBeNull();
    expect(readProviderSessionIdFromCursor({ resume: "   " })).toBeNull();
    expect(readProviderSessionIdFromCursor("a-bare-string")).toBeNull();
  });
});
