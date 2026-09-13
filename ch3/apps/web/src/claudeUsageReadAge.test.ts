import { describe, expect, it } from "vite-plus/test";

import { formatClaudeUsageReadAge } from "./claudeUsageReadAge";

const at = (iso: string) => Date.parse(iso);

describe("formatClaudeUsageReadAge", () => {
  it("dates a reading the endpoint would not refresh", () => {
    // The case this exists for: the usage read is itself rate limited, the
    // last numbers stay on screen, and they must not read as current.
    expect(
      formatClaudeUsageReadAge("2026-08-20T12:00:00.000Z", at("2026-08-20T12:12:30.000Z")),
    ).toBe("read 12m ago");
  });

  it("says just now inside the first minute, so a fresh read stays quiet", () => {
    expect(
      formatClaudeUsageReadAge("2026-08-20T12:00:00.000Z", at("2026-08-20T12:00:40.000Z")),
    ).toBe("read just now");
  });

  it("moves to hours and days rather than counting minutes forever", () => {
    expect(
      formatClaudeUsageReadAge("2026-08-20T09:00:00.000Z", at("2026-08-20T12:00:00.000Z")),
    ).toBe("read 3h ago");
    expect(
      formatClaudeUsageReadAge("2026-08-20T09:00:00.000Z", at("2026-08-20T12:25:00.000Z")),
    ).toBe("read 3h 25m ago");
    expect(
      formatClaudeUsageReadAge("2026-08-18T09:00:00.000Z", at("2026-08-20T12:00:00.000Z")),
    ).toBe("read 2d ago");
  });

  it("says nothing for a reading with no stamp or an unreadable one", () => {
    expect(formatClaudeUsageReadAge(undefined, at("2026-08-20T12:00:00.000Z"))).toBeNull();
    expect(formatClaudeUsageReadAge("not-a-date", at("2026-08-20T12:00:00.000Z"))).toBeNull();
  });

  it("never counts backwards when a clock disagrees", () => {
    expect(
      formatClaudeUsageReadAge("2026-08-20T12:05:00.000Z", at("2026-08-20T12:00:00.000Z")),
    ).toBe("read just now");
  });
});
