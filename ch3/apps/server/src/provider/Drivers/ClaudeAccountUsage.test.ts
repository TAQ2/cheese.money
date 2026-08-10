import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../../processRunner.ts";
import {
  claudeCredentialServices,
  clearClaudeUsageCache,
  fetchClaudeAccountUsage,
  parseClaudeAccountUsage,
  parseClaudeUsageResponse,
} from "./ClaudeAccountUsage.ts";

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

  it("tells a rate limit apart from silence, and carries its retry-after", () => {
    // The real 429 this machine received on 2026-08-10 while three callers
    // polled the endpoint independently. Read as plain silence — which is what
    // it used to be — it makes a healthy account's usage "unknown", and every
    // rotation and failover rule treats unknown as "stay put". An account at
    // 100% of its 5-hour window kept the seat because of it.
    const body = JSON.stringify({
      error: { type: "rate_limit_error", message: "Rate limited. Please try again later." },
    });
    const headers = JSON.stringify({
      "retry-after": ["2484"],
      "content-type": ["application/json"],
    });
    expect(parseClaudeUsageResponse(`${body}\n429\n${headers}`)).toEqual({
      rateLimited: true,
      retryAfterMs: 2_484_000,
    });
  });

  it("reads the status past a multi-line header block", () => {
    const body = JSON.stringify({
      five_hour: { utilization: 12 },
      seven_day: { utilization: 66 },
    });
    // curl pretty-prints `%{header_json}` across lines, so the status is not
    // the last line — reading it as such reported every response as garbage.
    const headers = '{\n"date":["Mon, 10 Aug 2026 15:35:41 GMT"],\n"server":["cloudflare"]\n}';
    expect(parseClaudeUsageResponse(`${body}\n200\n${headers}`)).toEqual({
      usage: { sessionPercent: 12, weekPercent: 66 },
    });
  });

  it("keeps a rejected token distinct from a rate limit", () => {
    expect(parseClaudeUsageResponse('{"error":"unauthorized"}\n401\n{}')).toEqual({
      unauthorized: true,
    });
    expect(parseClaudeUsageResponse("oops\n500\n{}")).toEqual({});
    expect(parseClaudeUsageResponse("no status here")).toEqual({});
  });

  it("survives a 429 with no retry-after to obey", () => {
    expect(parseClaudeUsageResponse("{}\n429\n{}")).toEqual({ rateLimited: true });
    expect(parseClaudeUsageResponse("{}\n429\nnot json")).toEqual({ rateLimited: true });
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

/**
 * The reads themselves, against a scripted `curl`.
 *
 * These pin the fix for the 2026-08-10 stall: three callers polling the same
 * endpoint independently earned a 429 with `retry-after: 2484`, every account's
 * usage became "unknown", and both the rotation and failover rules read unknown
 * as "stay put" — so an account at 100% of its 5-hour window kept the seat
 * while a sibling sat at 12%.
 */
describe("Claude account usage reads", () => {
  const dir = "/tmp/ch3-usage-test-profile";
  const usageBody = (session: number) =>
    JSON.stringify({ five_hour: { utilization: session }, seven_day: { utilization: 30 } });

  /** Scripted responses, one per `curl` invocation, plus a call counter. */
  const runnerLayer = (responses: ReadonlyArray<string>, calls: { curl: number }) =>
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input: { readonly command: string }) => {
        if (input.command !== "curl") {
          return Effect.succeed({
            stdout: JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }),
            stderr: "",
            code: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }
        const stdout = responses[Math.min(calls.curl, responses.length - 1)] ?? "";
        calls.curl += 1;
        return Effect.succeed({
          stdout,
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    } as never);

  it.effect("answers a second caller from the cache instead of the endpoint", () => {
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    return Effect.gen(function* () {
      const first = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      const second = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      expect(first.usage?.sessionPercent).toBe(12);
      expect(second.usage?.sessionPercent).toBe(12);
      // The whole storm was three independent callers asking per tick.
      expect(calls.curl).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(runnerLayer([`${usageBody(12)}\n200\n{}`], calls)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("counts two directories on one account as one read", () => {
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    return Effect.gen(function* () {
      yield* fetchClaudeAccountUsage({
        configDir: `${dir}-a`,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      const shared = yield* fetchClaudeAccountUsage({
        configDir: `${dir}-b`,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      // Same account and organization means one quota and one rate-limit
      // bucket; asking twice spends two calls to learn one number.
      expect(shared.usage?.sessionPercent).toBe(12);
      expect(calls.curl).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(runnerLayer([`${usageBody(12)}\n200\n{}`], calls)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("falls back to the last reading when the endpoint rate limits", () => {
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    const rateLimited = `{"error":{"type":"rate_limit_error"}}\n429\n{"retry-after":["2484"]}`;
    return Effect.gen(function* () {
      const good = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "rate@limited.com|Org",
      });
      expect(good.usage?.sessionPercent).toBe(12);

      // Past the fresh window: the endpoint is asked again, and refuses.
      yield* TestClock.adjust(Duration.minutes(2));
      const limited = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "rate@limited.com|Org",
      });
      expect(calls.curl).toBe(2);
      // THE FIX. This used to be `{}` — no usage, which every rule reads as
      // "stay put", which is how an exhausted account kept the seat.
      expect(limited.usage?.sessionPercent).toBe(12);
      expect(limited.stale).toBe(true);
      expect(limited.rateLimited).toBe(true);

      // And the retry-after is obeyed: no further call inside the penalty.
      yield* TestClock.adjust(Duration.minutes(5));
      const backedOff = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "rate@limited.com|Org",
      });
      expect(calls.curl).toBe(2);
      expect(backedOff.usage?.sessionPercent).toBe(12);

      // Beyond the stale window the cached number is dropped rather than acted
      // on: a quarter-hour-old reading is the mistake in the other direction.
      yield* TestClock.adjust(Duration.minutes(20));
      const expired = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "rate@limited.com|Org",
      });
      expect(expired.usage).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          runnerLayer([`${usageBody(12)}\n200\n{}`, rateLimited], calls),
          TestClock.layer(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  });

  it.effect("never covers a rejected token with a cached number", () => {
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    return Effect.gen(function* () {
      // A dead account must stay visibly dead: serving its last good reading
      // would let an unauthenticated profile keep the seat.
      const rejected = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "dead@account.com|Org",
      });
      expect(rejected.unauthorized).toBe(true);
      expect(rejected.usage).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(runnerLayer(['{"error":"unauthorized"}\n401\n{}'], calls)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});
