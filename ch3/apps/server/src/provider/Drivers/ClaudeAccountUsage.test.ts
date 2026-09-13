// @effect-diagnostics-next-line nodeBuiltinImport:off - a temp directory for the persisted cache, outside the effect under test
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - same: the temp path is test scaffolding, not app code
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../../processRunner.ts";
import {
  claudeCredentialServices,
  clearClaudeUsageCache,
  forgetClaudeAccountToken,
  configureClaudeUsageCachePath,
  readClaudeAccountToken,
  fetchClaudeAccountUsage,
  isDecisionGradeUsage,
  parseClaudeAccountUsage,
  parseClaudeRateLimitEvent,
  parseClaudeUsageResponse,
  recordClaudeRateLimitEvent,
  USAGE_READ_SPACING_MS,
  USAGE_STALE_MS,
  usageReadAgeMs,
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
      modelWeekPercent: 4,
      sessionResetsAt: "2026-08-04T08:30:00.467042+00:00",
      weekResetsAt: "2026-08-08T12:59:00+00:00",
    });
  });

  it("reads the per-model Fable cap from the limits array", () => {
    // The current endpoint shape: per-model caps live in `limits[]`, matched
    // by scope.model.display_name — not under a seven_day_<model> key.
    const response = JSON.stringify({
      five_hour: { utilization: 10.0, resets_at: "2026-08-14T20:00:00+00:00" },
      seven_day: { utilization: 50.0, resets_at: "2026-08-16T13:00:00+00:00" },
      limits: [
        { percent: 12.0, scope: { model: { display_name: "Claude Haiku 4.5" } } },
        {
          percent: 97.0,
          resets_at: "2026-08-16T13:00:00+00:00",
          scope: { model: { display_name: "Claude Fable 5.1" } },
        },
      ],
    });
    expect(parseClaudeAccountUsage(response)).toEqual({
      sessionPercent: 10,
      weekPercent: 50,
      modelWeekPercent: 97,
      sessionResetsAt: "2026-08-14T20:00:00+00:00",
      weekResetsAt: "2026-08-16T13:00:00+00:00",
      modelWeekResetsAt: "2026-08-16T13:00:00+00:00",
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

  /** Like `runnerLayer`, but counts the keychain spawns as well as the curls. */
  const countingRunner = (
    responses: ReadonlyArray<string>,
    calls: { curl: number; keychain: number },
  ) =>
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input: { readonly command: string }) => {
        if (input.command === "security") {
          calls.keychain += 1;
          return Effect.succeed({
            stdout: JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }),
            stderr: "",
            code: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }
        if (input.command !== "curl") {
          return Effect.succeed({
            stdout: "",
            stderr: "",
            code: 1,
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

  it.effect("reads the keychain once, not once a minute", () => {
    // The defect this exists for: the failover reactor polls every sixty
    // seconds, and each poll re-read the account token. On a machine whose
    // credential lives only in the login keychain that is a `security` spawn a
    // minute, and macOS gates each one — so the person got a keychain password
    // prompt every minute, forever, and cancelling bought sixty seconds.
    clearClaudeUsageCache();
    const calls = { curl: 0, keychain: 0 };
    return Effect.gen(function* () {
      // Two different accounts, one config directory: the usage cache is keyed
      // by account so both really do fetch, while the token is the same secret
      // and must only be read once.
      yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      // Reads are spaced; the clock, not a real wait, moves past the gap.
      yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));
      yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "c@d.com|Org",
      });

      expect(calls.curl).toBe(2);
      expect(calls.keychain).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          countingRunner([`${usageBody(12)}\n200\n{}`], calls),
          TestClock.layer(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  });

  it.effect("asks the keychain again once the endpoint rejects the token", () => {
    // The other half. A remembered token that has been rotated does not go
    // quietly stale — it comes back 401, and that is the one event worth paying
    // a prompt to correct. The keychain is asked again inside the rejected
    // call; when it still holds the very token that was refused, the rejection
    // stands, nothing is re-sent, and the next caller reads from memory again.
    clearClaudeUsageCache();
    const calls = { curl: 0, keychain: 0 };
    return Effect.gen(function* () {
      const rejected = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      expect(rejected.unauthorized).toBe(true);
      expect(calls.keychain).toBe(2);
      expect(calls.curl).toBe(1);

      yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));
      yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "c@d.com|Org",
      });
      expect(calls.keychain).toBe(2);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          countingRunner([`\n401\n{}`, `${usageBody(12)}\n200\n{}`], calls),
          TestClock.layer(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  });

  it.effect(
    "retries a rejected token with the one the keychain holds now, inside the same call",
    () => {
      // The CLI rotates the token whenever it runs, and the memory here never
      // expires — so the first poll after a keep-warm riddle opened with a 401
      // for every account, the panel showed "session expired — sign in again"
      // on every row, and the next poll a minute later took it all back. The
      // rotation is answered inside the call: one more keychain read, one more
      // request, and the number — never the false sign-out.
      clearClaudeUsageCache();
      const calls = { curl: 0, keychain: 0 };
      const tokens = ["stale-token", "rotated-token"];
      const bearers: Array<string> = [];
      const rotatingRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input: { readonly command: string; readonly stdin?: string }) => {
          if (input.command !== "curl") {
            const token = tokens[Math.min(calls.keychain, tokens.length - 1)];
            calls.keychain += 1;
            return Effect.succeed({
              stdout: JSON.stringify({ claudeAiOauth: { accessToken: token } }),
              stderr: "",
              code: 0,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          bearers.push((input.stdin ?? "").replace("Authorization: Bearer ", "").trim());
          const stdout = calls.curl === 0 ? "\n401\n{}" : `${usageBody(12)}\n200\n{}`;
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
      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          fetchClaudeAccountUsage({
            configDir: dir,
            cliVersion: "2.1.221",
            accountKey: "a@b.com|Org",
          }),
        );
        // Zero lets the forked read run to the spacing sleep before its second
        // request; the spacing then releases it.
        yield* TestClock.adjust(Duration.millis(0));
        yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));
        const result = yield* Fiber.join(fiber);

        expect(result.unauthorized).toBeUndefined();
        expect(result.usage?.sessionPercent).toBe(12);
        expect(bearers).toEqual(["stale-token", "rotated-token"]);
        expect(calls.keychain).toBe(2);
        expect(calls.curl).toBe(2);
      }).pipe(
        // No credentials file, answered without touching the disk: a forked read
        // still on real file I/O has not reached its sleep when the test clock
        // moves, and the test then waits forever on a request that never leaves.
        // One provide, layered rather than chained: the no-op FileSystem is
        // `self` so it wins over the one NodeServices carries.
        Effect.provide(
          FileSystem.layerNoop({}).pipe(
            Layer.provideMerge(
              Layer.mergeAll(rotatingRunner, TestClock.layer(), NodeServices.layer),
            ),
          ),
        ),
      );
    },
  );

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
      // Every reading is dated, not only the ones standing in for a failure:
      // the client cannot tell a fresh number from a stale one otherwise.
      expect(good.usage?.readAt).toBeTypeOf("string");

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

      // Beyond the stale window the number is still SERVED — a panel showing
      // the last reading and its age beats a blank, which reads as "no
      // account" — but it stops being evidence a hand-over may act on. The two
      // questions parted ways here: `isDecisionGradeUsage` answers the second.
      yield* TestClock.adjust(Duration.minutes(20));
      const expired = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "rate@limited.com|Org",
      });
      const expiredNowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      expect(expired.usage?.sessionPercent).toBe(12);
      expect(expired.stale).toBe(true);
      expect(expired.usage?.readAt).toBeTypeOf("string");
      expect(isDecisionGradeUsage(expired.usage, expiredNowMs)).toBe(false);
      expect(usageReadAgeMs(expired.usage, expiredNowMs)).toBeGreaterThan(USAGE_STALE_MS);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          runnerLayer([`${usageBody(12)}\n200\n{}`, rateLimited], calls),
          TestClock.layer(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  });

  it.effect("cached-only paints the last number and never touches the endpoint", () => {
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    return Effect.gen(function* () {
      // One live read to seed the cache.
      const seeded = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "cached@only.com|Org",
      });
      expect(seeded.usage?.sessionPercent).toBe(12);
      expect(calls.curl).toBe(1);

      // Past the fresh window an ordinary read would call the endpoint again.
      // Cached-only must not: it returns the last number, marked stale, with
      // no further call. This is the panel's first paint.
      yield* TestClock.adjust(Duration.minutes(2));
      const painted = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "cached@only.com|Org",
        cachedOnly: true,
      });
      expect(calls.curl).toBe(1);
      expect(painted.usage?.sessionPercent).toBe(12);
      expect(painted.stale).toBe(true);

      // An account never read has nothing cached: cached-only returns no usage
      // and still makes no call, so a cold row is blank rather than a lie.
      const cold = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "never@read.com|Org",
        cachedOnly: true,
      });
      expect(calls.curl).toBe(1);
      expect(cold.usage).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(runnerLayer([`${usageBody(12)}\n200\n{}`], calls), TestClock.layer()).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("spaces two accounts' reads apart instead of firing them together", () => {
    // The burst that blinded the panel: six profiles probed at once, six
    // reads inside a few milliseconds, five of them refused. Two callers
    // asking together now leave one gate one after the other, a beat apart.
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    return Effect.gen(function* () {
      // One read up front so the directory's token is cached: the token read
      // looks for a credentials file on the real filesystem, and a forked read
      // still on that I/O has not reached `curl` when the test clock is
      // advanced by zero — which made this test fail on nothing.
      yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "warm@up.com|Org",
      });
      expect(calls.curl).toBe(1);
      yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));

      const first = yield* Effect.forkChild(
        fetchClaudeAccountUsage({
          configDir: dir,
          cliVersion: "2.1.221",
          accountKey: "a@b.com|Org",
        }),
      );
      const second = yield* Effect.forkChild(
        fetchClaudeAccountUsage({
          configDir: dir,
          cliVersion: "2.1.221",
          accountKey: "c@d.com|Org",
        }),
      );
      yield* TestClock.adjust(Duration.millis(0));
      // The first went out at once; the second is waiting its turn.
      expect(calls.curl).toBe(2);
      yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));
      expect(calls.curl).toBe(3);
      expect((yield* Fiber.join(first)).usage?.sessionPercent).toBe(12);
      expect((yield* Fiber.join(second)).usage?.sessionPercent).toBe(12);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(runnerLayer([`${usageBody(12)}\n200\n{}`], calls), TestClock.layer()).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("a 429 pauses the account that earned it until its retry-after, and no other", () => {
    // The endpoint's bucket is per account: one paced read per account from
    // one shell had claudio.uno refused with retry-after 246 while three
    // siblings answered 200 in the same ten seconds. A pause for everyone
    // turned that one hot account into six blank rows.
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    const rateLimited = `{"error":{"type":"rate_limit_error"}}\n429\n{"retry-after":["60"]}`;
    return Effect.gen(function* () {
      const refused = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      expect(refused.rateLimited).toBe(true);
      expect(refused.retryAtMs).toBe(nowMs + 60_000);
      expect(calls.curl).toBe(1);

      yield* TestClock.adjust(Duration.seconds(30));
      const sibling = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "c@d.com|Org",
      });
      // Read: the penalty belongs to the other account.
      expect(calls.curl).toBe(2);
      expect(sibling.usage?.sessionPercent).toBe(12);
      expect(sibling.rateLimited).toBeUndefined();

      // The refused one is still inside its own pause, and says until when.
      const stillRefused = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      expect(calls.curl).toBe(2);
      expect(stillRefused.rateLimited).toBe(true);
      expect(stillRefused.retryAtMs).toBe(nowMs + 60_000);

      yield* TestClock.adjust(Duration.seconds(31));
      const resumed = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      expect(calls.curl).toBe(3);
      expect(resumed.usage?.sessionPercent).toBe(12);
      expect(resumed.rateLimited).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          runnerLayer([rateLimited, `${usageBody(12)}\n200\n{}`], calls),
          TestClock.layer(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  });

  it.effect("keeps the readings and each account's pause across a restart", () => {
    // A restart used to forget both, come up blank, read every account at
    // once, and earn the penalty it had just served. `clearClaudeUsageCache`
    // is the restart here: memory gone, file still there.
    const cacheDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-usage-cache-"));
    const cachePath = NodePath.join(cacheDir, "claude-usage-cache.json");
    configureClaudeUsageCachePath(cachePath);
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    const rateLimited = `{"error":{"type":"rate_limit_error"}}\n429\n{"retry-after":["600"]}`;
    return Effect.gen(function* () {
      const read = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      expect(read.usage?.sessionPercent).toBe(12);
      yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));
      const refused = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "c@d.com|Org",
      });
      expect(refused.rateLimited).toBe(true);
      expect(calls.curl).toBe(2);
      expect(NodeFS.existsSync(cachePath)).toBe(true);

      // Restart.
      clearClaudeUsageCache();
      yield* TestClock.adjust(Duration.minutes(2));
      const refusedAfterRestart = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "c@d.com|Org",
      });
      // No read: the pause the endpoint asked for on THIS account is still
      // running, and the file remembered it.
      expect(calls.curl).toBe(2);
      expect(refusedAfterRestart.rateLimited).toBe(true);
      expect(refusedAfterRestart.retryAtMs).toBeTypeOf("number");

      // The sibling's reading survived too, dated — and its own read is not
      // held back by a penalty it never earned.
      yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));
      const siblingAfterRestart = yield* fetchClaudeAccountUsage({
        configDir: dir,
        cliVersion: "2.1.221",
        accountKey: "a@b.com|Org",
      });
      expect(calls.curl).toBe(3);
      expect(siblingAfterRestart.usage?.sessionPercent).toBe(12);
      expect(siblingAfterRestart.rateLimited).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          runnerLayer(
            [`${usageBody(12)}\n200\n{}`, rateLimited, `${usageBody(12)}\n200\n{}`],
            calls,
          ),
          TestClock.layer(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          configureClaudeUsageCachePath(null);
          clearClaudeUsageCache();
          NodeFS.rmSync(cacheDir, { recursive: true, force: true });
        }),
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

describe("reading the account credential out of the keychain", () => {
  /**
   * A keychain holding two items under one service name, which is what
   * `claude mcp login` leaves behind: the unscoped lookup reaches its
   * MCP-only item, and the account's own credential is only found by asking
   * for the OS user's item.
   */
  const shadowedKeychain = (calls: { args: Array<ReadonlyArray<string>> }) =>
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input: { readonly command: string; readonly args?: ReadonlyArray<string> }) => {
        const args = input.args ?? [];
        calls.args.push(args);
        const scoped = args.includes("-a");
        return Effect.succeed({
          stdout:
            input.command !== "security"
              ? ""
              : scoped
                ? JSON.stringify({
                    claudeAiOauth: { accessToken: "real-account-token" },
                    mcpOAuth: {},
                  })
                : JSON.stringify({ mcpOAuth: { sentry: { accessToken: "mcp-token" } } }),
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    } as never);

  it.effect("looks past an MCP-only item filed under the same service name", () => {
    // The bug this exists for: signing an MCP server in left two profiles
    // reading "sign in again to see usage" while they were signed in and
    // working, because the first item under that service had no account
    // credential in it at all.
    clearClaudeUsageCache();
    const calls = { args: [] as Array<ReadonlyArray<string>> };
    return Effect.gen(function* () {
      const token = yield* readClaudeAccountToken("/tmp/ch3-shadowed-profile");
      expect(token).toBe("real-account-token");
      // The account-scoped question is asked first, so the ordinary machine
      // pays one keychain spawn rather than two.
      expect(calls.args[0]).toContain("-a");
    }).pipe(Effect.provide(shadowedKeychain(calls).pipe(Layer.provideMerge(NodeServices.layer))));
  });
});

describe("decision-grade usage", () => {
  const nowMs = Date.parse("2026-08-20T18:00:00.000Z");
  const readAt = (minutesAgo: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(nowMs - minutesAgo * 60_000));

  it("lets a recent reading move an account", () => {
    expect(isDecisionGradeUsage({ readAt: readAt(5) }, nowMs)).toBe(true);
    expect(usageReadAgeMs({ readAt: readAt(5) }, nowMs)).toBe(5 * 60_000);
  });

  it("refuses one past the horizon, which is the whole point of dating them", () => {
    expect(isDecisionGradeUsage({ readAt: readAt(16) }, nowMs)).toBe(false);
  });

  it("treats an unstamped reading as current, as every caller did before the stamp", () => {
    expect(isDecisionGradeUsage({}, nowMs)).toBe(true);
    expect(usageReadAgeMs({}, nowMs)).toBeUndefined();
  });

  it("has no opinion about a reading that does not exist", () => {
    expect(isDecisionGradeUsage(undefined, nowMs)).toBe(false);
  });

  it("ignores an unparseable stamp rather than treating it as the epoch", () => {
    expect(usageReadAgeMs({ readAt: "not-a-date" }, nowMs)).toBeUndefined();
    expect(isDecisionGradeUsage({ readAt: "not-a-date" }, nowMs)).toBe(true);
  });

  it("draws the horizon at fifteen minutes", () => {
    expect(USAGE_STALE_MS).toBe(15 * 60_000);
  });
});

it("reports the most constraining per-model window, not the first one listed", () => {
  // The endpoint can carry a 5-hour and a weekly cap for the same model.
  // Showing whichever came first let the band read comfortable while the
  // binding window was full.
  const response = JSON.stringify({
    five_hour: { utilization: 10.0 },
    seven_day: { utilization: 50.0 },
    limits: [
      {
        percent: 56.0,
        resets_at: "2026-08-19T23:59:00+00:00",
        scope: { model: { display_name: "Claude Fable 5.1" } },
      },
      {
        percent: 100.0,
        resets_at: "2026-08-15T03:39:00+00:00",
        scope: { model: { display_name: "Claude Fable 5.1" } },
      },
    ],
  });
  expect(parseClaudeAccountUsage(response)).toMatchObject({
    modelWeekPercent: 100,
    modelWeekResetsAt: "2026-08-15T03:39:00+00:00",
  });
});

/**
 * The CLI's `rate_limit_event`, the second transport.
 *
 * The payload below is a VERBATIM copy of one taken from this machine's
 * provider log on 2026-09-02 (`~/.ch3/userdata/logs/provider/`), not a
 * reconstruction — including the wrapper key `rate_limit_info`, the epoch
 * SECONDS in `resetsAt`, and the fraction scale in `utilization`.
 */
describe("Claude rate-limit events", () => {
  const realEvent = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1788377400,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.3, resetsAt: 1788377400 },
        seven_day: { utilization: 0.23, resetsAt: 1788724800 },
        seven_day_overage_included: { utilization: 0.31, resetsAt: 1788724800 },
      },
    },
    uuid: "acde53eb-2639-4c5e-becc-07adecbe9346",
    session_id: "21f71512-944c-423f-b971-a14d37025413",
  };

  it("reads the stream's 0–1 fraction as the endpoint's 0–100 percent", () => {
    // The scale was ESTABLISHED, not assumed: across 1787 real events the
    // largest `utilization` ever seen is 1.01, and `claudio.aurelio`'s last
    // event before a successful poll read five_hour 0.99 / seven_day 0.61
    // while the poll moments later recorded sessionPercent 100 / weekPercent
    // 61. Treating the fraction as a percent would show 0% on a full account.
    expect(parseClaudeRateLimitEvent(realEvent, 1_000)).toEqual({
      atMs: 1_000,
      session: { percent: 30, resetsAt: "2026-09-02T19:30:00.000Z" },
      week: { percent: 23, resetsAt: "2026-09-06T20:00:00.000Z" },
    });
  });

  it("ignores the overage window, which has no field on a reading", () => {
    // Folding `seven_day_overage_included` into the weekly figure would
    // overstate what the PLAN window has left — a different allowance.
    const parsed = parseClaudeRateLimitEvent(realEvent, 1_000);
    expect(parsed?.week.percent).toBe(23);
  });

  it("drops an event carrying no windows rather than reading it as zero", () => {
    // 49 of this machine's events have an empty `rate_limit_info`. Zeroes
    // would make an exhausted account look like the safest failover target.
    expect(parseClaudeRateLimitEvent({ type: "rate_limit_event" }, 1)).toBeUndefined();
    expect(
      parseClaudeRateLimitEvent({ type: "rate_limit_event", rate_limit_info: {} }, 1),
    ).toBeUndefined();
    expect(
      parseClaudeRateLimitEvent(
        { rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.3 } } } },
        1,
      ),
    ).toBeUndefined();
  });

  it("refuses to write a reading under an empty account key", () =>
    // The worst outcome available here: a busy account's numbers filed in
    // another account's slot make the panel lie about which account has
    // capacity left. An unresolved identity drops the event instead.
    Effect.gen(function* () {
      configureClaudeUsageCachePath(null);
      clearClaudeUsageCache();
      expect(yield* recordClaudeRateLimitEvent({ accountKey: "  ", message: realEvent })).toBe(
        false,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise));

  it.effect("refreshes only the windows the event carries, newest wins per window", () => {
    configureClaudeUsageCachePath(null);
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    // A poll first, carrying all three windows including the per-model cap.
    const polled = JSON.stringify({
      five_hour: { utilization: 4 },
      seven_day: { utilization: 9 },
      seven_day_opus: { utilization: 28 },
    });
    return Effect.gen(function* () {
      const first = yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "event@b.com|Org",
      });
      expect(first.usage).toMatchObject({
        sessionPercent: 4,
        weekPercent: 9,
        modelWeekPercent: 28,
      });
      const polledReadAt = first.usage?.readAt;

      // Inside the per-model window's own horizon, so the only thing that
      // could send a second read is still current.
      yield* TestClock.adjust(Duration.minutes(5));
      yield* recordClaudeRateLimitEvent({ accountKey: "event@b.com|Org", message: realEvent });

      const after = yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "event@b.com|Org",
      });
      // Session and week moved to the event's numbers; the per-model figure
      // the event does not carry is left standing rather than deleted.
      expect(after.usage).toMatchObject({
        sessionPercent: 30,
        weekPercent: 23,
        modelWeekPercent: 28,
      });
      // ...and it carries its OWN age, the earlier poll's, so the row cannot
      // pass it off as being as current as the two beside it.
      expect(after.usage?.modelWeekReadAt).toBe(polledReadAt);
      expect(after.usage?.readAt).not.toBe(polledReadAt);
      // The event-sourced reading is decision-grade, which is the entire
      // point: a stale `readAt` makes the hand-over refuse to act.
      const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      expect(isDecisionGradeUsage(after.usage, nowMs)).toBe(true);
      // And no second read went out: the event already covered this account,
      // so the poll that keeps earning the 429 is simply not made.
      expect(calls.curl).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(rateLimitRunner([`${polled}\n200\n{}`], calls)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("still polls a streaming account once the per-model window ages out", () => {
    configureClaudeUsageCachePath(null);
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    const polled = JSON.stringify({
      five_hour: { utilization: 4 },
      seven_day: { utilization: 9 },
      seven_day_opus: { utilization: 28 },
    });
    return Effect.gen(function* () {
      const read = { configDir: "/tmp/ch3-usage-test-profile", cliVersion: "2.1.221" };
      const key = "aging@b.com|Org";
      yield* fetchClaudeAccountUsage({ ...read, accountKey: key });
      expect(calls.curl).toBe(1);

      // An event a minute, the cadence a busy session actually emits. Session
      // and week never go stale, so nothing here would ever ask the endpoint
      // again — and the per-model figure comes from the endpoint alone.
      for (let minute = 0; minute < 20; minute += 1) {
        yield* TestClock.adjust(Duration.minutes(1));
        yield* recordClaudeRateLimitEvent({ accountKey: key, message: realEvent });
        yield* fetchClaudeAccountUsage({ ...read, accountKey: key });
      }

      // Once, not twenty times: the per-model window has its own longer clock,
      // so the account that cannot poll for session and week still gets the
      // number that actually stops a Fable turn.
      expect(calls.curl).toBe(2);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(rateLimitRunner([`${polled}\n200\n{}`, `${polled}\n200\n{}`], calls)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  /** Same scripted `curl` shape the read tests above use. */
  function rateLimitRunner(responses: ReadonlyArray<string>, calls: { curl: number }) {
    return Layer.succeed(ProcessRunner.ProcessRunner, {
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
  }

  it.effect("migrates a version 1 cache file instead of discarding it", () => {
    // Every engineer has a v1 file on disk holding real readings. Dropping it
    // would put the panel back to blank-and-storm on the first launch after an
    // update — the exact failure the file exists to prevent.
    const cacheDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-usage-v1-"));
    const cachePath = NodePath.join(cacheDir, "claude-usage-cache.json");
    const atMs = 1_788_000_000_000;
    NodeFS.writeFileSync(
      cachePath,
      `${JSON.stringify({
        version: 1,
        pausedUntilByKey: { "v1@b.com|Org": atMs + 600_000 },
        readings: {
          "v1@b.com|Org": {
            atMs,
            usage: { sessionPercent: 7, weekPercent: 29, modelWeekPercent: 28 },
          },
        },
      })}\n`,
    );
    configureClaudeUsageCachePath(cachePath);
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    return Effect.gen(function* () {
      yield* TestClock.setTime(atMs + 60_001);
      const read = yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "v1@b.com|Org",
      });
      // The numbers survived, and the pause the file remembered is honoured,
      // so no read went out.
      expect(read.usage).toMatchObject({
        sessionPercent: 7,
        weekPercent: 29,
        modelWeekPercent: 28,
      });
      expect(read.rateLimited).toBe(true);
      expect(calls.curl).toBe(0);
      // A v1 record's one instant is the instant of all three of its windows,
      // which is exactly what it meant — so nothing looks older than it is.
      expect(read.usage?.readAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(atMs)));
      expect(read.usage?.modelWeekReadAt).toBeUndefined();

      // An event now rewrites the file as version 2...
      yield* recordClaudeRateLimitEvent({ accountKey: "v1@b.com|Org", message: realEvent });
      // @effect-diagnostics-next-line preferSchemaOverJson:off - reading the file back RAW is the point: a schema decode would accept either version and prove nothing about which one was written
      const written = JSON.parse(NodeFS.readFileSync(cachePath, "utf8")) as {
        version: number;
        readings: Record<string, { sessionAtMs: number; weekAtMs: number; modelWeekAtMs: number }>;
      };
      expect(written.version).toBe(2);
      expect(written.readings["v1@b.com|Org"]?.modelWeekAtMs).toBe(atMs);

      // ...and the code that wrote it can read it back after a restart.
      clearClaudeUsageCache();
      const reloaded = yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "v1@b.com|Org",
      });
      expect(reloaded.usage).toMatchObject({
        sessionPercent: 30,
        weekPercent: 23,
        modelWeekPercent: 28,
      });
      expect(reloaded.usage?.modelWeekReadAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(atMs)));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(rateLimitRunner([`{}\n200\n{}`], calls)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("forces a read inside a pause, then throttles the next one", () => {
    configureClaudeUsageCachePath(null);
    clearClaudeUsageCache();
    const calls = { curl: 0 };
    const refused = `{"error":{}}\n429\n{"retry-after":["2484"]}`;
    const good = `${JSON.stringify({
      five_hour: { utilization: 5 },
      seven_day: { utilization: 6 },
    })}\n200\n{}`;
    return Effect.gen(function* () {
      const first = yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "force@b.com|Org",
      });
      expect(first.rateLimited).toBe(true);

      // Nothing automatic gets through the pause...
      yield* TestClock.adjust(Duration.millis(USAGE_READ_SPACING_MS));
      yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "force@b.com|Org",
      });
      expect(calls.curl).toBe(1);

      // ...but a person asking does, which is the control that did not exist.
      const forced = yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "force@b.com|Org",
        force: true,
      });
      expect(calls.curl).toBe(2);
      expect(forced.usage?.sessionPercent).toBe(5);

      // A second press inside the minute does NOT go out — mashing the button
      // must not deepen the very penalty it is fighting — and says when it can.
      const throttled = yield* fetchClaudeAccountUsage({
        configDir: "/tmp/ch3-usage-test-profile",
        cliVersion: "2.1.221",
        accountKey: "force@b.com|Org",
        force: true,
      });
      expect(calls.curl).toBe(2);
      expect(throttled.forceRetryAtMs).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(rateLimitRunner([refused, good], calls)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it("tells a shape change apart from a network hiccup", () => {
    // A 200 whose body no longer parses used to render identically to a
    // timeout: both showed nothing, so a response-shape change looked exactly
    // like flaky wifi and nobody went and looked.
    expect(parseClaudeUsageResponse(`{"five_hour":{"pct":9}}\n200\n{}`)).toEqual({
      unrecognized: true,
    });
    expect(parseClaudeUsageResponse("")).toEqual({});
  });
});

describe("the remembered absence of a credential", () => {
  /** A keychain that holds nothing: every `security` spawn answers empty. */
  const emptyKeychain = (calls: { keychain: number }) =>
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input: { readonly command: string }) => {
        if (input.command === "security") calls.keychain += 1;
        return Effect.succeed({
          stdout: "",
          stderr: "",
          code: input.command === "security" ? 44 : 1,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    } as never);
  const dir = "/tmp/ch3-usage-test-absent-profile";

  it.effect("is remembered for a while, so an account-less machine is not asked every poll", () => {
    clearClaudeUsageCache();
    const calls = { keychain: 0 };
    return Effect.gen(function* () {
      expect(yield* readClaudeAccountToken(dir)).toBeUndefined();
      expect(yield* readClaudeAccountToken(dir)).toBeUndefined();
      // One spawn for the first read; the second read is answered from memory.
      // (Each read tries every service and account name, so count spawns
      // relative to the first read rather than as an absolute.)
      const afterFirst = calls.keychain;
      expect(afterFirst).toBeGreaterThan(0);
      yield* readClaudeAccountToken(dir);
      expect(calls.keychain).toBe(afterFirst);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(emptyKeychain(calls), TestClock.layer()).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("is forgotten by forgetClaudeAccountToken, which is what a sign-in calls", () => {
    // 0da068b2: after signing in, the row kept saying "sign in again to see
    // usage" for up to five minutes, because nothing cleared the remembered
    // absence. A sign-in and a force-read both call this; it must make the
    // next read ask the keychain again.
    clearClaudeUsageCache();
    const calls = { keychain: 0 };
    return Effect.gen(function* () {
      yield* readClaudeAccountToken(dir);
      const afterFirst = calls.keychain;
      forgetClaudeAccountToken(dir);
      yield* readClaudeAccountToken(dir);
      expect(calls.keychain).toBe(afterFirst * 2);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(emptyKeychain(calls), TestClock.layer()).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});
