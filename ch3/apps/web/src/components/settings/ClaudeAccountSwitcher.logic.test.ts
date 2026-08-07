import type { ClaudeAccountProfile } from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeProfilePrimaryLabel,
  claudeProfileSecondaryLabel,
  homePathSettingForProfile,
  isSelectableClaudeProfile,
  isSignedInClaudeProfile,
  claudeProfileUsageLabel,
  recommendClaudeAccount,
} from "./ClaudeAccountSwitcher.logic";

// Shapes taken from what the server actually returns on this machine: the
// default home signed in as conrad@baubap.com, and the `.claude-work` folder a
// failed sign-in attempt left behind with no credentials in it.
const defaultProfile: ClaudeAccountProfile = {
  homePath: "/Users/conradws/.claude",
  displayPath: "~/.claude",
  email: "conrad@baubap.com",
  organizationName: "conrad@baubap.com's Organization",
  subscriptionLabel: "Claude Max Subscription",
  isCurrent: true,
  isDefaultHome: true,
};

const workProfile: ClaudeAccountProfile = {
  homePath: "/Users/conradws/.claude-work",
  displayPath: "~/.claude-work",
  isCurrent: false,
  isDefaultHome: false,
};

const signedInWorkProfile: ClaudeAccountProfile = {
  ...workProfile,
  email: "conrad@baubap.com",
  organizationName: "Baubap",
  subscriptionLabel: "Claude Max Subscription",
};

describe("Claude account switching", () => {
  it("stores an empty homePath for the default profile, never its absolute path", () => {
    // The regression this guards: writing "/Users/conradws/.claude" made the
    // CLI look for its config inside that folder instead of beside it, so it
    // created an empty one and reported the signed-in account as not logged in.
    expect(homePathSettingForProfile(defaultProfile)).toBe("");
  });

  it("stores the absolute path for a non-default profile", () => {
    expect(homePathSettingForProfile({ ...workProfile, email: "work@example.com" })).toBe(
      "/Users/conradws/.claude-work",
    );
  });

  it("treats a profile with no recorded account as not signed in", () => {
    expect(isSignedInClaudeProfile(defaultProfile)).toBe(true);
    expect(isSignedInClaudeProfile(workProfile)).toBe(false);
    expect(isSignedInClaudeProfile({ ...workProfile, email: "   " })).toBe(false);
  });

  it("leads each row with the organization, because the emails are identical", () => {
    // Both accounts are the same login. Leading with the email made every row
    // read `conrad@baubap.com`, so the rows were indistinguishable.
    expect(claudeProfilePrimaryLabel(defaultProfile)).toBe("conrad@baubap.com's Organization");
    expect(claudeProfilePrimaryLabel(signedInWorkProfile)).toBe("Baubap");
    expect(claudeProfilePrimaryLabel(defaultProfile)).not.toBe(
      claudeProfilePrimaryLabel(signedInWorkProfile),
    );
  });

  it("never repeats the primary line in the supporting one, and always names the directory", () => {
    expect(claudeProfileSecondaryLabel(signedInWorkProfile)).toBe(
      "conrad@baubap.com · Claude Max Subscription · ~/.claude-work",
    );
    // No organization recorded: the email leads, so it must not repeat below.
    // The key is omitted rather than set to undefined — under
    // exactOptionalPropertyTypes those are different types, and the server
    // omits the key entirely when the CLI config has no organization.
    const { organizationName: _omit, ...noOrganization } = signedInWorkProfile;
    expect(claudeProfilePrimaryLabel(noOrganization)).toBe("conrad@baubap.com");
    expect(claudeProfileSecondaryLabel(noOrganization)).toBe(
      "Claude Max Subscription · ~/.claude-work",
    );
  });

  it("labels an unsigned profile plainly and still names its directory", () => {
    expect(claudeProfilePrimaryLabel(workProfile)).toBe("Not signed in");
    expect(claudeProfileSecondaryLabel(workProfile)).toBe("~/.claude-work");
  });

  it("refuses to switch to a profile that is not signed in", () => {
    // Selecting an empty config directory takes down every thread on the
    // instance, so it must not be offered as a choice at all.
    expect(isSelectableClaudeProfile(workProfile)).toBe(false);
    expect(isSelectableClaudeProfile(defaultProfile)).toBe(true);
  });
});

describe("claudeProfileUsageLabel", () => {
  const base = {
    homePath: "/Users/someone/.claude-work",
    displayPath: "~/.claude-work",
    email: "someone@example.com",
    isCurrent: false,
    isDefaultHome: false,
  };

  it("shows the numbers when usage is readable", () => {
    expect(
      claudeProfileUsageLabel({ ...base, usage: { sessionPercent: 4, weekPercent: 86 } }),
    ).toBe("session 4% · week 86%");
  });

  it("names the session window's reset time when the endpoint supplies it", () => {
    const label = claudeProfileUsageLabel({
      ...base,
      usage: {
        sessionPercent: 100,
        weekPercent: 49,
        sessionResetsAt: "2026-08-06T19:00:00.000Z",
      },
    });
    // The exact rendering is the machine's locale and timezone; the shape is ours.
    expect(label).toMatch(/^session 100% · resets .+ · week 49%$/);
  });

  it("omits the reset clause when the timestamp is absent or unreadable", () => {
    expect(
      claudeProfileUsageLabel({
        ...base,
        usage: { sessionPercent: 4, weekPercent: 86, sessionResetsAt: "not-a-date" },
      }),
    ).toBe("session 4% · week 86%");
  });

  it("names the two knowable failure states and stays silent otherwise", () => {
    expect(claudeProfileUsageLabel({ ...base, usageUnauthorized: true })).toBe(
      "session expired — sign in again",
    );
    expect(claudeProfileUsageLabel({ ...base, usageCredentialMissing: true })).toBe(
      "sign in again to see usage",
    );
    expect(claudeProfileUsageLabel(base)).toBeNull();
  });
});

describe("recommended account", () => {
  const nowMs = Date.parse("2026-08-06T18:00:00.000Z");
  const inDays = (days: number) => new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();

  const current: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claude-work",
    displayPath: "~/.claude-work",
    email: "conrad@baubap.com",
    organizationName: "Baubap",
    isCurrent: true,
    isDefaultHome: false,
    usage: { sessionPercent: 65, weekPercent: 61, weekResetsAt: inDays(2) },
  };

  // 87% of its week left with a reset a day out: far more expiring allowance
  // per day than the incumbent's 39% spread over two days.
  const expiringSoon: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claudio-aurelio",
    displayPath: "~/.claudio-aurelio",
    email: "claudio.aurelio@baubap.com",
    organizationName: "claudio.aurelio@baubap.com's Organization",
    isCurrent: false,
    isDefaultHome: false,
    usage: { sessionPercent: 0, weekPercent: 13, weekResetsAt: inDays(1) },
  };

  it("names the account with the most weekly allowance about to expire", () => {
    const recommendation = recommendClaudeAccount({
      profiles: [current, expiringSoon],
      nowMs,
    });
    expect(recommendation?.homePath).toBe("/Users/conradws/.claudio-aurelio");
    expect(recommendation?.isCurrent).toBe(false);
    expect(recommendation?.detail).toContain("%/day");
  });

  it("points at the account in use when nothing beats it by enough to switch", () => {
    const recommendation = recommendClaudeAccount({
      profiles: [current, { ...expiringSoon, usage: { sessionPercent: 0, weekPercent: 61, weekResetsAt: inDays(2) } }],
      nowMs,
    });
    expect(recommendation?.homePath).toBe(current.homePath);
    expect(recommendation?.isCurrent).toBe(true);
    expect(recommendation?.detail).toContain("Baubap");
  });

  it("ignores stickiness, so a fresh session does not make the incumbent look ideal", () => {
    // With `steady` phase this returns null (session under 60%) and the panel
    // would call the incumbent ideal purely because its window just opened.
    const fresh = { ...current, usage: { sessionPercent: 2, weekPercent: 61, weekResetsAt: inDays(2) } };
    const recommendation = recommendClaudeAccount({ profiles: [fresh, expiringSoon], nowMs });
    expect(recommendation?.homePath).toBe(expiringSoon.homePath);
  });

  it("refuses to guess when the account in use has no usage read", () => {
    // Absent, not zeroed: `exactOptionalPropertyTypes` forbids the explicit
    // undefined, and the distinction is the point — unknown usage must not be
    // read as an empty account.
    const unknown: ClaudeAccountProfile = {
      homePath: current.homePath,
      displayPath: current.displayPath,
      email: "conrad@baubap.com",
      organizationName: "Baubap",
      isCurrent: true,
      isDefaultHome: false,
    };
    expect(recommendClaudeAccount({ profiles: [unknown, expiringSoon], nowMs })).toBeNull();
  });
});

describe("recommended account — incumbent about to stall", () => {
  // The live state that exposed the bug: the account in use held the most
  // expiring weekly allowance (24%/day vs 14%/day) and so read as "already
  // ideal", while its 5-hour window sat at 91% — past the 85% escape, meaning
  // the rotation reactor was about to rest it. The highlight and the reactor
  // disagreed, which is precisely what this button exists to rule out.
  const nowMs = Date.parse("2026-08-06T23:30:00.000Z");

  const exhaustingSession: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claude-work",
    displayPath: "~/.claude-work",
    email: "conrad@baubap.com",
    organizationName: "Baubap",
    isCurrent: true,
    isDefaultHome: false,
    usage: { sessionPercent: 91, weekPercent: 64, weekResetsAt: "2026-08-08T12:00:00.000Z" },
  };

  const rested: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claudio-aurelio",
    displayPath: "~/.claudio-aurelio",
    email: "claudio.aurelio@baubap.com",
    organizationName: "claudio.aurelio@baubap.com's Organization",
    isCurrent: false,
    isDefaultHome: false,
    usage: { sessionPercent: 0, weekPercent: 13, weekResetsAt: "2026-08-13T06:00:00.000Z" },
  };

  it("hands the seat on when the account in use is minutes from refusing turns", () => {
    const recommendation = recommendClaudeAccount({
      profiles: [exhaustingSession, rested],
      nowMs,
    });
    expect(recommendation?.homePath).toBe("/Users/conradws/.claudio-aurelio");
    expect(recommendation?.isCurrent).toBe(false);
  });

  it("keeps the seat when the same account still has session room", () => {
    // Identical weekly arithmetic, session well under the escape: the extra
    // expiring allowance now wins, so the answer flips back.
    const recommendation = recommendClaudeAccount({
      profiles: [
        {
          ...exhaustingSession,
          usage: { sessionPercent: 20, weekPercent: 64, weekResetsAt: "2026-08-08T12:00:00.000Z" },
        },
        rested,
      ],
      nowMs,
    });
    expect(recommendation?.homePath).toBe("/Users/conradws/.claude-work");
    expect(recommendation?.isCurrent).toBe(true);
  });
});
