import type { ClaudeAccountProfile } from "@ch3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  chooseClaudeRotationTarget,
  ROTATION_CANDIDATE_SESSION_LIMIT_PERCENT,
  weeklyBurnableRate,
} from "./claudeAccountRotation.ts";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
// @effect-diagnostics-next-line globalDate:off
const daysFromNow = (days: number) => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();

const account = (
  name: string,
  usage:
    | {
        sessionPercent: number;
        weekPercent: number;
        weekResetsAt?: string;
      }
    | undefined,
  options: { isCurrent?: boolean; isDefaultHome?: boolean } = {},
): ClaudeAccountProfile => ({
  homePath: `/Users/someone/.claude-${name}`,
  displayPath: `~/.claude-${name}`,
  email: "someone@example.com",
  organizationName: name,
  isCurrent: options.isCurrent ?? false,
  isDefaultHome: options.isDefaultHome ?? false,
  ...(usage ? { usage } : {}),
});

describe("weeklyBurnableRate", () => {
  it("prefers expiring capacity over idle capacity — the defining example", () => {
    // 70% used but resets tomorrow: 30% to burn in 1 day.
    const expiring = weeklyBurnableRate({
      weekPercent: 70,
      weekResetsAt: daysFromNow(1),
      nowMs: NOW,
    });
    // 10% used but six days of runway: 90% spread over 6 days.
    const idle = weeklyBurnableRate({ weekPercent: 10, weekResetsAt: daysFromNow(6), nowMs: NOW });
    expect(expiring).toBe(30);
    expect(idle).toBe(15);
    expect(expiring).toBeGreaterThan(idle);
  });

  it("treats a missing or unreadable reset as the full week of runway", () => {
    expect(weeklyBurnableRate({ weekPercent: 30, weekResetsAt: undefined, nowMs: NOW })).toBe(10);
    expect(weeklyBurnableRate({ weekPercent: 30, weekResetsAt: "garbage", nowMs: NOW })).toBe(10);
  });

  it("clamps an imminent reset instead of scoring toward infinity", () => {
    const rate = weeklyBurnableRate({
      weekPercent: 50,
      // @effect-diagnostics-next-line globalDate:off
      weekResetsAt: new Date(NOW + 1000).toISOString(),
      nowMs: NOW,
    });
    expect(rate).toBe(50 / (1 / 24));
    expect(Number.isFinite(rate)).toBe(true);
  });
});

describe("chooseClaudeRotationTarget", () => {
  it("rotates to the account whose weekly allowance expires soonest", () => {
    const decision = chooseClaudeRotationTarget({
      nowMs: NOW,
      profiles: [
        account(
          "idle",
          { sessionPercent: 65, weekPercent: 10, weekResetsAt: daysFromNow(6) },
          { isCurrent: true },
        ),
        account("expiring", { sessionPercent: 20, weekPercent: 70, weekResetsAt: daysFromNow(1) }),
      ],
    });
    expect(decision?.to.organizationName).toBe("expiring");
    expect(decision?.reason).toContain("resting idle");
  });

  it("sticks with the incumbent until it has spent 60% of its session", () => {
    // The identical comparison, but the incumbent's session is still fresh:
    // rotation stays asleep no matter how attractive the challenger looks.
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "idle",
            { sessionPercent: 59, weekPercent: 10, weekResetsAt: daysFromNow(6) },
            { isCurrent: true },
          ),
          account("expiring", {
            sessionPercent: 20,
            weekPercent: 70,
            weekResetsAt: daysFromNow(1),
          }),
        ],
      }),
    ).toBeNull();
  });

  it("seats the best account at startup, ignoring stickiness and margins", () => {
    // Same fresh-session incumbent, but at startup nobody has earned the
    // seat yet — any strictly better account takes it.
    const decision = chooseClaudeRotationTarget({
      nowMs: NOW,
      phase: "startup",
      profiles: [
        account(
          "idle",
          { sessionPercent: 5, weekPercent: 30, weekResetsAt: daysFromNow(7) },
          { isCurrent: true },
        ),
        account("slightly", { sessionPercent: 0, weekPercent: 16, weekResetsAt: daysFromNow(7) }),
      ],
    });
    expect(decision?.to.organizationName).toBe("slightly");
    expect(decision?.reason).toContain("starting on");
  });

  it("requires a real gap at startup, so restarts cannot alternate the seat", () => {
    // 10.14 vs 10 %/day is noise; without a gap every relaunch would flip
    // between near-equal accounts and pay an instance rebuild each time.
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        phase: "startup",
        profiles: [
          account(
            "current",
            { sessionPercent: 5, weekPercent: 30, weekResetsAt: daysFromNow(7) },
            { isCurrent: true },
          ),
          account("noise", { sessionPercent: 0, weekPercent: 29, weekResetsAt: daysFromNow(7) }),
        ],
      }),
    ).toBeNull();
  });

  it("stays put at startup when the incumbent is already the best", () => {
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        phase: "startup",
        profiles: [
          account(
            "best",
            { sessionPercent: 5, weekPercent: 10, weekResetsAt: daysFromNow(1) },
            { isCurrent: true },
          ),
          account("worse", { sessionPercent: 0, weekPercent: 50, weekResetsAt: daysFromNow(6) }),
        ],
      }),
    ).toBeNull();
  });

  it("stays put when the margin is not met, so it cannot flap", () => {
    // After the switch above the roles invert; the same inputs reversed must
    // NOT switch back.
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "expiring",
            { sessionPercent: 65, weekPercent: 70, weekResetsAt: daysFromNow(1) },
            { isCurrent: true },
          ),
          account("idle", { sessionPercent: 10, weekPercent: 10, weekResetsAt: daysFromNow(6) }),
        ],
      }),
    ).toBeNull();
  });

  it("requires both the factor and the absolute gain", () => {
    // 12 vs 10 %/day: factor not met.
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "current",
            { sessionPercent: 70, weekPercent: 30, weekResetsAt: daysFromNow(7) },
            { isCurrent: true },
          ),
          account("slightly", { sessionPercent: 0, weekPercent: 16, weekResetsAt: daysFromNow(7) }),
        ],
      }),
    ).toBeNull();
    // 4 vs 2 %/day: factor met, absolute gain of 2 is under the floor.
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "current",
            { sessionPercent: 70, weekPercent: 86, weekResetsAt: daysFromNow(7) },
            { isCurrent: true },
          ),
          account("barely", { sessionPercent: 0, weekPercent: 72, weekResetsAt: daysFromNow(7) }),
        ],
      }),
    ).toBeNull();
  });

  it("refuses to seat an account already past the stickiness threshold", () => {
    // A candidate at the engagement threshold would trigger re-evaluation on
    // the very next tick; one just under it is seatable.
    const blockedAt = (sessionPercent: number) =>
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "current",
            { sessionPercent: 70, weekPercent: 80, weekResetsAt: daysFromNow(6) },
            { isCurrent: true },
          ),
          account("candidate", {
            sessionPercent,
            weekPercent: 5,
            weekResetsAt: daysFromNow(1),
          }),
        ],
      });
    expect(blockedAt(ROTATION_CANDIDATE_SESSION_LIMIT_PERCENT)).toBeNull();
    expect(blockedAt(ROTATION_CANDIDATE_SESSION_LIMIT_PERCENT - 1)?.to.organizationName).toBe(
      "candidate",
    );
  });

  it("engages at exactly 60% of the incumbent's session", () => {
    const withCurrentSession = (sessionPercent: number) =>
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "current",
            { sessionPercent, weekPercent: 80, weekResetsAt: daysFromNow(6) },
            { isCurrent: true },
          ),
          account("fresh", { sessionPercent: 5, weekPercent: 5, weekResetsAt: daysFromNow(1) }),
        ],
      });
    expect(withCurrentSession(60)?.to.organizationName).toBe("fresh");
    expect(withCurrentSession(59)).toBeNull();
  });

  it("switches immediately at 99% weekly usage, whatever the session says", () => {
    // The weekly escape: at 99% the window is spent, so the best available
    // sibling takes over at once — no stickiness, no margins.
    const decision = chooseClaudeRotationTarget({
      nowMs: NOW,
      profiles: [
        account(
          "spent",
          { sessionPercent: 25, weekPercent: 99, weekResetsAt: daysFromNow(5) },
          { isCurrent: true },
        ),
        account("fresh", { sessionPercent: 5, weekPercent: 5, weekResetsAt: daysFromNow(5) }),
      ],
    });
    expect(decision?.to.organizationName).toBe("fresh");
  });

  it("keeps working a heavily-used week below the 99% escape", () => {
    // 94% used still leaves real capacity; with a fresh session the account
    // keeps the seat rather than wasting its expiring allowance.
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "working",
            { sessionPercent: 25, weekPercent: 94, weekResetsAt: daysFromNow(5) },
            { isCurrent: true },
          ),
          account("fresh", { sessionPercent: 5, weekPercent: 5, weekResetsAt: daysFromNow(5) }),
        ],
      }),
    ).toBeNull();
  });

  it("waives the margins only once the session window is spent", () => {
    // A candidate with a far WORSE weekly rate (8%/day against 80%/day) takes
    // the seat at the escape, because the incumbent can no longer serve.
    const stalling = (sessionPercent: number) =>
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "stalling",
            { sessionPercent, weekPercent: 20, weekResetsAt: daysFromNow(1) },
            { isCurrent: true },
          ),
          account("modest", { sessionPercent: 10, weekPercent: 60, weekResetsAt: daysFromNow(5) }),
        ],
      });

    expect(stalling(99)?.to.organizationName).toBe("modest");
    // Below it the margins still rule. A high session alone must NOT hand the
    // seat to a worse-positioned account: the incumbent holds allowance that
    // expires tomorrow, and above 98% failover takes over anyway.
    expect(stalling(86)).toBeNull();
    expect(stalling(91)).toBeNull();
  });

  it("never rotates between directories sharing one account and organization", () => {
    // Same email AND organization = same quota; switching is pure churn.
    const twin = account("same-org", {
      sessionPercent: 0,
      weekPercent: 0,
      weekResetsAt: daysFromNow(1),
    });
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          {
            ...twin,
            homePath: "/Users/someone/.claude-a",
            isCurrent: true,
            usage: { sessionPercent: 70, weekPercent: 80, weekResetsAt: daysFromNow(6) },
          },
          { ...twin, homePath: "/Users/someone/.claude-b" },
        ],
      }),
    ).toBeNull();
  });

  it("never acts on unknown usage, in either direction", () => {
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account("current", undefined, { isCurrent: true }),
          account("fresh", { sessionPercent: 0, weekPercent: 0 }),
        ],
      }),
    ).toBeNull();
    expect(
      chooseClaudeRotationTarget({
        nowMs: NOW,
        profiles: [
          account(
            "current",
            { sessionPercent: 70, weekPercent: 50, weekResetsAt: daysFromNow(6) },
            { isCurrent: true },
          ),
          account("unknown", undefined),
        ],
      }),
    ).toBeNull();
  });

  it("breaks rate ties toward the more open session window", () => {
    const decision = chooseClaudeRotationTarget({
      nowMs: NOW,
      profiles: [
        account(
          "current",
          { sessionPercent: 70, weekPercent: 90, weekResetsAt: daysFromNow(7) },
          { isCurrent: true },
        ),
        account("busy", { sessionPercent: 55, weekPercent: 30, weekResetsAt: daysFromNow(7) }),
        account("open", { sessionPercent: 5, weekPercent: 30, weekResetsAt: daysFromNow(7) }),
      ],
    });
    expect(decision?.to.organizationName).toBe("open");
  });

  it("stores an empty homePath when rotating to the default profile", () => {
    const decision = chooseClaudeRotationTarget({
      nowMs: NOW,
      profiles: [
        account(
          "current",
          { sessionPercent: 70, weekPercent: 90, weekResetsAt: daysFromNow(7) },
          { isCurrent: true },
        ),
        account(
          "home",
          { sessionPercent: 0, weekPercent: 10, weekResetsAt: daysFromNow(1) },
          { isDefaultHome: true },
        ),
      ],
    });
    expect(decision?.homePath).toBe("");
  });
});
