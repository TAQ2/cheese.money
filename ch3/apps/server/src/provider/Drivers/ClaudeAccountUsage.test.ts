import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";

import { claudeCredentialServices, parseClaudeAccountUsage } from "./ClaudeAccountUsage.ts";

// The real response shape from https://api.anthropic.com/api/oauth/usage,
// trimmed to the keys read here. Note it reports `utilization`, NOT
// `used_percentage`, and carries `*_dollars` keys that are null on a plan.
const realResponse = JSON.stringify({
  five_hour: {
    utilization: 26.0,
    resets_at: "2026-08-04T08:30:00.467042+00:00",
    limit_dollars: null,
    used_dollars: null,
  },
  seven_day: { utilization: 3.0, resets_at: "2026-08-08T12:59:00+00:00" },
  seven_day_opus: { utilization: 4.0 },
  extra_usage: {},
});

describe("Claude account usage", () => {
  it("reads both windows from the endpoint's real shape", () => {
    expect(parseClaudeAccountUsage(realResponse)).toEqual({
      sessionPercent: 26,
      weekPercent: 3,
      sessionResetsAt: "2026-08-04T08:30:00.467042+00:00",
      weekResetsAt: "2026-08-08T12:59:00+00:00",
    });
  });

  it("reports unknown rather than zero when a window is missing", () => {
    // The trap: `used_percentage` is the statusline STDIN field name, absent
    // here. Reading it yields null, and calling that 0% would make an
    // exhausted account look like a safe account to hand over to.
    const wrongField = JSON.stringify({
      five_hour: { used_percentage: 99 },
      seven_day: { used_percentage: 99 },
    });
    expect(parseClaudeAccountUsage(wrongField)).toBeUndefined();
    expect(
      parseClaudeAccountUsage(JSON.stringify({ five_hour: { utilization: 26 } })),
    ).toBeUndefined();
    expect(
      parseClaudeAccountUsage(JSON.stringify({ five_hour: null, seven_day: null })),
    ).toBeUndefined();
  });

  it("never throws on junk, empty, or an error body", () => {
    expect(parseClaudeAccountUsage("")).toBeUndefined();
    expect(parseClaudeAccountUsage("not json")).toBeUndefined();
    expect(parseClaudeAccountUsage(JSON.stringify({ error: "unauthorized" }))).toBeUndefined();
  });

  it("keeps a window reported as zero, which is not the same as missing", () => {
    const fresh = JSON.stringify({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } });
    expect(parseClaudeAccountUsage(fresh)).toEqual({ sessionPercent: 0, weekPercent: 0 });
  });

  it("derives the Keychain service from the config directory's sha256", () => {
    // These two are the actual entries in this machine's Keychain, which is
    // how the scheme was established in the first place.
    expect(claudeCredentialServices("/Users/conradws/.claude-work")).toEqual([
      "Claude Code-credentials-02d23a66",
    ]);
    expect(claudeCredentialServices("/Users/conradws/.claude")[0]).toBe(
      "Claude Code-credentials-76e46a53",
    );
  });

  it("offers the legacy unsuffixed name for the default home only", () => {
    // The unsuffixed entry belongs to the default account. Offering it as a
    // fallback for a custom directory reports the WRONG account's usage —
    // precisely the bug that pinned the status line to the personal account.
    const home = NodeOS.homedir();
    expect(claudeCredentialServices(`${home}/.claude`)).toContain("Claude Code-credentials");
    expect(claudeCredentialServices(`${home}/.claude-work`)).not.toContain(
      "Claude Code-credentials",
    );
    expect(claudeCredentialServices(`${home}/.claude-work`)).toHaveLength(1);
  });
});
