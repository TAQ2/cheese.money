import { describe, expect, it } from "@effect/vitest";

import {
  CLAUDE_SIGN_IN_PARTITION_PREFIX,
  formatClaudeSignInPartition,
  nextClaudeSignInPartition,
  partitionIsEphemeral,
} from "./claudeSignInPartition.ts";

describe("Claude sign-in partition", () => {
  it("never asks Electron for a persisted session", () => {
    // The whole fix rests on this: `persist:` would write the wrong account's
    // cookies to disk and carry them into the next app run, which is the
    // failure being repaired rather than a variation on it.
    expect(CLAUDE_SIGN_IN_PARTITION_PREFIX.startsWith("persist:")).toBe(false);
    expect(partitionIsEphemeral(nextClaudeSignInPartition())).toBe(true);
    expect(partitionIsEphemeral("persist:ch3-preview-abc")).toBe(false);
  });

  it("hands every attempt a name no earlier attempt used", () => {
    // An in-memory session still outlives a single sign-in, so reusing one
    // name would let the second sign-in in an app run see the first one's
    // cookies — the reported bug, minus the restart.
    const names = new Set(Array.from({ length: 50 }, () => nextClaudeSignInPartition()));
    expect(names.size).toBe(50);
  });

  it("labels the session as CH3's own", () => {
    const partition = nextClaudeSignInPartition();
    expect(partition.startsWith(CLAUDE_SIGN_IN_PARTITION_PREFIX)).toBe(true);
    // Nothing shared with the preview browser's jars, which are persisted.
    expect(partition.startsWith("persist:ch3-preview-")).toBe(false);
  });

  it("formats a readable name from the attempt and the nonce", () => {
    expect(formatClaudeSignInPartition({ attempt: 7, nonce: "abc" })).toBe(
      "ch3-claude-signin-7-abc",
    );
  });
});
