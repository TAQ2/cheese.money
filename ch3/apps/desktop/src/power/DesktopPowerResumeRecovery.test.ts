import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopPowerResumeRecovery from "./DesktopPowerResumeRecovery.ts";

const testConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  extendEnv: true,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    ch3Home: "/tmp/ch3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

const makeBackendInstance = (
  config: Option.Option<DesktopBackendManager.DesktopBackendStartConfig>,
): DesktopBackendManager.DesktopBackendInstance => ({
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("Primary"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(config),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(1234),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
});

const makeWindowLayer = (sent: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(
    ElectronWindow.ElectronWindow,
    // Only sendAll is exercised; the rest fail loudly if reached.
    ElectronWindow.ElectronWindow.of({
      sendAll: (channel: string) => Ref.update(sent, (current) => [...current, channel]),
    } as unknown as ElectronWindow.ElectronWindow["Service"]),
  );

const makePowerMonitorLayer = (
  resumeListener: Ref.Ref<Option.Option<() => void>>,
): Layer.Layer<ElectronPowerMonitor.ElectronPowerMonitor> =>
  Layer.succeed(
    ElectronPowerMonitor.ElectronPowerMonitor,
    ElectronPowerMonitor.ElectronPowerMonitor.of({
      isOnBatteryPower: Effect.succeed(false),
      getSystemIdleTime: Effect.succeed(0),
      getSystemIdleState: () => Effect.succeed("active"),
      getCurrentThermalState: Effect.succeed("nominal"),
      onSimpleEvent: (eventName, listener) =>
        eventName === "resume" ? Ref.set(resumeListener, Option.some(listener)) : Effect.void,
      onThermalStateChange: () => Effect.void,
      onSpeedLimitChange: () => Effect.void,
    }),
  );

describe("DesktopPowerResumeRecovery", () => {
  it.effect("nudges renderers and probes the backend on resume", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<string>>([]);
      const resumeListener = yield* Ref.make<Option.Option<() => void>>(Option.none());
      const probedUrls = yield* Ref.make<ReadonlyArray<string>>([]);
      const probed = yield* Deferred.make<void>();
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(probedUrls, (current) => [...current, request.url]).pipe(
            Effect.andThen(Deferred.succeed(probed, undefined)),
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const listener = yield* Ref.get(resumeListener);
        assert.isTrue(Option.isSome(listener));
        if (Option.isSome(listener)) {
          listener.value();
        }
        yield* Deferred.await(probed).pipe(Effect.timeout(Duration.seconds(5)));

        assert.deepEqual(yield* Ref.get(sent), [IpcChannels.POWER_RESUME_CHANNEL]);
        const urls = yield* Ref.get(probedUrls);
        assert.equal(urls.length, 1);
        assert.include(urls[0], "/.well-known/ch3/environment");
      }).pipe(
        Effect.provide(
          DesktopPowerResumeRecovery.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                makeWindowLayer(sent),
                makePowerMonitorLayer(resumeListener),
                DesktopBackendPool.layerTest([makeBackendInstance(Option.some(testConfig))]),
                httpLayer,
              ),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("skips the probe when the primary backend has no config yet", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<string>>([]);
      const resumeListener = yield* Ref.make<Option.Option<() => void>>(Option.none());
      const probedUrls = yield* Ref.make<ReadonlyArray<string>>([]);
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(probedUrls, (current) => [...current, request.url]).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const listener = yield* Ref.get(resumeListener);
        assert.isTrue(Option.isSome(listener));
        if (Option.isSome(listener)) {
          listener.value();
        }
        // Drain the forked recovery pass.
        for (let attempt = 0; attempt < 10; attempt += 1) {
          yield* Effect.yieldNow;
        }

        assert.deepEqual(yield* Ref.get(sent), [IpcChannels.POWER_RESUME_CHANNEL]);
        assert.deepEqual(yield* Ref.get(probedUrls), []);
      }).pipe(
        Effect.provide(
          DesktopPowerResumeRecovery.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                makeWindowLayer(sent),
                makePowerMonitorLayer(resumeListener),
                DesktopBackendPool.layerTest([makeBackendInstance(Option.none())]),
                httpLayer,
              ),
            ),
          ),
        ),
      );
    }),
  );
});
