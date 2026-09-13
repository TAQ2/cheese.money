/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every instance in these tests is configured with `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real `codex` / `claude` / `agent` / `grok` / `opencode`
 * binaries. That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CursorSettings,
  type GrokSettings,
  type CodexSettings,
  type OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@ch3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { ProviderDriverError } from "../Errors.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  accountFailoverEnabled: false,
  accountRotationEnabled: true,
  accountRiddleKeepWarmEnabled: true,
  accountFailoverThresholdPercent: 95,
  customModels: [],
  launchArgs: "",
  artifactToolEnabled: false,
  chromeIntegrationEnabled: false,
  claudeAiConnectorsEnabled: false,
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  usageMetricsCommand: "",
  customModels: [],
  ...overrides,
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `NodeServices.layer` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).not.toBe(work!.adapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      expect(personalSnapshot.continuation?.groupKey).toBe(
        "codex:home:/home/julius/.codex_personal",
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  // All drivers need `NodeServices` (ChildProcessSpawner + FileSystem +
  // Path). `OpenCodeDriver.create` additionally yields `OpenCodeRuntime`
  // at construction time, so we wire `OpenCodeRuntimeLive` into the stack.
  // `OpenCodeRuntimeLive` bundles its own `NetService.layer` via
  // `Layer.provide`, so the only external requirement it still exposes is
  // `ChildProcessSpawner` — resolved here by piping it through
  // `provideMerge(NodeServices.layer)`.
  //
  // The nested `provideMerge`s read bottom-up: `NodeServices.layer`
  // provides `OpenCodeRuntimeLive`'s deps while keeping its own outputs
  // surfaced; that merged layer then provides `ServerConfig.layerTest`'s
  // `FileSystem` dep while keeping everything else surfaced to the test.
  const infraLayer = OpenCodeRuntimeLive.pipe(
    // The vault the runtime spends from and the driver reports failures to.
    // Locked here, as it is at boot before anyone has signed in.
    Layer.provideMerge(NodeServices.layer),
  );
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-all-drivers-test",
  }).pipe(
    Layer.provideMerge(infraLayer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");
      const cursorId = ProviderInstanceId.make("cursor_default");
      const grokId = ProviderInstanceId.make("grok_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");
      const cursorDriverKind = ProviderDriverKind.make("cursor");
      const grokDriverKind = ProviderDriverKind.make("grok");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
        [cursorId]: {
          driver: cursorDriverKind,
          displayName: "Cursor",
          enabled: false,
          config: makeCursorConfig({}),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver, ClaudeDriver, CursorDriver, GrokDriver, OpenCodeDriver],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(5);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, cursorId, grokId, openCodeId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const openCode = yield* registry.getInstance(openCodeId);
      const cursor = yield* registry.getInstance(cursorId);
      const grok = yield* registry.getInstance(grokId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(cursor?.driverKind).toBe(cursorDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(openCode?.displayName).toBe("OpenCode");
      expect(cursor?.displayName).toBe("Cursor");
      expect(grok?.displayName).toBe("Grok");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `adapter` / `textGeneration` / `snapshot` are all
      // distinct references even when two instances happen to share a
      // trait (e.g. they all use a stub-or-real
      // `textGeneration`; they must still be different object values).
      const adapters = [
        codex!.adapter,
        claude!.adapter,
        openCode!.adapter,
        cursor!.adapter,
        grok!.adapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        openCode!.textGeneration,
        cursor!.textGeneration,
        grok!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        openCode!.snapshot,
        cursor!.snapshot,
        grok!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe("claude:home:/home/julius/.claude-work");

      const cursorSnapshot = yield* cursor!.snapshot.getSnapshot;
      expect(cursorSnapshot.instanceId).toBe(cursorId);
      expect(cursorSnapshot.driver).toBe(cursorDriverKind);
      expect(cursorSnapshot.enabled).toBe(false);
      expect(cursorSnapshot.continuation?.groupKey).toBe(
        `${cursorDriverKind}:instance:${cursorId}`,
      );

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );
    }).pipe(Effect.provide(testLayer)),
  );
});

/**
 * The instance swap is atomic, or an account switch reaches the wrong process.
 *
 * `reconcile` closes an outgoing instance's scope before it publishes the
 * replacement. Closing a scope does not disarm the instance: its adapter, its
 * session map and the environment it spawns CLI processes with are plain
 * closures. A lookup landing in that window used to be handed the retired
 * object, which happily started a real process under the settings the user had
 * just changed away from — and, because the adapter's shutdown finalizer had
 * already run, nothing was ever left to stop it.
 *
 * These tests drive that window deliberately: a fake driver whose `create`
 * parks on a latch holds a rebuild open at exactly the wrong moment.
 */
describe("ProviderInstanceRegistryLive — atomic instance swap", () => {
  const mainId = ProviderInstanceId.make("fake_main");
  const otherId = ProviderInstanceId.make("fake_other");
  const fakeDriverKind = ProviderDriverKind.make("fakeDriver");

  interface FakeConfig {
    readonly homePath: string;
  }

  // The instance is identified in assertions by the home path it was built
  // from, which is what a Claude account switch actually moves.
  const makeFakeInstance = (instanceId: ProviderInstanceId, homePath: string): ProviderInstance =>
    ({
      instanceId,
      driverKind: fakeDriverKind,
      continuationIdentity: {
        driverKind: fakeDriverKind,
        continuationKey: `fake:home:${homePath}`,
      },
      displayName: homePath,
      enabled: true,
      snapshot: {} as ProviderInstance["snapshot"],
      adapter: {} as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    }) satisfies ProviderInstance;

  /**
   * A driver whose `create` runs a test-supplied hook first, so a test can
   * hold the rebuild open between "outgoing scope closed" and "new map
   * published".
   */
  const makeFakeDriver = (
    onCreate: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly homePath: string;
    }) => Effect.Effect<void, ProviderDriverError>,
  ): ProviderDriver<FakeConfig> => ({
    driverKind: fakeDriverKind,
    metadata: { displayName: "Fake" },
    configSchema: Schema.Struct({ homePath: Schema.String }),
    defaultConfig: () => ({ homePath: "" }),
    create: (input) =>
      Effect.gen(function* () {
        yield* onCreate({ instanceId: input.instanceId, homePath: input.config.homePath });
        return makeFakeInstance(input.instanceId, input.config.homePath);
      }),
  });

  const configMapOf = (
    entries: ReadonlyArray<readonly [ProviderInstanceId, string]>,
  ): ProviderInstanceConfigMap =>
    Object.fromEntries(
      entries.map(([instanceId, homePath]) => [
        instanceId,
        { driver: fakeDriverKind, enabled: true, config: { homePath } },
      ]),
    );

  /**
   * Boot with one instance, then hold the rebuild of it open. Returns the
   * registry plus the fibre running the blocked `reconcile`, parked inside
   * `create` — the exact window the race lived in.
   */
  const holdRebuildOpen = (input: {
    readonly next: ProviderInstanceConfigMap;
    readonly release: Latch.Latch;
    readonly failRebuild?: boolean;
  }) =>
    Effect.gen(function* () {
      const createStarted = yield* Latch.make(false);
      let creates = 0;
      const driver = makeFakeDriver((created) =>
        Effect.gen(function* () {
          creates += 1;
          // The boot build must not block; only the rebuild is held open.
          if (creates === 1) return;
          yield* createStarted.open;
          yield* input.release.await;
          if (input.failRebuild === true) {
            return yield* new ProviderDriverError({
              driver: fakeDriverKind,
              instanceId: created.instanceId,
              detail: "rebuild refused by the test",
            });
          }
        }),
      );

      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: configMapOf([[mainId, "/home/a"]]),
      });
      expect((yield* registry.getInstance(mainId))?.displayName).toBe("/home/a");

      const reconciling = yield* Effect.forkChild(mutator.reconcile(input.next), {
        startImmediately: true,
      });
      // Past this point the outgoing scope is closed and the new map has not
      // been published: the window.
      yield* createStarted.await;
      return { registry, reconciling } as const;
    });

  it.effect("hands a lookup during a rebuild the new instance, never the retired one", () =>
    Effect.gen(function* () {
      const release = yield* Latch.make(false);
      const { registry, reconciling } = yield* holdRebuildOpen({
        next: configMapOf([[mainId, "/home/b"]]),
        release,
      });

      const lookup = yield* Effect.forkChild(registry.getInstance(mainId), {
        startImmediately: true,
      });
      yield* release.open;
      yield* Fiber.join(reconciling);

      const found = yield* Fiber.join(lookup);
      expect(found?.displayName).toBe("/home/b");
    }).pipe(Effect.scoped),
  );

  it.effect("releases a waiter when the rebuild fails, and never falls back to the corpse", () =>
    Effect.gen(function* () {
      const release = yield* Latch.make(false);
      const { registry, reconciling } = yield* holdRebuildOpen({
        next: configMapOf([[mainId, "/home/b"]]),
        release,
        failRebuild: true,
      });

      const lookup = yield* Effect.forkChild(registry.getInstance(mainId), {
        startImmediately: true,
      });
      yield* release.open;
      yield* Fiber.join(reconciling);

      // A driver that refuses to build becomes an unavailable shadow, so the
      // id resolves to nothing at all — the retired instance is not a
      // fallback.
      expect(yield* Fiber.join(lookup)).toBeUndefined();
      expect((yield* registry.listUnavailable).map((shadow) => shadow.instanceId)).toEqual([
        mainId,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("releases a waiter when the rebuild is interrupted", () =>
    Effect.gen(function* () {
      const never = yield* Latch.make(false);
      const { registry, reconciling } = yield* holdRebuildOpen({
        next: configMapOf([[mainId, "/home/b"]]),
        release: never,
      });

      const lookup = yield* Effect.forkChild(registry.getInstance(mainId), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(reconciling);

      // The interrupted reconcile had already closed the outgoing scope, so
      // the id is retired rather than restored: a loud "not configured" beats
      // a live handle on a process nobody owns.
      expect(yield* Fiber.join(lookup)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("does not hang a lookup for an instance that is being removed", () =>
    Effect.gen(function* () {
      const release = yield* Latch.make(false);
      const { registry, reconciling } = yield* holdRebuildOpen({
        // `fake_main` disappears; `fake_other` is the build that blocks, so
        // the removal is genuinely still in flight when the lookup lands.
        next: configMapOf([[otherId, "/home/c"]]),
        release,
      });

      const lookup = yield* Effect.forkChild(registry.getInstance(mainId), {
        startImmediately: true,
      });
      yield* release.open;
      yield* Fiber.join(reconciling);

      expect(yield* Fiber.join(lookup)).toBeUndefined();
      expect((yield* registry.getInstance(otherId))?.displayName).toBe("/home/c");
    }).pipe(Effect.scoped),
  );

  it.effect("gives up on a rebuild that never finishes rather than parking forever", () =>
    Effect.gen(function* () {
      const never = yield* Latch.make(false);
      const { registry, reconciling } = yield* holdRebuildOpen({
        next: configMapOf([[mainId, "/home/b"]]),
        release: never,
      });

      const lookup = yield* Effect.forkChild(registry.getInstance(mainId), {
        startImmediately: true,
      });
      // The wait is bounded: a lookup that never returned would wedge the
      // single fibre draining every provider intent for the environment.
      yield* TestClock.adjust(Duration.seconds(30));
      expect(yield* Fiber.join(lookup)).toBeUndefined();

      yield* Fiber.interrupt(reconciling);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
