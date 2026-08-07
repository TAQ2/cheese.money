import type { ClaudeAccountProfile } from "@ch3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  chooseClaudeAuthFailoverTarget,
  chooseClaudeFailoverTarget,
} from "./claudeAccountFailover.ts";

const personal = (
  usage?: { sessionPercent: number; weekPercent: number },
  isCurrent = true,
): ClaudeAccountProfile => ({
  homePath: "/Users/conradws/.claude",
  displayPath: "~/.claude",
  email: "conrad@baubap.com",
  organizationName: "conrad@baubap.com's Organization",
  subscriptionLabel: "Claude Max Subscription",
  isCurrent,
  isDefaultHome: true,
  ...(usage ? { usage } : {}),
});

const work = (
  usage?: { sessionPercent: number; weekPercent: number },
  isCurrent = false,
): ClaudeAccountProfile => ({
  homePath: "/Users/conradws/.claude-work",
  displayPath: "~/.claude-work",
  email: "conrad@baubap.com",
  organizationName: "Baubap",
  subscriptionLabel: "Claude Max Subscription",
  isCurrent,
  isDefaultHome: false,
  ...(usage ? { usage } : {}),
});

const at = (thresholdPercent: number) => (profiles: ReadonlyArray<ClaudeAccountProfile>) =>
  chooseClaudeFailoverTarget({ profiles, thresholdPercent });

describe("Claude account failover", () => {
  const decide = at(98);

  it("hands over when the session window is exhausted", () => {
    // The real numbers from this machine: personal nearly spent, work fresh.
    const decision = decide([
      personal({ sessionPercent: 99, weekPercent: 41 }),
      work({ sessionPercent: 26, weekPercent: 3 }),
    ]);
    expect(decision?.homePath).toBe("/Users/conradws/.claude-work");
    expect(decision?.reason).toContain("5-hour session");
  });

  it("hands over when the weekly window is exhausted even if the session is fine", () => {
    const decision = decide([
      personal({ sessionPercent: 10, weekPercent: 99 }),
      work({ sessionPercent: 26, weekPercent: 3 }),
    ]);
    expect(decision?.homePath).toBe("/Users/conradws/.claude-work");
    expect(decision?.reason).toContain("weekly");
  });

  it("stores an empty homePath when handing over TO the default account", () => {
    // The invariant that took every thread down once: the default profile must
    // never be stored as an explicit path.
    const decision = decide([
      personal({ sessionPercent: 2, weekPercent: 1 }, false),
      work({ sessionPercent: 99, weekPercent: 80 }, true),
    ]);
    expect(decision?.homePath).toBe("");
    expect(decision?.to.organizationName).toBe("conrad@baubap.com's Organization");
  });

  it("stays put while the current account still has room", () => {
    // 97 is one point under the threshold — still the current account's turn.
    expect(
      decide([
        personal({ sessionPercent: 97, weekPercent: 41 }),
        work({ sessionPercent: 1, weekPercent: 1 }),
      ]),
    ).toBeNull();
  });

  it("never hands over to an account that is not signed in", () => {
    const signedOut: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claude-work",
      displayPath: "~/.claude-work",
      isCurrent: false,
      isDefaultHome: false,
    };
    expect(decide([personal({ sessionPercent: 99, weekPercent: 99 }), signedOut])).toBeNull();
  });

  it("never hands over to an account whose usage is unknown", () => {
    // Unknown is not empty. Treating it as empty fails over into a second
    // exhausted account and the next turn dies anyway.
    expect(decide([personal({ sessionPercent: 99, weekPercent: 99 }), work()])).toBeNull();
  });

  it("refuses a target that is barely better, so it cannot flap", () => {
    // 96% is under the threshold but only three points better than the dying
    // account — it buys minutes, then hands straight back.
    expect(
      decide([
        personal({ sessionPercent: 99, weekPercent: 10 }),
        work({ sessionPercent: 96, weekPercent: 10 }),
      ]),
    ).toBeNull();
  });

  it("accepts a target exactly the margin better", () => {
    expect(
      decide([
        personal({ sessionPercent: 99, weekPercent: 10 }),
        work({ sessionPercent: 94, weekPercent: 10 }),
      ])?.homePath,
    ).toBe("/Users/conradws/.claude-work");
  });

  it("does nothing without usage for the current account", () => {
    expect(
      decide([personal(undefined, true), work({ sessionPercent: 1, weekPercent: 1 })]),
    ).toBeNull();
  });

  it("picks the account with the most headroom", () => {
    const third: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claude-third",
      displayPath: "~/.claude-third",
      email: "conrad@baubap.com",
      organizationName: "Third",
      isCurrent: false,
      isDefaultHome: false,
      usage: { sessionPercent: 2, weekPercent: 2 },
    };
    const decision = decide([
      personal({ sessionPercent: 99, weekPercent: 41 }),
      work({ sessionPercent: 40, weekPercent: 3 }),
      third,
    ]);
    expect(decision?.homePath).toBe("/Users/conradws/.claude-third");
  });
});

describe("Claude account failover on authentication failure", () => {
  const authDead = (): ClaudeAccountProfile => ({
    ...personal(undefined, true),
    usageUnauthorized: true,
  });
  const decide = (profiles: ReadonlyArray<ClaudeAccountProfile>) =>
    chooseClaudeAuthFailoverTarget({ profiles, thresholdPercent: 98 });

  it("hands over from a dead account to any live one, no margin required", () => {
    // 96% headroom-wise would fail the plan-limit chooser's margin; a dead
    // account has no standing to demand one.
    const decision = decide([authDead(), work({ sessionPercent: 96, weekPercent: 10 })]);
    expect(decision?.homePath).toBe("/Users/conradws/.claude-work");
    expect(decision?.reason).toContain("can no longer authenticate");
  });

  it("never acts on absent usage without an observed rejection", () => {
    // Unread usage is silence, not evidence. Only an explicit 401/403 counts.
    expect(
      chooseClaudeAuthFailoverTarget({
        profiles: [personal(undefined, true), work({ sessionPercent: 1, weekPercent: 1 })],
        thresholdPercent: 98,
      }),
    ).toBeNull();
  });

  it("never acts when the current account has readable usage", () => {
    const oddButAlive: ClaudeAccountProfile = {
      ...personal({ sessionPercent: 99, weekPercent: 10 }, true),
      usageUnauthorized: true,
    };
    expect(decide([oddButAlive, work({ sessionPercent: 1, weekPercent: 1 })])).toBeNull();
  });

  it("acts on an adapter-observed failure even when usage looks healthy", () => {
    // Usage is read per ACCOUNT and can be served by another profile's
    // credential while the profile's own refresh token is revoked — turns
    // fail, numbers look fine. The adapter's observation wins.
    const decision = chooseClaudeAuthFailoverTarget({
      profiles: [
        personal({ sessionPercent: 10, weekPercent: 38 }, true),
        work({ sessionPercent: 1, weekPercent: 1 }),
      ],
      thresholdPercent: 98,
      currentAuthFailureObserved: true,
    });
    expect(decision?.homePath).toBe("/Users/conradws/.claude-work");
    expect(decision?.reason).toContain("can no longer authenticate");
  });

  it("refuses a target at or over the threshold or without readable usage", () => {
    expect(decide([authDead(), work({ sessionPercent: 98, weekPercent: 10 })])).toBeNull();
    expect(decide([authDead(), work()])).toBeNull();
  });

  it("picks the candidate with the most headroom", () => {
    const decision = decide([
      authDead(),
      work({ sessionPercent: 40, weekPercent: 3 }),
      {
        ...work({ sessionPercent: 2, weekPercent: 2 }),
        homePath: "/Users/conradws/.claude-third",
        displayPath: "~/.claude-third",
      },
    ]);
    expect(decision?.homePath).toBe("/Users/conradws/.claude-third");
  });
});
