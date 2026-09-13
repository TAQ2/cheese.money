import type { ClaudeAccountProfile } from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseRiddleTarget,
  isRiddleEligible,
  parseRiddleReply,
  retiredRiddleHomePaths,
  RIDDLE_PROMPT,
} from "./claudeAccountRiddle.ts";

function makeProfile(
  input: Omit<Partial<ClaudeAccountProfile>, "email"> & {
    readonly homePath: string;
    /** Explicitly `undefined` means signed out — the key is then omitted,
        which is how the contract represents it under exactOptionalPropertyTypes. */
    readonly email?: string | undefined;
  },
): ClaudeAccountProfile {
  const { email, ...rest } = input;
  const resolvedEmail = "email" in input ? email : "someone@example.com";
  return {
    displayPath: `~/${input.homePath}`,
    isCurrent: false,
    isDefaultHome: false,
    ...rest,
    ...(resolvedEmail === undefined ? {} : { email: resolvedEmail }),
  } as ClaudeAccountProfile;
}

describe("parseRiddleReply", () => {
  it("pulls the riddle and answer out of the asked-for shape", () => {
    const parsed = parseRiddleReply("Riddle: What has keys but opens nothing?\nAnswer: A piano.");
    expect(parsed).toEqual({
      riddle: "What has keys but opens nothing?",
      answer: "A piano.",
    });
  });

  it("tolerates surrounding whitespace and casing drift", () => {
    const parsed = parseRiddleReply(
      "\n\n  riddle:   I hum but never sing.  \n  ANSWER:  A fridge.\n",
    );
    expect(parsed).toEqual({ riddle: "I hum but never sing.", answer: "A fridge." });
  });

  it("returns null rather than half-parsing a reply missing a label", () => {
    // The raw reply is stored regardless, so null loses nothing — whereas a
    // half-filled row would poison the log this loop exists to produce.
    expect(parseRiddleReply("Riddle: no answer came back")).toBeNull();
    expect(parseRiddleReply("Answer: a lone answer")).toBeNull();
    expect(parseRiddleReply("Riddle:\nAnswer:")).toBeNull();
    expect(parseRiddleReply("I'd rather not, sorry.")).toBeNull();
  });

  it("asks for a fresh riddle in a parseable two-line shape", () => {
    expect(RIDDLE_PROMPT).toContain("Riddle:");
    expect(RIDDLE_PROMPT).toContain("Answer:");
    expect(RIDDLE_PROMPT).toContain("not a well-known classic riddle");
  });
});

describe("isRiddleEligible", () => {
  it("never asks the selected account", () => {
    // Real work already keeps its window turning; a riddle there spends quota
    // to achieve what is happening anyway.
    expect(isRiddleEligible(makeProfile({ homePath: "a", isCurrent: true }))).toBe(false);
  });

  it("skips a signed-out profile, which has nothing to keep warm", () => {
    expect(isRiddleEligible(makeProfile({ homePath: "a", email: undefined }))).toBe(false);
  });

  it("ignores usage flags, which this loop never populates", () => {
    // The reactor lists profiles WITHOUT includeUsage on purpose — a usage
    // probe reads the login keychain. So these flags are always undefined in
    // production, and gating on them would be a guard that cannot fire.
    // Retirement is decided from the riddle log instead.
    expect(isRiddleEligible(makeProfile({ homePath: "a", usageUnauthorized: true }))).toBe(true);
    expect(isRiddleEligible(makeProfile({ homePath: "a", usageRateLimited: true }))).toBe(true);
  });

  it("skips an account retired for failing every time", () => {
    expect(isRiddleEligible(makeProfile({ homePath: "dead" }), new Set(["dead"]))).toBe(false);
    expect(isRiddleEligible(makeProfile({ homePath: "alive" }), new Set(["dead"]))).toBe(true);
  });

  it("asks a signed-in account that is simply not selected", () => {
    expect(isRiddleEligible(makeProfile({ homePath: "a" }))).toBe(true);
  });
});

describe("retiredRiddleHomePaths", () => {
  const failed = (accountHomePath: string) => ({ accountHomePath, status: "failed" });
  const answered = (accountHomePath: string) => ({ accountHomePath, status: "answered" });

  it("retires an account only after the limit of consecutive failures", () => {
    expect([...retiredRiddleHomePaths([failed("a"), failed("a")])]).toEqual([]);
    expect([...retiredRiddleHomePaths([failed("a"), failed("a"), failed("a")])]).toEqual(["a"]);
  });

  it("lets one success clear the count, so a re-signed-in account comes back", () => {
    // Rows are newest first, so the success is the most recent event.
    expect([
      ...retiredRiddleHomePaths([answered("a"), failed("a"), failed("a"), failed("a")]),
    ]).toEqual([]);
  });

  it("counts only the unbroken run at the head of each account's history", () => {
    // Older failures below a success must not accumulate into a retirement.
    expect([
      ...retiredRiddleHomePaths([failed("a"), failed("a"), answered("a"), failed("a")]),
    ]).toEqual([]);
  });

  it("tracks accounts independently", () => {
    const retired = retiredRiddleHomePaths([
      failed("dead"),
      answered("alive"),
      failed("dead"),
      failed("alive"),
      failed("dead"),
      failed("alive"),
    ]);
    expect([...retired]).toEqual(["dead"]);
  });

  it("retires nobody from an empty log", () => {
    expect([...retiredRiddleHomePaths([])]).toEqual([]);
  });
});

describe("chooseRiddleTarget", () => {
  it("returns undefined when nothing qualifies", () => {
    expect(
      chooseRiddleTarget({
        profiles: [makeProfile({ homePath: "a", isCurrent: true })],
        lastAskedByHomePath: new Map(),
      }),
    ).toBeUndefined();
    expect(chooseRiddleTarget({ profiles: [], lastAskedByHomePath: new Map() })).toBeUndefined();
  });

  it("prefers an account that has never been asked", () => {
    const target = chooseRiddleTarget({
      profiles: [makeProfile({ homePath: "asked" }), makeProfile({ homePath: "never" })],
      lastAskedByHomePath: new Map([["asked", "2026-08-16T12:00:00.000Z"]]),
    });
    expect(target?.homePath).toBe("never");
  });

  it("otherwise takes the account asked longest ago", () => {
    const target = chooseRiddleTarget({
      profiles: [
        makeProfile({ homePath: "recent" }),
        makeProfile({ homePath: "stale" }),
        makeProfile({ homePath: "middle" }),
      ],
      lastAskedByHomePath: new Map([
        ["recent", "2026-08-16T12:00:00.000Z"],
        ["stale", "2026-08-16T09:00:00.000Z"],
        ["middle", "2026-08-16T11:00:00.000Z"],
      ]),
    });
    expect(target?.homePath).toBe("stale");
  });

  it("orders two never-asked accounts deterministically", () => {
    // Both sort keys are -Infinity here. Subtracting them yields NaN, which
    // would make the sort order undefined; the tie-break on home path is what
    // keeps the rotation from depending on sort implementation detail.
    const profiles = [makeProfile({ homePath: "zulu" }), makeProfile({ homePath: "alpha" })];
    expect(chooseRiddleTarget({ profiles, lastAskedByHomePath: new Map() })?.homePath).toBe(
      "alpha",
    );
    expect(
      chooseRiddleTarget({
        profiles: profiles.toReversed(),
        lastAskedByHomePath: new Map(),
      })?.homePath,
    ).toBe("alpha");
  });

  it("treats an unparseable stamp as never asked", () => {
    // Asking twice wastes one riddle; never asking is the feature silently
    // not working, so the ambiguity resolves toward asking.
    const target = chooseRiddleTarget({
      profiles: [makeProfile({ homePath: "broken" })],
      lastAskedByHomePath: new Map([["broken", "not a date"]]),
    });
    expect(target?.homePath).toBe("broken");
  });

  it("rotates: asking the chosen account moves the turn to the next one", () => {
    const profiles = [
      makeProfile({ homePath: "a" }),
      makeProfile({ homePath: "b" }),
      makeProfile({ homePath: "c" }),
    ];
    const asked = new Map<string, string>();
    const order: Array<string> = [];
    // Six ticks over three accounts: each should come round exactly twice, in
    // a stable cycle, which is the whole contract of the rotation.
    for (let tick = 0; tick < 6; tick += 1) {
      const target = chooseRiddleTarget({ profiles, lastAskedByHomePath: asked });
      expect(target).toBeDefined();
      order.push(target!.homePath);
      asked.set(target!.homePath, `2026-08-16T0${String(tick)}:00:00.000Z`);
    }
    expect(order).toEqual(["a", "b", "c", "a", "b", "c"]);
  });
});
