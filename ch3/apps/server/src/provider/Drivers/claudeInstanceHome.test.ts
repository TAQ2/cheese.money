import type { ProviderInstanceConfig } from "@ch3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { resolveClaudeInstanceHomePath } from "./claudeInstanceHome.ts";

const claudeInstance = (homePath?: string): ProviderInstanceConfig =>
  ({
    driver: "claudeAgent",
    ...(homePath === undefined ? {} : { config: { homePath } }),
  }) as ProviderInstanceConfig;

describe("Claude instance home resolution", () => {
  it("reads the instance config, which is where the account switcher writes", () => {
    // The real shape on this machine: providerInstances.claudeAgent.config
    // holds the selected account, and providers.claudeAgent is `{}`.
    expect(
      resolveClaudeInstanceHomePath({
        providerInstances: { claudeAgent: claudeInstance("/Users/conradws/.claude-work") },
        legacyHomePath: "",
      }),
    ).toBe("/Users/conradws/.claude-work");
  });

  it("does not fall through to the legacy block when an instance exists", () => {
    // The regression: an empty legacy block resolved to the default home, so
    // the status line reported the personal account after every switch.
    expect(
      resolveClaudeInstanceHomePath({
        providerInstances: { claudeAgent: claudeInstance() },
        legacyHomePath: "/Users/conradws/.claude-stale",
      }),
    ).toBe("");
  });

  it("falls back to the legacy block only when no Claude instance exists", () => {
    expect(
      resolveClaudeInstanceHomePath({
        providerInstances: { codex: { driver: "codex" } as ProviderInstanceConfig },
        legacyHomePath: "/Users/conradws/.claude-work",
      }),
    ).toBe("/Users/conradws/.claude-work");
    expect(resolveClaudeInstanceHomePath({})).toBe("");
  });

  it("prefers the driver's default instance over other Claude instances", () => {
    expect(
      resolveClaudeInstanceHomePath({
        providerInstances: {
          "claude-secondary": claudeInstance("/Users/conradws/.claude-other"),
          claudeAgent: claudeInstance("/Users/conradws/.claude-work"),
        },
      }),
    ).toBe("/Users/conradws/.claude-work");
  });

  it("uses another Claude instance when the default one is absent", () => {
    expect(
      resolveClaudeInstanceHomePath({
        providerInstances: { "claude-secondary": claudeInstance("/Users/conradws/.claude-other") },
      }),
    ).toBe("/Users/conradws/.claude-other");
  });
});
