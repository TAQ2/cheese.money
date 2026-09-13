/**
 * Getting Claude Code onto a machine that has nothing, and making CH3 see it.
 *
 * CH3 cannot work without the Claude Code CLI, and the people who most need
 * it installed are the least able to install it: no Node, no npm, no Homebrew,
 * no terminal habit. CH3's CFO sat in front of "An error occurred in
 * Effect.tryPromise" for weeks because of exactly that.
 *
 * **Truth comes from running the binary, never from an installer's return
 * value.** The maintenance runner reports a failed `npm install` by *succeeding*
 * with a `status: "failed"` state — it records outcomes rather than raising
 * them — so code that branched on its error channel never took the fallback on
 * the machines the fallback exists for. Every step here is judged the same way
 * instead: run `claude --version` and see.
 *
 * The order, cheapest first:
 *
 *   1. The path already configured, or bare `claude` on the PATH.
 *   2. The package manager, through the existing maintenance runner.
 *   3. Anthropic's native installer — a compiled binary into `~/.local/bin`,
 *      no Node and no package manager anywhere in it.
 *
 * Then the part that is easy to forget and just as load-bearing: a GUI-launched
 * app does not have `~/.local/bin` on its PATH, so a working binary the app
 * cannot see is not an install. The absolute path is probed and written into
 * the provider's own setting, creating the instance entry when the settings
 * file has never had one — which is the state of every fresh machine.
 *
 * @module ClaudeCliInstaller
 */
import { ProviderDriverKind, ProviderInstanceId } from "@ch3tools/contracts";
import { compareSemverVersions } from "@ch3tools/shared/semver";
import { HostProcessEnvironment, HostProcessPlatform } from "@ch3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MINIMUM_CLAUDE_FABLE_VERSION } from "./Layers/ClaudeProvider.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

/** Anthropic's installer: a native binary, no Node and no package manager. */
const CLAUDE_NATIVE_INSTALL_URL = "https://claude.ai/install.sh";

/** A cold download and unpack over hotel wifi, with room to spare. */
const NATIVE_INSTALL_TIMEOUT = Duration.minutes(10);

/** Long enough for a cold binary on a slow disk, short enough not to look hung. */
const PROBE_TIMEOUT = Duration.seconds(20);

/**
 * One install at a time, for the whole process.
 *
 * Module-level rather than per-instance on purpose: the boot check and the
 * settings panel's button are built from different layer graphs, so a lock
 * belonging to one of them would not stop the other. Two installers racing into
 * one global npm prefix is how a half-written package happens, and two
 * read-modify-write passes over `settings.json` racing is how one is lost.
 */
const INSTALL_GATE = Semaphore.makeUnsafe(1);

/** The provider instance every build ships Claude under. */
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

/**
 * Where a Claude Code binary ends up, in the order a machine is likely to have
 * one.
 *
 * `~/.local/bin` is where the native installer puts it and is the reason this
 * list exists at all: it is on nobody's GUI PATH. The rest are the package
 * managers' own directories, so a machine that installed it through Homebrew or
 * npm is recognised without being reinstalled.
 */
const CLAUDE_BINARY_CANDIDATES = [
  ".local/bin/claude",
  ".claude/local/claude",
  ".bun/bin/claude",
] as const;
const CLAUDE_ABSOLUTE_CANDIDATES = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] as const;

/** What happened, in terms the caller can show a person. */
export interface ClaudeCliReadiness {
  /** Whether `claude --version` runs right now. */
  readonly ok: boolean;
  /** The path that answered, when one did. */
  readonly binaryPath: string | null;
  /** One sentence, safe to render. */
  readonly detail: string;
}

export class ClaudeCliInstaller extends Context.Service<
  ClaudeCliInstaller,
  {
    /**
     * Make sure the Claude Code CLI runs on this machine, installing it if it
     * does not, and point CH3 at whatever ended up working.
     *
     * Serialized: a boot check and a person pressing "Install Claude Code" must
     * not run two installs into one global prefix, and must not interleave two
     * read-modify-write passes over the settings file.
     *
     * Total — it never fails. An install that cannot happen leaves the app
     * exactly as it was, and says why in `detail`.
     */
    readonly ensureInstalled: (input: {
      readonly reason: string;
    }) => Effect.Effect<ClaudeCliReadiness>;
  }
>()("ch3/provider/ClaudeCliInstaller") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProviderMaintenanceRunner;

  const home = environment["HOME"]?.trim() ?? "";

  /** One `claude --version`: it ran (and said which version), it did not, or it never answered. */
  const probeOnce = (candidate: string) =>
    processRunner
      .run({
        command: candidate,
        args: ["--version"],
        env: environment,
        timeout: PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result): { status: "ok" | "no" | "timeout"; version: string | null } =>
          result.timedOut
            ? { status: "timeout", version: null }
            : result.code === 0
              ? {
                  status: "ok",
                  version: parseGenericCliVersion(`${result.stdout}\n${result.stderr}`),
                }
              : { status: "no", version: null },
        ),
        Effect.orElseSucceed(() => ({ status: "no" as const, version: null })),
      );

  /**
   * Does this path run? The only question this module trusts.
   *
   * A probe that times out is asked once more, and only a second silence counts
   * as "not installed". The two are indistinguishable from here — a cold binary
   * behind a busy disk and a machine with no Claude Code on it both produce
   * nothing for twenty seconds — and the consequence of getting it wrong is not
   * a retry later: it is an unattended `curl | bash` reinstalling a CLI that was
   * already there. A binary that does not exist fails immediately and never
   * reaches this, so the retry costs nothing on the path it does not help.
   */
  const probe = (candidate: string) =>
    Effect.gen(function* () {
      const first = yield* probeOnce(candidate);
      if (first.status !== "timeout") return first.status === "ok" ? first : null;
      yield* Effect.logInfo("A Claude Code probe timed out. Asking once more.", {
        path: candidate,
      });
      const second = yield* probeOnce(candidate);
      return second.status === "ok" ? second : null;
    });

  /**
   * Whether this version is current enough for everything CH3 ships.
   *
   * The floor is the newest model's requirement, because an "installed" CLI
   * that cannot run the model a conversation is set to is what leaves every
   * turn failing while the panel says Claude is fine. A version the
   * output does not name passes: reinstalling on every boot because a build
   * changed its banner is worse than trusting a binary that runs.
   */
  const isCurrent = (version: string | null) =>
    version === null || compareSemverVersions(version, MINIMUM_CLAUDE_FABLE_VERSION) >= 0;

  /** The configured path, or bare `claude` when nobody has configured one. */
  const configuredBinaryPath = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    if (settings._tag === "None") return "claude";
    const instance = settings.value.providerInstances[CLAUDE_INSTANCE_ID];
    const config =
      typeof instance?.config === "object" && instance.config !== null
        ? (instance.config as Record<string, unknown>)
        : {};
    const configured = String(config["binaryPath"] ?? "").trim();
    return configured.length > 0 ? configured : "claude";
  });

  /**
   * Every place a Claude binary could be on this machine, newest answer first.
   *
   * `command -v` through a login shell is asked last and matters most on a
   * machine that installed it somewhere none of the fixed candidates name — the
   * login shell is the only thing that knows what the person's own profile puts
   * on the PATH.
   */
  const locateBinary = Effect.gen(function* () {
    const candidates: Array<string> = [];
    if (home.length > 0) {
      for (const relative of CLAUDE_BINARY_CANDIDATES) candidates.push(path.join(home, relative));
    }
    candidates.push(...CLAUDE_ABSOLUTE_CANDIDATES);

    let stale: string | null = null;
    for (const candidate of candidates) {
      const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const answered = yield* probe(candidate);
      if (answered === null) continue;
      if (isCurrent(answered.version)) return candidate;
      // Runs, but predates the floor. Kept only if nothing current turns up.
      stale = stale ?? candidate;
    }

    if (platform === "win32") return stale;
    const located = yield* processRunner
      .run({
        command: "/bin/bash",
        args: ["-lc", "command -v claude"],
        env: environment,
        timeout: PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) =>
          result.code === 0 ? (result.stdout.trim().split("\n")[0] ?? null) : null,
        ),
        Effect.orElseSucceed(() => null),
      );
    if (located === null || located.length === 0) return stale;
    const answered = yield* probe(located);
    if (answered !== null && isCurrent(answered.version)) return located;
    return stale ?? (answered !== null ? located : null);
  });

  /**
   * Record where the working binary is, so a GUI-launched app can find it
   * without the person editing a shell profile.
   *
   * Creates the instance envelope when the settings file has never carried one.
   * `providerInstances` defaults to `{}` on a fresh install and is only
   * populated when something writes to it — so requiring an existing entry, as
   * the first version of this did, meant the path was never recorded on exactly
   * the machines that needed it.
   */
  const recordBinaryPath = (binaryPath: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      if (settings._tag === "None") return;
      const instances = settings.value.providerInstances;
      const instance = instances[CLAUDE_INSTANCE_ID];
      const currentConfig =
        typeof instance?.config === "object" && instance.config !== null
          ? (instance.config as Record<string, unknown>)
          : {};
      const configured = String(currentConfig["binaryPath"] ?? "").trim();
      // A path the person chose is theirs, even if this install landed
      // elsewhere. Bare `claude` is the default rather than a choice.
      if (configured.length > 0 && configured !== "claude" && configured !== binaryPath) return;
      if (configured === binaryPath) return;

      yield* settingsService
        .updateSettings({
          providerInstances: {
            ...instances,
            [CLAUDE_INSTANCE_ID]: {
              ...(instance ?? { driver: ProviderDriverKind.make("claudeAgent") }),
              config: { ...currentConfig, binaryPath },
            },
          },
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo("CH3 now points at this Claude Code binary.", { path: binaryPath }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Found Claude Code but could not record its path.", { cause }),
          ),
        );
    });

  /** Anthropic's installer. Shell script, so never on Windows. */
  const runNativeInstaller = Effect.gen(function* () {
    if (platform === "win32") return false;
    yield* Effect.logInfo("Installing Claude Code with Anthropic's native installer.");
    const result = yield* processRunner
      .run({
        command: "/bin/bash",
        // `-lc` so the login shell's PATH is present: the script needs `curl`,
        // which a GUI app's stripped environment may not have on it.
        args: ["-lc", `curl -fsSL ${CLAUDE_NATIVE_INSTALL_URL} | bash`],
        env: environment,
        timeout: NATIVE_INSTALL_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (result._tag === "None") {
      yield* Effect.logWarning("The native Claude Code installer could not be run.");
      return false;
    }
    if (result.value.timedOut || result.value.code !== 0) {
      yield* Effect.logWarning("The native Claude Code installer did not finish.", {
        code: result.value.code,
        stderr: result.value.stderr.slice(0, 500),
      });
      return false;
    }
    return true;
  });

  const ensureInstalled = Effect.fn("ClaudeCliInstaller.ensureInstalled")(function* (input: {
    readonly reason: string;
  }) {
    return yield* INSTALL_GATE.withPermits(1)(
      Effect.gen(function* () {
        const configured = yield* configuredBinaryPath;
        const configuredProbe = yield* probe(configured);
        if (configuredProbe !== null && isCurrent(configuredProbe.version)) {
          return {
            ok: true,
            binaryPath: configured,
            detail: "Claude Code is installed.",
          } satisfies ClaudeCliReadiness;
        }

        // A binary that runs but predates the floor is the worse failure of
        // the two: the panel says Claude is fine while every conversation on a
        // current model dies. It goes through the same install path as a
        // missing binary — the native installer always lands the latest.
        yield* Effect.logInfo(
          configuredProbe === null
            ? "Claude Code does not run on this machine. Installing it."
            : "Claude Code is older than CH3 requires. Upgrading it.",
          {
            reason: input.reason,
            configured,
            version: configuredProbe?.version ?? null,
            minimum: MINIMUM_CLAUDE_FABLE_VERSION,
          },
        );

        // The package manager first, because a machine that has one keeps
        // Claude Code updatable through the same path it installs everything
        // else. Its reported outcome is ignored on purpose — see the module
        // docstring — and the probe below is the real answer.
        yield* runner.updateProvider(ProviderDriverKind.make("claudeAgent")).pipe(Effect.ignore);

        let located = yield* locateBinary;
        if (located === null) {
          const installed = yield* runNativeInstaller;
          if (installed) located = yield* locateBinary;
        }

        if (located === null) {
          // A stale configured binary still runs; keep pointing at it rather
          // than reporting an install the machine does have as missing.
          if (configuredProbe !== null) {
            const detail = `Claude Code ${configuredProbe.version ? `v${configuredProbe.version}` : "here"} is older than v${MINIMUM_CLAUDE_FABLE_VERSION} and could not be upgraded automatically. Newer models will fail until it is updated.`;
            yield* Effect.logWarning("Claude Code is stale and the upgrade did not land.", {
              reason: input.reason,
              version: configuredProbe.version,
            });
            return { ok: true, binaryPath: configured, detail } satisfies ClaudeCliReadiness;
          }
          const detail =
            platform === "win32"
              ? "CH3 could not install Claude Code on Windows. Install it with `npm install -g @anthropic-ai/claude-code`."
              : "CH3 could not install Claude Code. Check this machine's internet connection and try again.";
          yield* Effect.logWarning("Claude Code could not be installed.", { reason: input.reason });
          return { ok: false, binaryPath: null, detail } satisfies ClaudeCliReadiness;
        }

        yield* recordBinaryPath(located);
        // The location says nothing about the vintage: locateBinary falls back
        // to a stale binary when no current one appeared, and reporting that
        // as "installed" is the lie this module exists to stop telling.
        const landed = yield* probe(located);
        const current = landed !== null && isCurrent(landed.version);
        yield* Effect.logInfo("Claude Code is installed and CH3 can run it.", {
          path: located,
          version: landed?.version ?? null,
          current,
          reason: input.reason,
        });
        return {
          ok: true,
          binaryPath: located,
          detail: current
            ? "Claude Code is installed."
            : `Claude Code ${landed?.version ? `v${landed.version}` : "here"} is older than v${MINIMUM_CLAUDE_FABLE_VERSION} and could not be upgraded automatically. Newer models will fail until it is updated.`,
        } satisfies ClaudeCliReadiness;
      }),
    );
  });

  return ClaudeCliInstaller.of({ ensureInstalled });
});

export const layer = Layer.effect(ClaudeCliInstaller)(make);
