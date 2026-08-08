import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { OpenCodeSettings, OpenCodeUsageMetricsContext } from "@ch3tools/contracts";
import { OpenCodeUsageMetricsError, type OpenCodeUsageMetricsResult } from "@ch3tools/contracts";

import * as ProcessRunner from "../../processRunner.ts";

/**
 * Usage metrics are decoration: they must never delay a turn or grow without
 * bound. A command slower than this is reported as failed and the previous
 * value stays on screen.
 *
 * Five seconds is generous on purpose — the reference command reads OpenCode's
 * SQLite and aggregates a billing cycle, which is slower than echoing a string.
 */
const USAGE_METRICS_TIMEOUT = Duration.seconds(5);
const USAGE_METRICS_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Two lines, matching the Claude status line's budget. A command with more to
 * say is truncated rather than allowed to push the composer around; that is a
 * signal to add a compact mode to the script, not to grow the row.
 */
const USAGE_METRICS_MAX_LINES = 2;

/**
 * What the command reads on stdin. Unlike Claude Code's `statusLine`, nothing
 * upstream defines this shape, so it stays minimal and additive.
 */
function buildUsageMetricsPayload(context: OpenCodeUsageMetricsContext): string {
  return JSON.stringify({
    cwd: context.cwd,
    workspace: { current_dir: context.cwd, project_dir: context.cwd },
    ...(context.modelDisplayName === undefined
      ? {}
      : { model: { display_name: context.modelDisplayName } }),
  });
}

export class OpenCodeUsageMetrics extends Context.Service<
  OpenCodeUsageMetrics,
  {
    readonly render: (
      context: OpenCodeUsageMetricsContext,
      openCodeSettings: Pick<OpenCodeSettings, "usageMetricsCommand">,
    ) => Effect.Effect<OpenCodeUsageMetricsResult, OpenCodeUsageMetricsError>;
  }
>()("ch3/provider/Drivers/OpenCodeUsageMetrics") {}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const render: OpenCodeUsageMetrics["Service"]["render"] = Effect.fn(
    "OpenCodeUsageMetrics.render",
  )(function* (context, openCodeSettings) {
    const command = openCodeSettings.usageMetricsCommand.trim();
    // Unconfigured is the default state, not an error: the row simply does not
    // render. Reporting `failed` here would light a warning for every user who
    // never asked for this.
    if (command.length === 0) {
      return { text: null, durationMs: 0, failed: false };
    }

    // Through the user's shell so a command with pipes, redirects, `$(...)` or
    // a leading `~` behaves exactly as it does in their terminal.
    const [elapsed, output] = yield* processRunner
      .run({
        command: "/bin/sh",
        args: ["-c", command],
        cwd: context.cwd,
        stdin: buildUsageMetricsPayload(context),
        timeout: USAGE_METRICS_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: USAGE_METRICS_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeUsageMetricsError({
              reason: "commandFailed",
              detail: "usage metrics command could not be run",
              cause,
            }),
        ),
        Effect.timed,
      );
    const durationMs = Math.round(Duration.toMillis(elapsed));

    if (output.timedOut || output.code !== 0) {
      yield* Effect.logDebug("OpenCode usage metrics command failed", {
        timedOut: output.timedOut,
        exitCode: output.code,
        stderrLength: output.stderr.length,
      });
      return { text: null, durationMs, failed: true };
    }

    const text = output.stdout
      .split("\n")
      .slice(0, USAGE_METRICS_MAX_LINES)
      .join("\n")
      .replace(/\s+$/, "");
    return { text: text.length === 0 ? null : text, durationMs, failed: false };
  });

  return OpenCodeUsageMetrics.of({ render });
});

export const layer = Layer.effect(OpenCodeUsageMetrics, make);
