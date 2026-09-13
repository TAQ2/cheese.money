import { describe, expect, it } from "vite-plus/test";

import { nextUsageReadKey, useClaudeAccountSwitchStore } from "./claudeAccountSwitchStore";

describe("nextUsageReadKey", () => {
  it("starts a revision on a key that has none", () => {
    expect(nextUsageReadKey("/Users/me/.claude-4")).toBe("/Users/me/.claude-4#1");
  });

  it("increments the revision it already carries", () => {
    expect(nextUsageReadKey("/Users/me/.claude-4#1")).toBe("/Users/me/.claude-4#2");
    expect(nextUsageReadKey("/Users/me/.claude-4#9")).toBe("/Users/me/.claude-4#10");
  });

  it("keeps producing a NEW key, which is the whole point", () => {
    // The band refetches because the key changed. A revision that ever repeats
    // is a read the person asked for and did not get.
    let key = "";
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      key = nextUsageReadKey(key);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("revises before any switch has been recorded", () => {
    // The band treats an empty key as "no switch yet" and reads the default
    // account. A forced read still has to move it off that.
    expect(nextUsageReadKey("")).toBe("#1");
  });

  it("leaves a hash that is not a revision alone", () => {
    expect(nextUsageReadKey("/Users/me/.claude#draft")).toBe("/Users/me/.claude#draft#1");
  });
});

describe("useClaudeAccountSwitchStore", () => {
  it("drops the read revision when the account changes", () => {
    const store = useClaudeAccountSwitchStore.getState();
    store.noteAccountSwitched("/Users/me/.claude-4");
    store.noteUsageRead();
    store.noteUsageRead();
    expect(useClaudeAccountSwitchStore.getState().accountKey).toBe("/Users/me/.claude-4#2");

    // A switch is a different account, so its readings start over rather than
    // inheriting a count from the account just left.
    store.noteAccountSwitched("/Users/me/.claude-3");
    expect(useClaudeAccountSwitchStore.getState().accountKey).toBe("/Users/me/.claude-3");
  });
});
