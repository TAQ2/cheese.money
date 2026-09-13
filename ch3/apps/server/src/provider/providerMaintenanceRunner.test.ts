import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@ch3tools/contracts";
import { ServerProviderUpdateError } from "@ch3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment, HostProcessPlatform } from "@ch3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@ch3tools/shared/shell";

import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import {
  makeProviderMaintenanceCapabilities,
  ProviderVersionCache,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();

// Pin a non-win32 platform so `resolveSpawnCommand` is a no-op and the raw
// `{ command, args }` assertions below hold deterministically on any host
// (including Windows). Windows-specific resolution is covered by the dedicated
// win32 case at the end of this suite.
const NonWindowsPlatform = Layer.succeed(HostProcessPlatform, "linux");

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === CURSOR_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "cursor-agent",
      updateArgs: ["update"],
      updateLockKey: "cursor-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseCursorProvider: ServerProvider = {
  ...baseProvider,
  instanceId: CURSOR_INSTANCE_ID,
  driver: CURSOR_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const latestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
  // The real registry re-runs the provider's `--version` on refresh, so a
  // successful update shows up as a moved version. Modelling that is the whole
  // point of these tests: an update is judged by what the binary reports
  // afterwards, never by the command's exit code.
  options?: { readonly refreshedVersion?: string },
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });

    const refreshInstance = (instanceId: ProviderInstanceId) =>
      options?.refreshedVersion === undefined
        ? Ref.get(providersRef)
        : Ref.updateAndGet(providersRef, (providers) =>
            providers.map((candidate) =>
              candidate.instanceId === instanceId
                ? { ...candidate, version: options.refreshedVersion ?? null }
                : candidate,
            ),
          );

    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance,
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    return {
      registry,
      updateStatesRef,
    };
  });
}

const makeTestRunner = (registry: ProviderRegistryShape) =>
  Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry, registry),
            Layer.succeed(ProviderVersionCache, new Map()),
          ),
        ),
      ),
    ),
  );

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(
        { ...baseCursorProvider, version: "1.0.0" },
        { refreshedVersion: "1.1.0" },
      );
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CURSOR_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "cursor-agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "succeeded"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("uses the resolved provider capabilities when choosing the update executable", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.0.14",
          latestVersion: "2.1.123",
          updateCommand: "bun i -g @anthropic-ai/claude-code@latest",
          canUpdate: true,
          checkedAt: "2026-04-30T12:00:00.000Z",
          message: "Update available.",
        },
      });
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "bun",
              updateArgs: ["i", "-g", "@openai/codex@latest"],
              updateLockKey: "bun-global",
            }),
          ),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "bun",
          args: ["i", "-g", "@openai/codex@latest"],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "runs update commands through Effect ChildProcess when no test runner is injected",
    () => {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(
          { ...baseProvider, version: "1.0.0" },
          { refreshedVersion: "1.1.0" },
        );
        const runner = yield* makeTestRunner(registry);

        const result = yield* runner.updateProvider(CODEX_DRIVER);

        assert.deepStrictEqual(calls, [
          {
            command: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
          },
        ]);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer((command, args) => {
              calls.push({ command, args });
              return { stdout: "updated" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("updates a single provider instance without touching sibling instances", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const personalInstanceId = ProviderInstanceId.make("codex_personal");
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const refreshedInstanceIds: Array<ProviderInstanceId> = [];
      const { registry } = yield* makeRegistry(
        [
          {
            ...baseProvider,
            instanceId: personalInstanceId,
            version: "0.124.0-alpha.3",
          },
          {
            ...baseProvider,
            instanceId: workInstanceId,
            version: "0.124.0-alpha.3",
          },
        ],
        { refreshedVersion: "0.124.0-alpha.4" },
      );
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex-instance-test",
              updateExecutable: "vp",
              updateArgs: ["i", "-g", "@openai/codex"],
              updateLockKey: "vite-plus-global",
            }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => assert.strictEqual(instanceId, personalInstanceId))),
          ),
        refreshInstance: (instanceId) =>
          registry.refreshInstance(instanceId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                refreshedInstanceIds.push(instanceId);
              }),
            ),
          ),
      });

      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        instanceId: personalInstanceId,
      });

      assert.deepStrictEqual(calls, [
        {
          command: "vp",
          args: ["i", "-g", "@openai/codex"],
        },
      ]);
      assert.deepStrictEqual(refreshedInstanceIds, [personalInstanceId]);
      assert.strictEqual(result.providers[0]?.instanceId, personalInstanceId);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(result.providers[1]?.instanceId, workInstanceId);
      assert.strictEqual(result.providers[1]?.updateState, undefined);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.124.0-alpha.3"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("fails with the command's own reason, and records its output", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const exit = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);

      assert.strictEqual(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);
        if (isServerProviderUpdateError(error)) {
          assert.include(error.reason, "exited with code 1");
          assert.include(error.reason, "permission denied");
          assert.include(error.reason, "not allowed to write");
        }
      }

      const updateState = (yield* registry.getProviders)[0]?.updateState;
      assert.strictEqual(updateState?.status, "failed");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => ({
            stderr: "npm ERR! code EACCES\nnpm ERR! permission denied",
            code: 1,
          })),
        ),
      ),
    ),
  );

  it.effect("fails when the command exits 0 but the version never moves", () =>
    // The OpenCode defect, exactly: `opencode upgrade` prints GitHub's 403 and
    // returns 0, so only the re-probed version can tell anyone it did nothing.
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseOpenCodeProvider,
        installed: true,
        version: "1.18.23",
      });
      const updater = yield* makeTestRunner(registry);

      const exit = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.exit);

      assert.strictEqual(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);
        if (isServerProviderUpdateError(error)) {
          // What happened, in the updater's own words...
          assert.include(error.reason, "still on 1.18.23");
          assert.include(error.reason, "403 GET https://api.github.com");
          // ...and what to do about it.
          assert.include(error.reason, "hourly quota");
        }
      }

      const updateState = (yield* registry.getProviders)[0]?.updateState;
      assert.strictEqual(updateState?.status, "failed");
      assert.include(updateState?.output ?? "", "api.github.com");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("1.18.24"),
          mockSpawnerLayer(() => ({
            stdout: "● Using method: curl",
            stderr:
              "Error: Unexpected error\nStatusCode: non 2xx status code (403 GET https://api.github.com/repos/anomalyco/opencode/releases/latest)",
          })),
        ),
      ),
    ),
  );

  it.effect("reports the version it moved from and to", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry(
        { ...baseOpenCodeProvider, installed: true, version: "1.18.23" },
        { refreshedVersion: "1.18.24" },
      );
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(OPENCODE_DRIVER);

      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(
        result.providers[0]?.updateState?.message,
        "Updated from 1.18.23 to 1.18.24.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("1.18.24"),
          mockSpawnerLayer(() => ({ stdout: "upgraded" })),
        ),
      ),
    ),
  );

  it.effect("does not call an already-current provider a failure", () =>
    // `brew upgrade` and `npm install -g pkg@latest` both exit 0 having done
    // nothing when there is nothing to do. Nothing moved, nothing was owed.
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        installed: true,
        version: "1.18.24",
      });
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);

      assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
      assert.include(result.providers[0]?.updateState?.message ?? "", "already up to date");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("1.18.24"),
          mockSpawnerLayer(() => ({ stdout: "changed 0 packages" })),
        ),
      ),
    ),
  );

  it.effect("prevents concurrent updates for the same provider", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started);

      const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(second), true);
      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);
        if (isServerProviderUpdateError(error)) {
          assert.include(error.reason, "already running");
        }
      }

      releaseLatch.resolve();
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("serializes different providers that share the same update lock key", () => {
    const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
              updateExecutable: "npm",
              updateArgs:
                provider === OPENCODE_DRIVER
                  ? ["install", "-g", "opencode-ai@latest"]
                  : ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
            }),
          ),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstStarted);

      const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
      let providersWhileQueued: ReadonlyArray<ServerProvider> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        providersWhileQueued = yield* registry.getProviders;
        const queuedStatus = providersWhileQueued.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;
        if (queuedStatus === "queued") {
          break;
        }
        yield* Effect.yieldNow;
      }
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      assert.strictEqual(
        providersWhileQueued.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );

      releaseFirstLatch.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(calls, [
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            if (calls.length === 1) {
              firstStartedLatch.resolve();
              return {
                stdout: "updated",
                exitCode: Effect.promise(() => releaseFirst).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("accepts arbitrary driver-provided update lock keys", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(
        { ...baseProvider, version: "1.0.0" },
        { refreshedVersion: "1.1.0" },
      );
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "unknown-lock-key",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(
          { ...baseProvider, version: "1.0.0" },
          { refreshedVersion: "1.1.0" },
        );
        let blockQueuedState = true;
        const queuedStateWrittenLatch: { resolve: () => void } = { resolve: () => {} };
        const releaseQueuedStateLatch: { resolve: () => void } = { resolve: () => {} };
        const queuedStateWritten = new Promise<void>((resolve) => {
          queuedStateWrittenLatch.resolve = resolve;
        });
        const releaseQueuedState = new Promise<void>((resolve) => {
          releaseQueuedStateLatch.resolve = resolve;
        });

        const updater = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: Effect.fn(
            "providerMaintenanceRunner.test.blockQueuedState",
          )(function* (input) {
            const providers = yield* registry.setProviderMaintenanceActionState(input);
            if (input.state?.status === "queued" && blockQueuedState) {
              queuedStateWrittenLatch.resolve();
              yield* Effect.promise(() => releaseQueuedState);
            }
            return providers;
          }),
        });

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => queuedStateWritten);
        blockQueuedState = false;

        yield* Fiber.interrupt(first);
        releaseQueuedStateLatch.resolve();

        const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(second), true);
        if (Exit.isSuccess(second)) {
          assert.strictEqual(second.value.providers[0]?.updateState?.status, "succeeded");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("resolves npm to a .cmd shim and routes through the shell on win32", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean | string | undefined;
    }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(
        { ...baseProvider, version: "1.0.0" },
        { refreshedVersion: "1.1.0" },
      );
      const runner = yield* makeTestRunner(registry);

      const result = yield* runner.updateProvider(CODEX_DRIVER);

      // On win32, resolveSpawnCommand resolves `npm` to the `.cmd` shim and
      // routes the spawn through cmd.exe (shell: true), escaping every arg.
      assert.strictEqual(captured.length, 1);
      const call = captured[0];
      assert.ok(call, "expected the spawner to be invoked once");
      // The resolved command is the escaped `.cmd` path. Asserting the precise
      // escaped string is brittle, so verify it carries the resolved shim and
      // that shell mode was used.
      assert.match(call.command, /npm\.cmd/i);
      assert.strictEqual(call.shell, true);
      // Args are escaped for cmd.exe shell mode (each quoted) but still carry
      // the original install command (`install -g @openai/codex@latest`) in order.
      assert.strictEqual(call.args.length, 3);
      assert.match(call.args[0] ?? "", /install/);
      assert.match(call.args[1] ?? "", /-g/);
      assert.match(call.args[2] ?? "", /@openai\/codex@latest/);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessEnvironment, {
            PATH: "C:\\fake\\npm",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command) =>
            command === "npm" ? "C:\\fake\\npm\\npm.cmd" : undefined,
          ),
          latestVersionHttpClient("0.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const childProcess = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options: { readonly shell?: boolean | string | undefined };
              };
              captured.push({
                command: childProcess.command,
                args: childProcess.args,
                shell: childProcess.options.shell,
              });
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });
});
