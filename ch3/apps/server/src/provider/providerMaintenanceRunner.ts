/**
 * Running a provider's own update command, and telling the truth about it.
 *
 * Two rules, both learned the hard way:
 *
 *   1. **The outcome comes from re-probing the provider, not from the exit
 *      code.** See {@link providerUpdateOutcome} for why an updater that exits
 *      0 proves nothing.
 *   2. **A failed update fails.** This used to return a *success* carrying
 *      `status: "failed"`, so every caller that branched on the error channel
 *      thought it had worked — `ClaudeCliInstaller` had to ignore the result
 *      outright, and the settings button reported a OpenCode update it never
 *      installed. The recorded `updateState` and the returned channel now say
 *      the same thing.
 *
 * The update subprocess inherits this server's environment and nothing else. In
 * particular it is never handed the sealed GitHub token from
 * `secrets/GithubTokenVault`: these are arbitrary third-party binaries (npm
 * lifecycle scripts, Homebrew formulae, a vendor's own installer), the token is
 * a CH3 org credential rather than a personal one, and `opencode upgrade`
 * ignores `GITHUB_TOKEN`/`GH_TOKEN` anyway — so it would buy nothing for the
 * one updater whose rate limit prompted the question. Any future exception is a
 * per-mechanism decision that needs its own justification here.
 *
 * **That reasoning got stronger, not weaker, when the token gained write
 * permissions.** It now carries `Contents`, `Issues` and `Pull requests` at
 * read and write over five CH3 repositories, so handing it to a subprocess
 * is handing that subprocess the ability to push branches, not merely to read.
 * `contribution/GithubContributions` exists precisely so that the one feature
 * needing those permissions gets them **inside this server process**, where the
 * call is typed and the author is stamped, rather than by exporting `GH_TOKEN`
 * into something's environment.
 *
 * @module providerMaintenanceRunner
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@ch3tools/contracts";
import { resolveSpawnCommand } from "@ch3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "./providerMaintenance.ts";
import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { resolveProviderUpdateOutcome } from "./providerUpdateOutcome.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("ch3/provider/providerMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        // Resolve the executable for the host platform before spawning. On
        // Windows the update tools are batch shims (e.g. `npm` -> `npm.cmd`),
        // which a bare ChildProcess.spawn cannot launch (spawn npm ENOENT);
        // resolveSpawnCommand finds the real `.cmd` and routes it through the
        // shell. On Linux/macOS (incl. the WSL backend) this is a no-op.
        const resolved = yield* resolveSpawnCommand(input.command, input.args);
        const child = yield* input.spawner
          .spawn(ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderMaintenanceCommandError({
                  message: `Failed to run update command ${input.command}: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: cause instanceof Error ? cause.message : "Update command failed to run.",
                cause,
              }),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function hasCommandFailed(result: ProviderMaintenanceCommandResult): boolean {
  return result.timedOut || (result.exitCode !== null && result.exitCode !== 0);
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const runMaintenanceCommand = (command: string, args: ReadonlyArray<string>) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command,
      args,
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) => {
        const instanceIds: Array<ProviderInstanceId> = [];
        for (const candidate of providers) {
          if (candidate.driver === provider && candidate.instanceId === instanceId) {
            instanceIds.push(candidate.instanceId);
          }
        }
        return instanceIds;
      }),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? providerRegistry.refreshInstance(instanceId)
          : Effect.forEach(
              instanceIds,
              (instanceId) => providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map(
            (verifiedProviders): VerifiedProviderRefresh => ({
              providers,
              verifiedProviders,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
      });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        // Records the outcome and hands it back, so the one decision about
        // success and failure is made in a single place below rather than at
        // every branch that finishes an update.
        const finish = (state: ServerProviderUpdateState) =>
          setUpdateState(state).pipe(Effect.map((providers) => ({ providers, state })));
        const startedAtRef = yield* Ref.make<string | null>(null);

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* () {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            yield* setUpdateState(
              makeUpdateState({
                status: "running",
                startedAt,
                finishedAt: null,
                message: "Updating provider.",
              }),
            );

            // The version the person was looking at when they pressed the
            // button. Read under the command lock so a serialized second update
            // compares against what the first one left behind.
            const snapshotBefore = (yield* providerRegistry.getProviders).find(
              (candidate) => candidate.instanceId === instanceId,
            );

            const result = yield* runMaintenanceCommand(update.executable, update.args);
            const finishedAt = yield* nowIso;
            // A non-zero exit is already the answer; re-probing a provider that
            // never ran its updater only costs a `--version` to learn nothing.
            const verifiedProviders = hasCommandFailed(result)
              ? []
              : (yield* verifyRefreshedProvider(provider, capabilities, instanceId))
                  .verifiedProviders;
            const snapshotAfter = verifiedProviders[0];
            const outcome = resolveProviderUpdateOutcome({
              command: result,
              probe: hasCommandFailed(result)
                ? null
                : {
                    verified: snapshotAfter !== undefined,
                    versionBefore: snapshotBefore?.version ?? null,
                    versionAfter: snapshotAfter?.version ?? null,
                    installedBefore: snapshotBefore?.installed ?? false,
                    installedAfter: snapshotAfter?.installed ?? false,
                    advisoryStatus: snapshotAfter?.versionAdvisory?.status ?? "unknown",
                  },
              manualCommand: update.command,
            });

            return yield* finish(
              makeUpdateState({
                status: outcome.status,
                startedAt,
                finishedAt,
                message: outcome.message,
                output: commandOutput(result),
              }),
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            const failure = Cause.squash(cause);
            const startedAt = yield* Ref.get(startedAtRef);
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: failure instanceof Error ? failure.message : "Update command failed.",
                output: null,
              }),
            );
          },
        );

        const settled = yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
        // The recorded state is the whole truth, so the caller's channel must
        // agree with it. Returning a success that carries `status: "failed"` is
        // what made `ClaudeCliInstaller` ignore this runner's result entirely,
        // and what let the settings button report a OpenCode update it never
        // installed. `unchanged` stays a success: nothing was owed, or nothing
        // could be verified, and neither is an error to report.
        if (settled.state.status === "failed") {
          return yield* new ServerProviderUpdateError({
            provider,
            reason: settled.state.message ?? "The provider update did not finish.",
          });
        }
        return { providers: settled.providers } satisfies ServerProviderUpdatedPayload;
      },
    );

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
