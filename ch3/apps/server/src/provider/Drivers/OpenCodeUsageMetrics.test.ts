import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import * as OpenCodeUsageMetrics from "./OpenCodeUsageMetrics.ts";

const runWith = <A, E>(
  effect: Effect.Effect<A, E, OpenCodeUsageMetrics.OpenCodeUsageMetrics>,
  runner: Partial<ProcessRunner.ProcessRunner["Service"]>,
) =>
  effect.pipe(
    Effect.provide(
      OpenCodeUsageMetrics.layer.pipe(
        Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)(runner)),
      ),
    ),
  );

const output = (over: Partial<ProcessRunner.ProcessRunOutput>) =>
  Effect.succeed<ProcessRunner.ProcessRunOutput>({
    stdout: "",
    stderr: "",
    code: 0 as ChildProcessSpawner.ExitCode,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...over,
  });

const okOutput = (stdout: string) => output({ stdout });

describe("OpenCodeUsageMetrics", () => {
  it.effect("renders the configured command's output", () =>
    runWith(
      Effect.gen(function* () {
        const metrics = yield* OpenCodeUsageMetrics.OpenCodeUsageMetrics;
        const result = yield* metrics.render(
          { cwd: "/tmp/project" },
          { usageMetricsCommand: "maple-usage.sh --oneline" },
        );
        assert.equal(result.text, "Maple $233 / $200 (117%)");
        assert.equal(result.failed, false);
      }),
      { run: () => okOutput("Maple $233 / $200 (117%)\n") },
    ),
  );

  it.effect("stays silent when no command is configured, and does not run anything", () =>
    Effect.gen(function* () {
      let ran = false;
      const result = yield* runWith(
        Effect.gen(function* () {
          const metrics = yield* OpenCodeUsageMetrics.OpenCodeUsageMetrics;
          return yield* metrics.render({ cwd: "/tmp/project" }, { usageMetricsCommand: "   " });
        }),
        {
          run: () => {
            ran = true;
            return okOutput("should never run");
          },
        },
      );
      assert.equal(result.text, null);
      // Unconfigured is the default state, not a failure: reporting `failed`
      // would light a warning for every user who never asked for this.
      assert.equal(result.failed, false);
      assert.equal(ran, false);
    }),
  );

  it.effect("reports failure without text when the command exits non-zero", () =>
    runWith(
      Effect.gen(function* () {
        const metrics = yield* OpenCodeUsageMetrics.OpenCodeUsageMetrics;
        const result = yield* metrics.render(
          { cwd: "/tmp/project" },
          { usageMetricsCommand: "false" },
        );
        assert.equal(result.text, null);
        assert.equal(result.failed, true);
      }),
      {
        run: () =>
          output({ stdout: "partial", stderr: "boom", code: 1 as ChildProcessSpawner.ExitCode }),
      },
    ),
  );

  it.effect("truncates past two lines rather than letting the composer grow", () =>
    runWith(
      Effect.gen(function* () {
        const metrics = yield* OpenCodeUsageMetrics.OpenCodeUsageMetrics;
        const result = yield* metrics.render(
          { cwd: "/tmp/project" },
          { usageMetricsCommand: "maple-usage.sh" },
        );
        assert.equal(result.text, "one\ntwo");
      }),
      { run: () => okOutput("one\ntwo\nthree\nfour\n") },
    ),
  );
});
