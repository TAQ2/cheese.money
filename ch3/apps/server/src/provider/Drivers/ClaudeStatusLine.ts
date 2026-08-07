import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import type { ClaudeStatusLineContext, ClaudeStatusLineResult } from "@ch3tools/contracts";
import { ClaudeStatusLineError } from "@ch3tools/contracts";
import type { ClaudeSettings } from "@ch3tools/contracts";

import * as ProcessRunner from "../../processRunner.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "./ClaudeHome.ts";

/**
 * A status line is decoration: it must never delay a turn or grow without
 * bound. A command slower than this is reported as failed and the previous
 * value stays on screen.
 */
const STATUS_LINE_TIMEOUT = Duration.seconds(5);
const STATUS_LINE_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Claude Code renders at most two lines. Extra lines are dropped rather than
 * allowed to push the composer around.
 */
const STATUS_LINE_MAX_LINES = 2;

/**
 * `statusLine` as Claude Code declares it in settings.json. Only `command` is
 * used here: `padding` is terminal-cell layout with no meaning in a web client,
 * and the refresh cadence is the client's to choose.
 */
const StatusLineSettings = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
});

const ClaudeSettingsFile = Schema.Struct({
  statusLine: Schema.optional(StatusLineSettings),
});

const decodeClaudeSettingsFile = Schema.decodeEffect(Schema.fromJsonString(ClaudeSettingsFile));

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "object" &&
    error.reason !== null &&
    "_tag" in error.reason &&
    error.reason._tag === "NotFound"
  );
}

/**
 * Read one settings file, treating "absent" and "unparseable" alike: a
 * malformed settings.json is the user's own file and must not take the chat UI
 * down with it.
 */
const readStatusLineCommand = Effect.fn("ClaudeStatusLine.readStatusLineCommand")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      isNotFoundError(cause)
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(
            new ClaudeStatusLineError({
              reason: "settingsUnreadable",
              detail: `Could not read ${filePath}`,
              cause,
            }),
          ),
    ),
  );
  if (Option.isNone(raw)) {
    return Option.none<string>();
  }
  const decoded = yield* decodeClaudeSettingsFile(raw.value).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<typeof ClaudeSettingsFile.Type>()),
  );
  if (Option.isNone(decoded)) {
    return Option.none<string>();
  }
  const command = decoded.value.statusLine?.command.trim();
  return command === undefined || command.length === 0
    ? Option.none<string>()
    : Option.some(command);
});

/**
 * Claude Code's own precedence: project-local overrides shared project
 * settings, which override the user's. Managed/enterprise settings are not
 * consulted — CH3 has no business overriding an admin policy file.
 */
const resolveStatusLineCommand = Effect.fn("ClaudeStatusLine.resolveStatusLineCommand")(function* (
  cwd: string,
  claudeSettings: Pick<ClaudeSettings, "homePath">,
) {
  const path = yield* Path.Path;
  // `homePath` is the instance's CLAUDE_CONFIG_DIR (see ClaudeHome.ts), i.e.
  // already the config dir. With no override, Claude Code defaults to
  // ~/.claude, so the parent-vs-config-dir distinction matters here.
  const configuredHomePath = claudeSettings.homePath.trim();
  const configDir =
    configuredHomePath.length > 0
      ? yield* resolveClaudeHomePath(claudeSettings)
      : path.join(NodeOS.homedir(), ".claude");
  const defaultConfigDir = path.join(NodeOS.homedir(), ".claude");
  const candidates = [
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(configDir, "settings.json"),
    // A non-default account is its own config dir and starts with no settings
    // of its own, so the user's global statusLine would silently vanish on a
    // switch. Fall back to the default home — only when this profile has not
    // configured one itself, so an explicit per-account statusLine still wins.
    ...(configDir === defaultConfigDir ? [] : [path.join(defaultConfigDir, "settings.json")]),
  ];
  for (const candidate of candidates) {
    const command = yield* readStatusLineCommand(candidate);
    if (Option.isSome(command)) {
      return command;
    }
  }
  return Option.none<string>();
});

/**
 * Claude Code's status line stdin contract. Keys and units are Claude Code's so
 * that an unmodified script works here; anything CH3 cannot honestly source
 * is omitted rather than faked, which is exactly how the CLI behaves when a
 * value is unavailable.
 */
function buildStatusLinePayload(context: ClaudeStatusLineContext): string {
  return JSON.stringify({
    cwd: context.cwd,
    workspace: { current_dir: context.cwd, project_dir: context.cwd },
    ...(context.modelDisplayName === undefined
      ? {}
      : { model: { display_name: context.modelDisplayName } }),
    ...(context.version === undefined ? {} : { version: context.version }),
    ...(context.contextWindowSize === undefined && context.contextRemainingPercentage === undefined
      ? {}
      : {
          context_window: {
            ...(context.contextWindowSize === undefined
              ? {}
              : { context_window_size: context.contextWindowSize }),
            ...(context.contextRemainingPercentage === undefined
              ? {}
              : { remaining_percentage: context.contextRemainingPercentage }),
          },
        }),
    ...(context.effortLevel === undefined ? {} : { effort: { level: context.effortLevel } }),
    ...(context.alwaysThinkingEnabled === undefined
      ? {}
      : { alwaysThinkingEnabled: context.alwaysThinkingEnabled }),
  });
}

export class ClaudeStatusLine extends Context.Service<
  ClaudeStatusLine,
  {
    readonly render: (
      context: ClaudeStatusLineContext,
      claudeSettings: Pick<ClaudeSettings, "homePath">,
    ) => Effect.Effect<ClaudeStatusLineResult, ClaudeStatusLineError>;
  }
>()("ch3/provider/Drivers/ClaudeStatusLine") {}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const render: ClaudeStatusLine["Service"]["render"] = Effect.fn("ClaudeStatusLine.render")(
    function* (context, claudeSettings) {
      const command = yield* withPlatform(resolveStatusLineCommand(context.cwd, claudeSettings));
      if (Option.isNone(command)) {
        return { text: null, durationMs: 0, failed: false };
      }

      // The statusLine script must see the SAME account the session runs
      // under. Without this it inherits CH3's own environment, where
      // CLAUDE_CONFIG_DIR is unset, so a script that reports plan usage reads
      // the default account's credentials and shows the wrong account's rate
      // limits after a switch — with no hint that anything is off.
      const statusLineEnvironment = yield* withPlatform(makeClaudeEnvironment(claudeSettings));

      // Run through the user's shell so a `command` string with pipes,
      // redirects, or `$(...)` behaves exactly as it does in the terminal.
      const [elapsed, output] = yield* processRunner
        .run({
          command: "/bin/sh",
          args: ["-c", command.value],
          cwd: context.cwd,
          env: statusLineEnvironment,
          stdin: buildStatusLinePayload(context),
          timeout: STATUS_LINE_TIMEOUT,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: STATUS_LINE_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ClaudeStatusLineError({
                reason: "commandFailed",
                detail: "statusLine command could not be run",
                cause,
              }),
          ),
          Effect.timed,
        );
      const durationMs = Math.round(Duration.toMillis(elapsed));

      if (output.timedOut || output.code !== 0) {
        yield* Effect.logDebug("Claude statusLine command failed", {
          timedOut: output.timedOut,
          exitCode: output.code,
          stderrLength: output.stderr.length,
        });
        return { text: null, durationMs, failed: true };
      }

      const text = output.stdout
        .split("\n")
        .slice(0, STATUS_LINE_MAX_LINES)
        .join("\n")
        .replace(/\s+$/, "");
      return { text: text.length === 0 ? null : text, durationMs, failed: false };
    },
  );

  return ClaudeStatusLine.of({ render });
});

export const layer = Layer.effect(ClaudeStatusLine, make);

/** Exported for tests: the default Claude home when no instance override. */
export const defaultClaudeHome = () => NodeOS.homedir();
