/**
 * Live contract checks against Anthropic — the integration tier for the one
 * boundary a unit test cannot pin: what the real endpoint and the real CLI
 * send today.
 *
 * OPT-IN, AND SKIPPING IS THE NORMAL OUTCOME. Every test here is gated on
 * `CH3_LIVE_CLAUDE_CHECKS=1`. Without it — which is every CI run, because
 * GitHub Actions has no signed-in Claude account and must never be handed a
 * person's OAuth token (its refresh rotates; a copy in CI would race the
 * developer's own CLI and sign one of them out) — the whole describe block
 * skips, and the skip message below says exactly that. A skipped run of this
 * file is not a broken run. A silent green that ran nothing would be.
 *
 * Where it runs: a maintainer's Mac, before a release, against whatever
 * account that machine is signed into (`CH3_LIVE_CLAUDE_CONFIG_DIR` picks
 * another profile directory; `CH3_LIVE_CLAUDE_BINARY` another CLI). Cost:
 * one read of the usage endpoint and one tiny Haiku turn — the same turn the
 * keep-warm riddle already makes every 25 minutes on an idle account.
 *
 *   cd apps/server && CH3_LIVE_CLAUDE_CHECKS=1 npx vp test src/provider/Drivers/ClaudeAccountUsage.live.test.ts
 *
 * What it would have caught: the week this was written, the CLI's
 * `rate_limit_event` carried its numbers under `rate_limit_info.unifiedWindows`
 * with `utilization` on a 0–1 scale, while the SDK's own type declared a flat
 * shape. Only a real payload settles that; the recorded fixtures in
 * `ClaudeAccountUsage.test.ts` pin yesterday's shape, this file asks for
 * today's.
 */
// @effect-diagnostics nodeBuiltinImport:off - Test scaffolding; the temp cwd and the per-line JSON parse are the fixture, not app code.
// @effect-diagnostics preferSchemaOverJson:off - Each stdout line is decoded by the production parser after this split; JSON.parse only finds the line boundaries.
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import { CLAUDE_USAGE_USER_AGENT_VERSION } from "./ClaudeAccounts.ts";
import {
  clearClaudeUsageCache,
  configureClaudeUsageCachePath,
  fetchClaudeAccountUsage,
  parseClaudeRateLimitEvent,
} from "./ClaudeAccountUsage.ts";
import { defaultClaudeConfigDirPath, makeClaudeEnvironment } from "./ClaudeHome.ts";
import { RIDDLE_MODEL, RIDDLE_PROMPT, RIDDLE_TIMEOUT_MS } from "./claudeAccountRiddle.ts";

const LIVE = process.env["CH3_LIVE_CLAUDE_CHECKS"] === "1";

/** The real runner over the real platform: this file spawns `curl` and `claude`. */
const liveLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const liveConfigDir = Effect.fn("liveConfigDir")(function* () {
  const override = process.env["CH3_LIVE_CLAUDE_CONFIG_DIR"]?.trim();
  return override && override.length > 0 ? override : yield* defaultClaudeConfigDirPath();
});

describe.skipIf(!LIVE)(
  "live Claude contract checks — SKIPPED unless CH3_LIVE_CLAUDE_CHECKS=1 on a machine with a signed-in Claude account; skipping here (CI, or a machine without a credential) is the expected outcome, not a failure",
  () => {
    it.effect(
      "the usage endpoint still answers in a shape the production parser recognises",
      () =>
        Effect.gen(function* () {
          configureClaudeUsageCachePath(null);
          clearClaudeUsageCache();
          const configDir = yield* liveConfigDir();
          const fetched = yield* fetchClaudeAccountUsage({
            configDir,
            cliVersion: CLAUDE_USAGE_USER_AGENT_VERSION,
            accountKey: `live-check|${configDir}`,
            force: true,
          });

          // You asked for a live check and there is nobody to ask as. That is a
          // failure to report, not a skip to hide: the run was requested.
          expect(
            fetched.credentialMissing,
            `CH3_LIVE_CLAUDE_CHECKS=1 is set but no Claude credential was found for ${configDir}. Sign in with the CLI there, or point CH3_LIVE_CLAUDE_CONFIG_DIR at a signed-in profile.`,
          ).not.toBe(true);
          expect(
            fetched.unauthorized,
            `The endpoint rejected the stored token for ${configDir} (401/403): the account's sign-in has expired.`,
          ).not.toBe(true);
          // THE assertion this file exists for.
          expect(
            fetched.unrecognized,
            "The usage endpoint answered 200 with a body parseClaudeAccountUsage no longer understands — Anthropic moved the response shape. Update the schema in ClaudeAccountUsage.ts.",
          ).not.toBe(true);

          // A 429 is a legitimate live outcome — the bucket is per account and
          // this machine may have just polled — so it passes, and says so.
          if (fetched.rateLimited === true) {
            yield* Effect.logInfo(
              `[live] usage endpoint rate-limited this account; shape not exercised this run (retry-after ${String(fetched.retryAfterMs)} ms)`,
            );
            return;
          }
          expect(
            fetched.usage,
            "no usage and no error flag: the read returned nothing",
          ).toBeDefined();
          const usage = fetched.usage!;
          expect(usage.sessionPercent).toBeGreaterThanOrEqual(0);
          expect(usage.sessionPercent).toBeLessThanOrEqual(100);
          expect(usage.weekPercent).toBeGreaterThanOrEqual(0);
          expect(usage.weekPercent).toBeLessThanOrEqual(100);
          yield* Effect.logInfo(
            `[live] usage endpoint OK: session ${String(usage.sessionPercent)}% week ${String(usage.weekPercent)}%${usage.modelWeekPercent === undefined ? "" : ` model-week ${String(usage.modelWeekPercent)}%`}`,
          );
        }).pipe(Effect.provide(liveLayer)),
      RIDDLE_TIMEOUT_MS,
    );

    it.effect(
      "a real turn still emits rate_limit_event in a shape the production parser recognises",
      () =>
        Effect.gen(function* () {
          const runner = yield* ProcessRunner.ProcessRunner;
          const configDir = yield* liveConfigDir();
          const environment = yield* makeClaudeEnvironment({ homePath: configDir });
          const binary = process.env["CH3_LIVE_CLAUDE_BINARY"]?.trim() || "claude";

          // The keep-warm riddle's own turn, with the stream-json output the
          // adapter reads, so the CLI's rate_limit_event lines come out on
          // stdout exactly as a session would see them.
          const output = yield* runner.run({
            command: binary,
            args: [
              "-p",
              RIDDLE_PROMPT,
              "--model",
              RIDDLE_MODEL,
              "--output-format",
              "stream-json",
              "--verbose",
              "--mcp-config",
              '{"mcpServers":{}}',
              "--strict-mcp-config",
              "--tools",
              "",
            ],
            env: environment,
            cwd: NodeOS.tmpdir(),
            stdin: "",
            timeout: Duration.millis(RIDDLE_TIMEOUT_MS),
            timeoutBehavior: "timedOutResult",
          });

          const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
          const events = output.stdout
            .split("\n")
            .filter((line) => line.includes('"rate_limit_event"'))
            .map((line) => JSON.parse(line) as unknown);
          expect(
            events.length,
            "the turn completed but the CLI emitted no rate_limit_event at all — either the CLI stopped sending them or the stream-json flag no longer surfaces them",
          ).toBeGreaterThan(0);

          const parsed = events.map((event) => parseClaudeRateLimitEvent(event, nowMs));
          const recognised = parsed.filter((reading) => reading !== undefined);
          // THE assertion this file exists for.
          expect(
            recognised.length,
            `${String(events.length)} rate_limit_event(s) arrived and parseClaudeRateLimitEvent understood none of them — the CLI moved the payload shape. First event: ${JSON.stringify(events[0]).slice(0, 400)}`,
          ).toBeGreaterThan(0);
          for (const reading of recognised) {
            expect(reading!.session.percent).toBeGreaterThanOrEqual(0);
            expect(reading!.session.percent).toBeLessThanOrEqual(100);
            expect(reading!.week.percent).toBeGreaterThanOrEqual(0);
            expect(reading!.week.percent).toBeLessThanOrEqual(100);
          }
          yield* Effect.logInfo(
            `[live] ${String(recognised.length)}/${String(events.length)} rate_limit_event(s) parsed; session ${String(recognised[0]!.session.percent)}% week ${String(recognised[0]!.week.percent)}%`,
          );
        }).pipe(Effect.provide(liveLayer)),
      RIDDLE_TIMEOUT_MS + 30_000,
    );
  },
);
