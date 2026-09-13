import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import { waitForHttpReady } from "../backend/DesktopBackendManager.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

// Generous: the network stack and the child both need a moment after wake,
// and the probe retries internally until this elapses.
const RESUME_PROBE_TIMEOUT = Duration.seconds(15);

const handleResume = (
  electronWindow: ElectronWindow.ElectronWindow["Service"],
  pool: DesktopBackendPool.DesktopBackendPool["Service"],
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("System resumed from sleep; nudging renderers and probing the backend.");
    // Renderers first: their reconnect races the backend's own wake-up, and
    // the connection supervisor retries on its own if the first dial loses.
    yield* electronWindow.sendAll(IpcChannels.POWER_RESUME_CHANNEL);
    const primary = yield* pool.primary;
    const config = yield* primary.currentConfig;
    if (Option.isNone(config)) {
      return;
    }
    yield* waitForHttpReady({ ...config.value, timeout: RESUME_PROBE_TIMEOUT }).pipe(
      Effect.tap(() =>
        Effect.logInfo("Primary backend answered its readiness probe after resume."),
      ),
      Effect.catch((error) =>
        // The exit-driven restart loop remains the recovery path for a dead
        // child; a wedged-but-alive one at least becomes visible here.
        Effect.logError("Primary backend did not answer its readiness probe after resume.", {
          error,
        }),
      ),
    );
  });

/**
 * Resume-after-sleep used to be a dead zone: renderers sat out their
 * reconnect backoff on half-open sockets and nothing looked at the server
 * child. On `powerMonitor` resume this broadcasts a reconnect nudge to every
 * window and health-checks the primary backend's readiness endpoint.
 */
export const layer: Layer.Layer<
  never,
  never,
  | DesktopBackendPool.DesktopBackendPool
  | ElectronPowerMonitor.ElectronPowerMonitor
  | ElectronWindow.ElectronWindow
  | HttpClient.HttpClient
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    // Sliding(1): a burst of resume events (some hardware fires several)
    // collapses into one recovery pass.
    const resumes = yield* Queue.sliding<void>(1);
    yield* powerMonitor.onSimpleEvent("resume", () => Queue.offerUnsafe(resumes, undefined));
    yield* Stream.fromQueue(resumes).pipe(
      Stream.runForEach(() => handleResume(electronWindow, pool)),
      Effect.forkScoped,
    );
  }),
);
