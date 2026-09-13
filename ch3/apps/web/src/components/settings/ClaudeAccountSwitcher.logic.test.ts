import type { ClaudeAccountProfile } from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeProfilePrimaryLabel,
  collapseClaudeProfilesByAccount,
  isVisibleClaudeAccountRow,
  sortClaudeAccountRows,
  visibleClaudeAccountRows,
  claudeProfileSecondaryLabel,
  homePathSettingForProfile,
  accountToSwitchToAfterSignIn,
  claudeUsagePauseNotice,
  isSelectableClaudeProfile,
  isSignedInClaudeProfile,
  claudeProfileUsageLabel,
  recommendClaudeAccount,
  suggestClaudeAccountFolder,
  isAgentRunBlockingSwitch,
  manualClaudeSwitchStoppedRunNotice,
} from "./ClaudeAccountSwitcher.logic";

// Shapes taken from what the server actually returns on this machine: the
// default home signed in as conrad@example.com, and the `.claude-work` folder a
// failed sign-in attempt left behind with no credentials in it.
const defaultProfile: ClaudeAccountProfile = {
  homePath: "/Users/conradws/.claude",
  displayPath: "~/.claude",
  email: "conrad@example.com",
  organizationName: "conrad@example.com's Organization",
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
  email: "conrad@example.com",
  organizationName: "CH3",
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

  it("leads every row with the address, and nothing else", () => {
    // The organization used to lead, which made two rows for the same login
    // read as two different things and three rows for ONE account read as
    // three. The address is the account; the folder is CH3's business.
    expect(claudeProfilePrimaryLabel(defaultProfile)).toBe("conrad@example.com");
    expect(claudeProfilePrimaryLabel(signedInWorkProfile)).toBe("conrad@example.com");
  });

  it("says signed in and the plan, and never the directory", () => {
    expect(claudeProfileSecondaryLabel(signedInWorkProfile)).toBe(
      "Signed in · Claude Max Subscription",
    );
    expect(claudeProfileSecondaryLabel(signedInWorkProfile)).not.toContain("~/");
    // The key is omitted rather than set to undefined — under
    // exactOptionalPropertyTypes those are different types, and the server
    // omits the key entirely when the CLI config has no organization.
    const { organizationName: _omit, ...noOrganization } = signedInWorkProfile;
    expect(claudeProfilePrimaryLabel(noOrganization)).toBe("conrad@example.com");
  });

  it("labels an unsigned profile by the only name it has", () => {
    // Nothing signed in and nothing on the roster: the directory is the only
    // identity it has, so it is the one case the path still shows.
    expect(claudeProfilePrimaryLabel(workProfile)).toBe("~/.claude-work");
    expect(claudeProfileSecondaryLabel(workProfile)).toBe("Not signed in");
  });

  it("switches to an account the moment its sign-in completes, unless it cannot be used", () => {
    // The re-probe after a sign-in reports `isCurrent: false` whatever the
    // selection is, so the comparison is against the stored setting.
    const signedIn = { ...workProfile, email: "someone@example.com" };
    expect(accountToSwitchToAfterSignIn(signedIn, "")).toBe(workProfile.homePath);
    expect(accountToSwitchToAfterSignIn(signedIn, "/Users/x/.claude")).toBe(workProfile.homePath);
    // Already the account in use: nothing to switch.
    expect(accountToSwitchToAfterSignIn(signedIn, workProfile.homePath)).toBeNull();
    // The default home is stored as the empty setting, and compared as such.
    expect(
      accountToSwitchToAfterSignIn({ ...defaultProfile, email: "a@example.com" }, ""),
    ).toBeNull();
    // A sign-in that did not land leaves the selection alone.
    expect(accountToSwitchToAfterSignIn(workProfile, "")).toBeNull();
    // Never mid-reply: a live agent run anywhere in the environment holds it.
    expect(accountToSwitchToAfterSignIn(signedIn, "", true)).toBeNull();
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

  it("names the weekly window's reset, with its date, when the endpoint supplies it", () => {
    // The weekly window is days out, so the date is the useful half: a week at
    // 97% clearing tonight and one clearing on Friday are different answers to
    // "can this account carry the run?".
    const label = claudeProfileUsageLabel({
      ...base,
      usage: {
        sessionPercent: 2,
        weekPercent: 34,
        sessionResetsAt: "2026-08-06T19:00:00.000Z",
        weekResetsAt: "2026-08-19T23:59:00.000Z",
      },
    });
    expect(label).toMatch(/^session 2% · resets .+ · week 34% · resets .+$/);
    // Days out means the day is named, not just a bare wall-clock time.
    expect(label).toMatch(/week 34% · resets [A-Za-z]{3} \d{1,2} /);
  });

  it("omits the reset clause when the timestamp is absent or unreadable", () => {
    expect(
      claudeProfileUsageLabel({
        ...base,
        usage: { sessionPercent: 4, weekPercent: 86, sessionResetsAt: "not-a-date" },
      }),
    ).toBe("session 4% · week 86%");
  });

  it("names the week window's reset date and time when the endpoint supplies it", () => {
    // Date, not just time: unlike the session window (always today), the week
    // window resets days out, so a bare time would not say which day.
    const label = claudeProfileUsageLabel({
      ...base,
      usage: {
        sessionPercent: 10,
        weekPercent: 97,
        weekResetsAt: "2026-08-16T20:00:00.000Z",
      },
    });
    // The exact rendering is the machine's locale and timezone; the shape is ours.
    expect(label).toMatch(/^session 10% · week 97% · resets \w+ \d+ .+$/);
  });

  it("names both windows' resets together when both are supplied", () => {
    const label = claudeProfileUsageLabel({
      ...base,
      usage: {
        sessionPercent: 26,
        weekPercent: 3,
        sessionResetsAt: "2026-08-06T19:00:00.000Z",
        weekResetsAt: "2026-08-16T20:00:00.000Z",
      },
    });
    expect(label).toMatch(/^session 26% · resets .+ · week 3% · resets \w+ \d+ .+$/);
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

  it("says when a row is blank because the read was rate limited", () => {
    // Blank rows are how three healthy accounts looked while the app refused
    // to leave an exhausted one — the reader had no way to tell "no data" from
    // "no room".
    const base: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claudio-cero",
      displayPath: "~/.claudio-cero",
      email: "claudio.cero@example.com",
      isCurrent: false,
      isDefaultHome: false,
    };
    expect(claudeProfileUsageLabel({ ...base, usageRateLimited: true })).toBe(
      "usage not read yet — the endpoint is limiting reads of this account",
    );
  });

  it("names the moment reads resume when the endpoint said so", () => {
    expect(
      claudeProfileUsageLabel({
        ...workProfile,
        email: "claudio.uno@example.com",
        usageRateLimited: true,
        usageRetryAt: "2026-09-02T04:33:00.000Z",
      }),
    ).toMatch(/^usage not read yet — the endpoint is limiting this account; next read /);
  });

  it("says once, for the panel, which accounts the endpoint is limiting and that it is per account", () => {
    expect(claudeUsagePauseNotice([defaultProfile, workProfile])).toBeNull();
    const notice = claudeUsagePauseNotice([
      {
        ...defaultProfile,
        usage: { sessionPercent: 32, weekPercent: 9 },
        usageStale: true,
        usageRateLimited: true,
        usageRetryAt: "2026-09-02T04:33:00.000Z",
      },
      {
        ...workProfile,
        email: "claudio.uno@example.com",
        usageRateLimited: true,
        usageRetryAt: "2026-09-02T04:20:00.000Z",
      },
    ]);
    expect(notice).toMatch(/^The usage endpoint is limiting reads of 2 of these accounts\. /);
    expect(notice).toMatch(/per account and shared by every machine signed in as it/);
    expect(notice).toMatch(/Its numbers are the last ones read, dated\.$/);
  });

  it("marks a cached reading as cached", () => {
    const cached: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claudio-cero",
      displayPath: "~/.claudio-cero",
      email: "claudio.cero@example.com",
      isCurrent: false,
      isDefaultHome: false,
      usage: { sessionPercent: 12, weekPercent: 66 },
      usageStale: true,
    };
    expect(claudeProfileUsageLabel(cached)).toBe("session 12% · week 66% · cached");
  });

  it("dates a cached reading whenever the server stamped it", () => {
    // The rate-limited case: the endpoint refused the read, these are the last
    // numbers there are, and the age is the only thing that says whether they
    // are worth acting on. "cached" alone left an hour-old reading looking the
    // same as a one-minute-old one.
    const readAt = new Date(Date.now() - 12 * 60_000).toISOString();
    const dated: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claudio-cero",
      displayPath: "~/.claudio-cero",
      email: "claudio.cero@example.com",
      isCurrent: false,
      isDefaultHome: false,
      usage: { sessionPercent: 12, weekPercent: 66, readAt },
      usageStale: true,
      usageRateLimited: true,
    };
    expect(claudeProfileUsageLabel(dated)).toBe("session 12% · week 66% · (read 12m ago)");
  });

  it("keeps each age beside the numbers it dates when Fable is older than the pair", () => {
    // The busy-account state: the CLI's event stream refreshed session and week
    // seconds ago, the per-model figure is from a poll 22 minutes back, and the
    // poll is paused by a 429 until 10:43. Rendered as two anonymous "(read …)"
    // notes at the end of the line — "read 22m ago" then "read just now" — the
    // row read as a contradiction. The pair's age follows the week, and the
    // Fable age carries the next poll with it, because the poll is what
    // refreshes Fable and nothing else.
    const nowMs = Date.now();
    const usageRetryAt = new Date(nowMs + 20 * 60_000).toISOString();
    const split: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claude-4",
      displayPath: "~/.claude-4",
      rosterEmail: "claudio.cuatro@example.com",
      email: "claudio.cuatro@example.com",
      isCurrent: true,
      isDefaultHome: false,
      usage: {
        sessionPercent: 68,
        weekPercent: 48,
        modelWeekPercent: 45,
        readAt: new Date(nowMs - 10_000).toISOString(),
        modelWeekReadAt: new Date(nowMs - 22 * 60_000).toISOString(),
      },
      usageStale: true,
      usageRateLimited: true,
      usageRetryAt,
    };
    const label = claudeProfileUsageLabel(split) ?? "";
    expect(label).toMatch(
      /^session 68% · week 48% \(read just now\) · Fable 45% \(read 22m ago · next read .+\)$/,
    );
    // One age per group and nothing dangling after the Fable group.
    expect(label.match(/\(read /g)).toHaveLength(2);
    expect(label.endsWith(")")).toBe(true);
  });

  describe("isAgentRunBlockingSwitch", () => {
    // The machine this was found on: one Claude thread idle, several other
    // agents mid-run on other providers all afternoon. Every sign-in ended in
    // "an agent is working, so this provider was not switched", and the
    // exhausted account stayed selected until a restart killed every run.
    const claude = "claudeAgent" as never;
    const codex = "codex" as never;
    const running = (providerInstanceId: unknown) =>
      ({
        session: { status: "running", providerInstanceId },
        latestTurn: null,
        kanban: null,
      }) as never;

    it("waits for a run on the instance being switched", () => {
      expect(isAgentRunBlockingSwitch(running(claude), claude)).toBe(true);
    });

    it("does not wait for a run on a different instance", () => {
      // A Codex reply is not interrupted by repointing the Claude instance at
      // another account, so it has no say in the switch.
      expect(isAgentRunBlockingSwitch(running(codex), claude)).toBe(false);
    });

    it("waits for a run that names no instance, which could be anywhere", () => {
      expect(isAgentRunBlockingSwitch(running(undefined), claude)).toBe(true);
    });

    it("never waits for a thread that is not running at all", () => {
      const idle = {
        session: { status: "idle", providerInstanceId: claude },
        latestTurn: { state: "completed" },
        kanban: null,
      } as never;
      expect(isAgentRunBlockingSwitch(idle, claude)).toBe(false);
    });
  });

  describe("manualClaudeSwitchStoppedRunNotice", () => {
    // A manual row click still switches even when `agentRunActive` is true —
    // it never becomes a silent refusal — but the rebuild takes this
    // provider's sessions with it, and the toast has to say that happened,
    // not just that a new account is in use.
    it("names the stopped reply and the account now in use", () => {
      const message = manualClaudeSwitchStoppedRunNotice("conrad@example.com");
      expect(message).toContain("stopped any reply");
      expect(message).toContain("conrad@example.com");
    });
  });

  it("says nothing about age for a reading that is current", () => {
    const fresh: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claude",
      displayPath: "~/.claude",
      email: "conrad@example.com",
      isCurrent: true,
      isDefaultHome: true,
      usage: { sessionPercent: 12, weekPercent: 66, readAt: new Date().toISOString() },
    };
    expect(claudeProfileUsageLabel(fresh)).toBe("session 12% · week 66%");
  });
});

describe("recommended account", () => {
  const nowMs = Date.parse("2026-08-06T18:00:00.000Z");
  const inDays = (days: number) => new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();

  const current: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claude-work",
    displayPath: "~/.claude-work",
    email: "conrad@example.com",
    organizationName: "CH3",
    isCurrent: true,
    isDefaultHome: false,
    usage: { sessionPercent: 65, weekPercent: 61, weekResetsAt: inDays(2) },
  };

  // 87% of its week left with a reset a day out: far more expiring allowance
  // per day than the incumbent's 39% spread over two days.
  const expiringSoon: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claudio-cero",
    displayPath: "~/.claudio-cero",
    email: "claudio.cero@example.com",
    organizationName: "claudio.cero@example.com's Organization",
    isCurrent: false,
    isDefaultHome: false,
    usage: { sessionPercent: 0, weekPercent: 13, weekResetsAt: inDays(1) },
  };

  it("names the account with the most weekly allowance about to expire", () => {
    const recommendation = recommendClaudeAccount({
      profiles: [current, expiringSoon],
      nowMs,
    });
    expect(recommendation?.homePath).toBe("/Users/conradws/.claudio-cero");
    expect(recommendation?.isCurrent).toBe(false);
    expect(recommendation?.detail).toContain("%/day");
  });

  it("points at the account in use when nothing beats it by enough to switch", () => {
    const recommendation = recommendClaudeAccount({
      profiles: [
        current,
        { ...expiringSoon, usage: { sessionPercent: 0, weekPercent: 61, weekResetsAt: inDays(2) } },
      ],
      nowMs,
    });
    expect(recommendation?.homePath).toBe(current.homePath);
    expect(recommendation?.isCurrent).toBe(true);
    expect(recommendation?.detail).toContain("conrad@example.com");
  });

  it("ignores stickiness, so a fresh session does not make the incumbent look ideal", () => {
    // With `steady` phase this returns null (session under 60%) and the panel
    // would call the incumbent ideal purely because its window just opened.
    const fresh = {
      ...current,
      usage: { sessionPercent: 2, weekPercent: 61, weekResetsAt: inDays(2) },
    };
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
      email: "conrad@example.com",
      organizationName: "CH3",
      isCurrent: true,
      isDefaultHome: false,
    };
    expect(recommendClaudeAccount({ profiles: [unknown, expiringSoon], nowMs })).toBeNull();
  });

  it("never claims a comparison it could not make", () => {
    // The live failure, 2026-08-10: the account in use sat at 100% of its
    // 5-hour window, every rival's usage read came back 429, and the panel
    // answered "no other account beats that by enough to be worth a switch" —
    // a verdict on accounts it had no number for. `~/.claudio-cero` was at
    // 12% at that moment.
    const exhausted: ClaudeAccountProfile = {
      ...current,
      usage: { sessionPercent: 100, weekPercent: 36, weekResetsAt: inDays(6) },
    };
    const unreadable: ClaudeAccountProfile = {
      homePath: "/Users/conradws/.claudio-cero",
      displayPath: "~/.claudio-cero",
      email: "claudio.cero@example.com",
      organizationName: "claudio.cero@example.com's Organization",
      isCurrent: false,
      isDefaultHome: false,
      usageRateLimited: true,
    };
    const recommendation = recommendClaudeAccount({
      profiles: [exhausted, unreadable],
      nowMs,
    });
    expect(recommendation?.isCurrent).toBe(true);
    expect(recommendation?.detail).toContain("No other account's usage could be read");
    expect(recommendation?.detail).toContain("rate limiting");
    expect(recommendation?.detail).not.toContain("beats that by enough");
  });

  it("still compares when a rival's number is merely cached", () => {
    // Stale is evidence; absent is not. A cached reading must keep driving the
    // recommendation, or a rate-limited fleet is paralysed exactly as before.
    const exhausted: ClaudeAccountProfile = {
      ...current,
      usage: { sessionPercent: 100, weekPercent: 36, weekResetsAt: inDays(6) },
    };
    const recommendation = recommendClaudeAccount({
      profiles: [exhausted, { ...expiringSoon, usageStale: true }],
      nowMs,
    });
    expect(recommendation?.homePath).toBe(expiringSoon.homePath);
    expect(recommendation?.isCurrent).toBe(false);
  });
});

describe("recommended account — incumbent about to stall", () => {
  // The live state that exposed the bug: the account in use held the most
  // expiring weekly allowance (24%/day vs 14%/day) and so read as "already
  // ideal", while its 5-hour window was past the session escape, meaning the
  // rotation reactor was about to rest it. The highlight and the reactor
  // disagreed, which is precisely what this button exists to rule out.
  //
  // The escape sits at ROTATION_SESSION_ESCAPE_PERCENT (99), not the 85 this
  // block was first written against — between 60 and 99 the margin rules
  // already run every two minutes, and above 98 failover takes over. The
  // fixtures below track that constant.
  const nowMs = Date.parse("2026-08-06T23:30:00.000Z");

  const exhaustingSession: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claude-work",
    displayPath: "~/.claude-work",
    email: "conrad@example.com",
    organizationName: "CH3",
    isCurrent: true,
    isDefaultHome: false,
    usage: { sessionPercent: 99, weekPercent: 64, weekResetsAt: "2026-08-08T12:00:00.000Z" },
  };

  const rested: ClaudeAccountProfile = {
    homePath: "/Users/conradws/.claudio-cero",
    displayPath: "~/.claudio-cero",
    email: "claudio.cero@example.com",
    organizationName: "claudio.cero@example.com's Organization",
    isCurrent: false,
    isDefaultHome: false,
    usage: { sessionPercent: 0, weekPercent: 13, weekResetsAt: "2026-08-13T06:00:00.000Z" },
  };

  it("hands the seat on when the account in use is minutes from refusing turns", () => {
    const recommendation = recommendClaudeAccount({
      profiles: [exhaustingSession, rested],
      nowMs,
    });
    expect(recommendation?.homePath).toBe("/Users/conradws/.claudio-cero");
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

  it("keeps the seat at 91% — the documented trade, not an oversight", () => {
    // Between the stickiness threshold and the escape, an incumbent holding
    // the most expiring allowance keeps spending it; failover owns it from 98%.
    // Pinned so a future reading of "91% should have switched" has to change
    // the constant deliberately rather than by accident.
    const recommendation = recommendClaudeAccount({
      profiles: [
        {
          ...exhaustingSession,
          usage: { sessionPercent: 91, weekPercent: 64, weekResetsAt: "2026-08-08T12:00:00.000Z" },
        },
        rested,
      ],
      nowMs,
    });
    expect(recommendation?.isCurrent).toBe(true);
  });
});

const numberedProfile = (index: number): ClaudeAccountProfile => ({
  homePath: `/Users/conradws/.claude-${index}`,
  displayPath: `~/.claude-${index}`,
  email: `account-${index}@example.com`,
  isCurrent: false,
  isDefaultHome: false,
});

describe("suggesting a folder for a new Claude account", () => {
  it("suggests .claude-2 beside a lone default home", () => {
    expect(suggestClaudeAccountFolder([defaultProfile])).toBe("~/.claude-2");
  });

  it("counts past folders already taken instead of offering an occupied one", () => {
    // The regression: the button offered the literal `~/.claude-2` every time.
    // The server creates the folder only when missing and reuses an existing
    // one, so the third sign-in landed in the second account's config
    // directory and overwrote its credentials with no warning.
    expect(suggestClaudeAccountFolder([defaultProfile, numberedProfile(2)])).toBe("~/.claude-3");
    expect(
      suggestClaudeAccountFolder([defaultProfile, numberedProfile(2), numberedProfile(3)]),
    ).toBe("~/.claude-4");
  });

  it("fills the gap a deleted folder left rather than climbing forever", () => {
    // Discovery lists a `~/.claude-*` folder whether or not it holds
    // credentials, so a number missing from this list is a folder missing
    // from disk — safe to hand out, and it keeps the names tidy.
    expect(
      suggestClaudeAccountFolder([defaultProfile, numberedProfile(2), numberedProfile(4)]),
    ).toBe("~/.claude-3");
  });

  it("ignores folders the user named themselves", () => {
    // `~/.claude-work` is a real profile but occupies no number, and the
    // suggestion must not skip a number on its account.
    expect(suggestClaudeAccountFolder([defaultProfile, signedInWorkProfile])).toBe("~/.claude-2");
  });

  it("reads the number off the path, not the display form", () => {
    // A Windows host never produces a `~/…` displayPath, so a suggestion that
    // matched on it would count nothing and collide on every press.
    expect(
      suggestClaudeAccountFolder([
        {
          homePath: "C:\\Users\\conradws\\.claude-2",
          displayPath: "C:\\Users\\conradws\\.claude-2",
          email: "work@example.com",
          isCurrent: false,
          isDefaultHome: false,
        },
      ]),
    ).toBe("~/.claude-3");
  });

  it("falls back to the fixed suggestion when the list never loaded", () => {
    // Nothing to count against. Inventing a number here would be a guess
    // dressed as an answer; the field stays editable either way.
    expect(suggestClaudeAccountFolder(null)).toBe("~/.claude-2");
    expect(suggestClaudeAccountFolder([])).toBe("~/.claude-2");
  });
});

describe("collapseClaudeProfilesByAccount", () => {
  const slot = (suffix: string, email?: string) => ({
    homePath: `/Users/x/.claude-${suffix}`,
    displayPath: `~/.claude-${suffix}`,
    isCurrent: false,
    isDefaultHome: false,
    ...(email === undefined ? {} : { email }),
  });

  it("shows one account once, however many directories hold it", () => {
    // The incident verbatim: the cookie-jar bug signed claudio.cuatro into three
    // folders and the panel showed three identical rows.
    const rows = collapseClaudeProfilesByAccount([
      slot("#0", "claudio.cuatro@example.com"),
      slot("2", "claudio.cuatro@example.com"),
      slot("3", "claudio.cuatro@example.com"),
      slot("uno", "claudio.uno@example.com"),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.profile.email).toBe("claudio.cuatro@example.com");
    // Every directory is kept on the row, so signing out reaches all of them
    // instead of leaving siblings behind to resurrect the account.
    expect(rows[0]?.homePaths).toHaveLength(3);
    expect(rows[1]?.homePaths).toHaveLength(1);
  });

  it("is case-insensitive about the address, as the provider is", () => {
    const rows = collapseClaudeProfilesByAccount([
      slot("2", "Claudio.Cuatro@example.com"),
      slot("3", "claudio.cuatro@example.com"),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("represents the account with the directory in use, listing it first", () => {
    const rows = collapseClaudeProfilesByAccount([
      slot("#0", "claudio.cuatro@example.com"),
      { ...slot("3", "claudio.cuatro@example.com"), isCurrent: true },
    ]);
    expect(rows[0]?.profile.displayPath).toBe("~/.claude-3");
    expect(rows[0]?.homePaths[0]).toBe("/Users/x/.claude-3");
  });

  it("keeps empty directories apart, because two invitations are not one account", () => {
    // Nothing signed in means no identity to collapse on. Folding these
    // together would hide a slot somebody still has to sign into.
    const rows = collapseClaudeProfilesByAccount([slot("5"), slot("6")]);
    expect(rows).toHaveLength(2);
  });
});

describe("sortClaudeAccountRows", () => {
  const row = (input: {
    readonly suffix: string;
    readonly email?: string;
    readonly createdAt?: string;
  }) => ({
    profile: {
      homePath: `/Users/x/.claude-${input.suffix}`,
      displayPath: `~/.claude-${input.suffix}`,
      isCurrent: false,
      isDefaultHome: false,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
    homePaths: [`/Users/x/.claude-${input.suffix}`],
  });

  const emails = (rows: ReturnType<typeof sortClaudeAccountRows>) =>
    rows.map((entry) => entry.profile.email ?? entry.profile.displayPath);

  it("leads with the accounts added first, oldest before newest", () => {
    const sorted = sortClaudeAccountRows([
      row({ suffix: "work", email: "conrad@example.com", createdAt: "2026-03-02T00:00:00Z" }),
      row({ suffix: "personal", email: "someone@example.com", createdAt: "2026-01-05T00:00:00Z" }),
    ]);

    expect(emails(sorted)).toEqual(["someone@example.com", "conrad@example.com"]);
  });

  it("places a row with no creation time after the ones that have it", () => {
    // An unknown time is not the oldest time. Sorting it first would put a
    // directory nothing can date at the top of the list every render.
    const sorted = sortClaudeAccountRows([
      row({ suffix: "undated", email: "b@example.com" }),
      row({ suffix: "dated", email: "a@example.com", createdAt: "2026-01-05T00:00:00Z" }),
    ]);
    expect(emails(sorted)).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("visibleClaudeAccountRows", () => {
  const row = (input: {
    readonly suffix: string;
    readonly email?: string;
    readonly isCurrent?: boolean;
    readonly isDefaultHome?: boolean;
  }) => ({
    profile: {
      homePath: `/Users/x/.claude-${input.suffix}`,
      displayPath: `~/.claude-${input.suffix}`,
      isCurrent: input.isCurrent ?? false,
      isDefaultHome: input.isDefaultHome ?? false,
      ...(input.email === undefined ? {} : { email: input.email }),
    },
    homePaths: [`/Users/x/.claude-${input.suffix}`],
  });

  const paths = (rows: ReturnType<typeof visibleClaudeAccountRows>) =>
    rows.map((entry) => entry.profile.displayPath);

  it("drops a signed-out folder nobody is expected to sign into", () => {
    // The residue of a sign-out or an abandoned sign-in. It accumulates, and
    // every one of those rows reads "Not signed in" against a directory name.
    expect(
      paths(
        visibleClaudeAccountRows([
          row({ suffix: "work", email: "conrad@example.com" }),
          row({ suffix: "leftover" }),
        ]),
      ),
    ).toEqual(["~/.claude-work"]);
  });

  it("keeps the current profile and the default home whatever state they are in", () => {
    // Hiding either takes away the only control that reaches it.
    expect(
      paths(
        visibleClaudeAccountRows([
          row({ suffix: "current", isCurrent: true }),
          row({ suffix: "home", isDefaultHome: true }),
          row({ suffix: "leftover" }),
        ]),
      ),
    ).toEqual(["~/.claude-current", "~/.claude-home"]);
  });

  it("takes the row away at the moment of sign-out, which is what makes a ghost", () => {
    // Sign-out re-probes the directory and writes the result back in place, so
    // the row that was an account becomes a row that is a folder. That is the
    // transition the filter exists for: it happens while the panel is open,
    // not only on the next load.
    const signedIn = row({ suffix: "work", email: "someone@example.com" }).profile;
    const signedOut = row({ suffix: "work" }).profile;

    expect(isVisibleClaudeAccountRow(signedIn)).toBe(true);
    expect(isVisibleClaudeAccountRow(signedOut)).toBe(false);
  });

  it("keeps every signed-in account, on the roster or not", () => {
    expect(
      paths(
        visibleClaudeAccountRows([
          row({ suffix: "1", email: "claudio.uno@example.com" }),
          row({ suffix: "personal", email: "someone@example.com" }),
        ]),
      ),
    ).toEqual(["~/.claude-1", "~/.claude-personal"]);
  });
});
