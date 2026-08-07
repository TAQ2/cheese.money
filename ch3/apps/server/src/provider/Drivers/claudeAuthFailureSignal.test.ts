import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  claudeAuthFailureWithin,
  isClaudeAuthFailureMessage,
  recordClaudeAuthFailure,
  resetClaudeAuthFailureSignal,
} from "./claudeAuthFailureSignal.ts";

describe("claudeAuthFailureSignal", () => {
  afterEach(() => resetClaudeAuthFailureSignal());

  it("recognises the CLI's authentication failures", () => {
    expect(
      isClaudeAuthFailureMessage(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(true);
    expect(
      isClaudeAuthFailureMessage(
        "OAuth refresh token is no longer valid; run /login to re-authenticate",
      ),
    ).toBe(true);
  });

  it("ignores ordinary turn failures", () => {
    expect(isClaudeAuthFailureMessage("Claude turn failed.")).toBe(false);
    expect(isClaudeAuthFailureMessage("rate limit exceeded")).toBe(false);
    expect(recordClaudeAuthFailure("tool crashed", 1_000)).toBe(false);
    expect(claudeAuthFailureWithin(60_000, 2_000)).toBe(false);
  });

  it("reports a recorded failure only within the window", () => {
    expect(recordClaudeAuthFailure("Failed to authenticate: OAuth session expired", 1_000)).toBe(
      true,
    );
    expect(claudeAuthFailureWithin(60_000, 30_000)).toBe(true);
    expect(claudeAuthFailureWithin(60_000, 70_000)).toBe(false);
  });

  it("forgets everything on reset", () => {
    recordClaudeAuthFailure("Failed to authenticate: OAuth session expired", 1_000);
    resetClaudeAuthFailureSignal();
    expect(claudeAuthFailureWithin(60_000, 1_001)).toBe(false);
  });
});
