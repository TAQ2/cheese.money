import { HostProcessEnvironment, HostProcessPlatform } from "@ch3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeCliInstaller, make } from "./ClaudeCliInstaller.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";

/**
 * The machine, as far as this module can see it: a HOME on disk, a set of
 * commands that answer, and a settings file.
 *
 * The installer is stubbed rather than run — Anthropic's real one would install
 * software on whoever ran the suite — but it writes the same binary in the same
 * place, because "did a binary appear and does it run" is the whole question
 * this module answers.
 */
const world = (options: {
  readonly home: string;
  /** Commands that exit 0. Anything else exits 127, like a missing binary. */
  readonly runs: (command: string, args: ReadonlyArray<string>) => boolean;
  readonly ran: Ref.Ref<Array<string>>;
  readonly settings: Ref.Ref<Record<string, unknown>>;
  readonly platform?: NodeJS.Platform;
  /** Runs when the native installer is invoked, to put a binary on disk. */
  readonly onNativeInstall?: Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
  /**
   * The first `--version` answers nothing and times out; every later one
   * behaves normally. A cold binary on a busy disk, which from here looks
   * exactly like a machine that does not have Claude Code.
   */
  readonly firstProbeTimesOut?: boolean;
  /** Counts `--version` calls, so the timeout above happens exactly once. */
  readonly probes?: Ref.Ref<number>;
  /** What a command's `--version` prints, for the staleness cases. */
  readonly versionOf?: (command: string) => string;
}) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, options.platform ?? "darwin"),
    Layer.succeed(HostProcessEnvironment, { HOME: options.home } as NodeJS.ProcessEnv),
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input: { readonly command: string; readonly args: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          yield* Ref.update(options.ran, (seen) => [
            ...seen,
            `${input.command} ${input.args.join(" ")}`,
          ]);
          const isNativeInstall = input.args.some((arg) => arg.includes("claude.ai/install.sh"));
          if (isNativeInstall && options.onNativeInstall !== undefined) {
            yield* options.onNativeInstall;
          }
          if (options.firstProbeTimesOut === true && input.args[0] === "--version") {
            const attempt = yield* Ref.updateAndGet(options.probes!, (count) => count + 1);
            if (attempt === 1) {
              return {
                stdout: "",
                stderr: "",
                code: 0,
                timedOut: true,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }
          }
          const ok = isNativeInstall || options.runs(input.command, input.args);
          const stdout =
            ok && input.args[0] === "-lc"
              ? `${options.home}/.local/bin/claude`
              : ok && input.args[0] === "--version"
                ? (options.versionOf?.(input.command) ?? "")
                : "";
          return {
            stdout,
            stderr: "",
            code: ok ? 0 : 127,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    } as unknown as ProcessRunner.ProcessRunner["Service"]),
    Layer.succeed(ProviderMaintenanceRunner, {
      // The real runner records a failed install as a SUCCESS carrying a
      // "failed" state. Modelled faithfully, because branching on its error
      // channel is the bug this module exists to stop repeating: there is no
      // way to make this stub report a failure, and there should not be.
      updateProvider: () => Effect.succeed({ providers: [] }),
    } as unknown as ProviderMaintenanceRunner["Service"]),
    Layer.succeed(ServerSettings.ServerSettingsService, {
      getSettings: Ref.get(options.settings),
      updateSettings: (patch: Record<string, unknown>) =>
        Ref.updateAndGet(options.settings, (current) => ({ ...current, ...patch })),
    } as unknown as ServerSettings.ServerSettingsService["Service"]),
    NodeServices.layer,
  );

const withInstaller = <A, E>(
  options: Omit<Parameters<typeof world>[0], "home" | "ran" | "probes" | "settings"> & {
    readonly settings?: Record<string, unknown>;
    readonly onNativeInstallWritesTo?: string;
  },
  body: (input: {
    readonly home: string;
    readonly ran: Ref.Ref<Array<string>>;
    readonly settings: Ref.Ref<Record<string, unknown>>;
    readonly installer: ClaudeCliInstaller["Service"];
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const ran = yield* Ref.make<Array<string>>([]);
    const probes = yield* Ref.make(0);
    const settings = yield* Ref.make<Record<string, unknown>>(
      options.settings ?? { providerInstances: {} },
    );

    const installer = yield* make.pipe(
      Effect.provide(
        world({
          ...options,
          home,
          ran,
          probes,
          settings,
          ...(options.onNativeInstallWritesTo === undefined
            ? {}
            : {
                // Stands in for Anthropic's installer, which is a shell script
                // that writes a binary: same effect, no download.
                onNativeInstall: Effect.gen(function* () {
                  const target = path.join(home, options.onNativeInstallWritesTo!);
                  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
                  yield* fs.writeFileString(target, "#!/bin/sh\n");
                }).pipe(Effect.orDie),
              }),
        }),
      ),
    );

    return yield* body({ home, ran, settings, installer });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.layer(NodeServices.layer)("ClaudeCliInstaller", (it) => {
  it.effect("installs nothing when the configured binary already runs", () =>
    withInstaller({ runs: (command) => command === "claude" }, ({ ran, installer }) =>
      Effect.gen(function* () {
        const result = yield* installer.ensureInstalled({ reason: "test" });

        assert.isTrue(result.ok);
        // One probe, and nothing else. A working machine must not be touched.
        assert.deepEqual(yield* Ref.get(ran), ["claude --version"]);
      }),
    ),
  );

  it.effect("asks again when a probe times out, rather than reinstalling", () =>
    withInstaller(
      { runs: (command) => command === "claude", firstProbeTimesOut: true },
      ({ ran, installer }) =>
        Effect.gen(function* () {
          const result = yield* installer.ensureInstalled({ reason: "test" });

          // A twenty-second silence and "not installed" look identical from
          // here, and treating the first as the second runs `curl | bash`
          // unattended against a machine that already had Claude Code.
          assert.isTrue(result.ok);
          assert.equal(result.binaryPath, "claude");
          const commands = yield* Ref.get(ran);
          assert.deepEqual(commands, ["claude --version", "claude --version"]);
        }),
    ),
  );

  it.effect("upgrades a binary that runs but predates the version floor", () =>
    withInstaller(
      {
        runs: (command) => command === "claude" || command.endsWith(".local/bin/claude"),
        versionOf: (command) =>
          command === "claude" ? "2.1.126 (Claude Code)" : "2.1.257 (Claude Code)",
        onNativeInstallWritesTo: ".local/bin/claude",
      },
      ({ ran, home, settings, installer }) =>
        Effect.gen(function* () {
          const result = yield* installer.ensureInstalled({ reason: "test" });

          // The exact failure this covers: `claude --version` exits 0 at
          // v2.1.126, the panel says Claude is fine, and every conversation on
          // a current model dies. Running is not the bar; current is.
          assert.isTrue(result.ok);
          assert.equal(result.binaryPath, `${home}/.local/bin/claude`);
          assert.equal(result.detail, "Claude Code is installed.");
          const commands = yield* Ref.get(ran);
          assert.isTrue(
            commands.some((line) => line.includes("claude.ai/install.sh")),
            `expected the native installer to run, saw: ${commands.join(", ")}`,
          );
          const recorded = (yield* Ref.get(settings)) as {
            providerInstances?: Record<string, { config?: { binaryPath?: string } }>;
          };
          assert.equal(
            recorded.providerInstances?.["claudeAgent"]?.config?.binaryPath,
            `${home}/.local/bin/claude`,
          );
        }),
    ),
  );

  it.effect("keeps a stale binary and says so when the upgrade does not land", () =>
    withInstaller(
      {
        runs: (command) => command === "claude",
        versionOf: () => "2.1.126 (Claude Code)",
      },
      ({ installer }) =>
        Effect.gen(function* () {
          const result = yield* installer.ensureInstalled({ reason: "test" });

          // A machine with a working-but-old CLI must not be reported as
          // having no Claude Code — and must not be reported as fine either.
          assert.isTrue(result.ok);
          assert.equal(result.binaryPath, "claude");
          assert.include(result.detail, "older than");
          assert.include(result.detail, "2.1.257");
        }),
    ),
  );

  it.effect("reaches the native installer when the package manager changed nothing", () =>
    withInstaller(
      {
        // `claude` is not on the PATH, and stays that way until a binary is
        // written into ~/.local/bin by the "installer".
        runs: (command) => command.endsWith(".local/bin/claude"),
        onNativeInstallWritesTo: ".local/bin/claude",
      },
      ({ ran, home, settings, installer }) =>
        Effect.gen(function* () {
          const result = yield* installer.ensureInstalled({ reason: "test" });

          // The failure this covers: the maintenance runner reports success for
          // an npm install that could not run, so the native fallback was
          // unreachable on exactly the machines it was written for.
          const commands = yield* Ref.get(ran);
          assert.isTrue(
            commands.some((command) => command.includes("claude.ai/install.sh")),
            commands.join(" | "),
          );
          assert.isTrue(result.ok);
          assert.equal(result.binaryPath, `${home}/.local/bin/claude`);

          // And the app can now see it: a GUI-launched app has no ~/.local/bin
          // on its PATH, so an install that is not recorded is not an install.
          const written = yield* Ref.get(settings);
          const instances = written["providerInstances"] as Record<
            string,
            { readonly config?: Record<string, unknown> }
          >;
          assert.equal(
            instances["claudeAgent"]?.config?.["binaryPath"],
            `${home}/.local/bin/claude`,
          );
        }),
    ),
  );

  it.effect("creates the provider entry when settings have never had one", () =>
    withInstaller(
      {
        runs: (command) => command.endsWith(".local/bin/claude"),
        onNativeInstallWritesTo: ".local/bin/claude",
        // The state of every fresh machine: the instance map is empty, and the
        // first version of this returned early rather than creating the entry.
        settings: { providerInstances: {} },
      },
      ({ settings, installer }) =>
        Effect.gen(function* () {
          yield* installer.ensureInstalled({ reason: "test" });

          const instances = (yield* Ref.get(settings))["providerInstances"] as Record<
            string,
            { readonly driver?: string }
          >;
          assert.equal(instances["claudeAgent"]?.driver, "claudeAgent");
        }),
    ),
  );

  it.effect("never overwrites a path the person chose", () =>
    withInstaller(
      {
        runs: (command) => command.endsWith(".local/bin/claude"),
        onNativeInstallWritesTo: ".local/bin/claude",
        settings: {
          providerInstances: {
            claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/opt/mine/claude" } },
          },
        },
      },
      ({ settings, installer }) =>
        Effect.gen(function* () {
          yield* installer.ensureInstalled({ reason: "test" });

          const instances = (yield* Ref.get(settings))["providerInstances"] as Record<
            string,
            { readonly config?: Record<string, unknown> }
          >;
          assert.equal(instances["claudeAgent"]?.config?.["binaryPath"], "/opt/mine/claude");
        }),
    ),
  );

  it.effect("says what went wrong rather than claiming success", () =>
    withInstaller({ runs: () => false }, ({ installer }) =>
      Effect.gen(function* () {
        // Nothing runs and the installer produces nothing: offline, or a
        // proxy in the way. The panel needs a truthful answer, because the
        // alternative is a person pressing Sign in forever.
        const result = yield* installer.ensureInstalled({ reason: "test" });

        assert.isFalse(result.ok);
        assert.isNull(result.binaryPath);
        assert.include(result.detail, "could not install");
      }),
    ),
  );

  it.effect("leaves Windows to its own installer", () =>
    withInstaller({ runs: () => false, platform: "win32" }, ({ ran, installer }) =>
      Effect.gen(function* () {
        const result = yield* installer.ensureInstalled({ reason: "test" });

        assert.isFalse(result.ok);
        const commands = yield* Ref.get(ran);
        assert.isFalse(commands.some((command) => command.includes("claude.ai/install.sh")));
        assert.include(result.detail, "npm install -g");
      }),
    ),
  );
});
