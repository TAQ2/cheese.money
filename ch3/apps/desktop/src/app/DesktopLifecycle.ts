import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopAgentPowerGuard from "../power/DesktopAgentPowerGuard.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedErrorClass<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

/**
 * @effect-expect-leaking DesktopEnvironment | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronTheme
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<void, never, Scope.Scope | DesktopLifecycleRuntimeServices>;
  }
>()("@ch3tools/desktop/app/DesktopLifecycle") {}

const { logInfo: logLifecycleInfo, logError: logLifecycleError } =
  makeComponentLogger("desktop-lifecycle");

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (): Effect.fn.Return<
    void,
    never,
    DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow
  > {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.flushMainWindowBounds;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      // A quit already under way — a process signal that finished shutting
      // down and is now asking Electron to leave — is not a question. Neither
      // is the installer's quit: install.sh quits this app itself, nobody is
      // there to answer a dialog, and it gives up after ninety seconds having
      // installed nothing.
      if (yield* Ref.get(state.quitting)) {
        yield* logLifecycleInfo("before-quit received while already quitting");
        return true;
      }
      const installingUpdate = yield* Ref.get(state.installingUpdate);
      // ⌘Q sits beside ⌘W. A quit with an agent mid-turn used to be silent:
      // the backend got SIGTERM and two seconds, and the turn was gone. The
      // power guard already knows whether a run is live, so ask before
      // killing it — the way Terminal asks about a running process. Read as
      // optional services rather than required ones: the guard is provided
      // beneath this layer in `main.ts`, and a context without it (a test,
      // a shell with no renderer yet) has no run to protect.
      const powerGuard = yield* Effect.serviceOption(DesktopAgentPowerGuard.DesktopAgentPowerGuard);
      const dialog = yield* Effect.serviceOption(ElectronDialog.ElectronDialog);
      const electronWindow = yield* Effect.serviceOption(ElectronWindow.ElectronWindow);
      if (
        !installingUpdate &&
        Option.isSome(powerGuard) &&
        Option.isSome(dialog) &&
        Option.isSome(electronWindow) &&
        (yield* powerGuard.value.isHolding)
      ) {
        const confirmed = yield* dialog.value
          .confirm({
            owner: yield* electronWindow.value.focusedMainOrFirst,
            message:
              "An agent is still working. A Claude conversation keeps running and CH3 reconnects to it on the next launch; a Codex or OpenCode turn is interrupted.\n\nQuit CH3 anyway?",
          })
          .pipe(Effect.orElseSucceed(() => true));
        if (!confirmed) {
          yield* logLifecycleInfo("before-quit declined: agent run live");
          return false;
        }
      }
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWait();
      return true;
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  )
    // A shutdown that threw still quits, as before: it is the only way out.
    .then(
      (proceed) => proceed,
      () => true,
    )
    .then((proceed) => {
      if (!proceed) return;
      markQuitAllowed();
      void runEffect(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.quit;
        }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
      );
    });
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
): void {
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logLifecycleInfo("process signal received", { signal });
      yield* requestDesktopShutdownAndWait();
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* Ref.set(state.quitting, true);
      yield* requestDesktopShutdownAndWait();
      if (environment.isDevelopment) {
        yield* electronApp.exit(75);
        return;
      }
      yield* electronApp.relaunch({
        execPath: process.execPath,
        args: process.argv.slice(1),
      });
      yield* electronApp.exit(0);
    }).pipe(
      Effect.catchCause((cause) => {
        const error = new DesktopLifecycleRelaunchError({ reason, cause });
        return logLifecycleError(error.message, { error });
      }),
      Effect.forkDetach,
      Effect.asVoid,
    );
  }),
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleRuntimeServices>();
    const runEffect = Effect.runPromiseWith(context);
    let quitAllowed = false;
    let updaterQuitAllowed = false;
    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      updaterQuitAllowed = true;
      void runEffect(
        logLifecycleInfo("allowing updater-controlled quit").pipe(
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runEffect,
        () => quitAllowed || updaterQuitAllowed,
        () => {
          quitAllowed = true;
        },
      );
    });
    // A child process dying used to be invisible: the GPU process, a utility
    // process or a renderer would go, and the only record was whatever the
    // trace file happened to have flushed. The reason and exit code are the
    // two fields that separate "out of memory" from "killed" from "crashed".
    yield* electronApp.on(
      "child-process-gone",
      (_event: Electron.Event, details: Electron.Details) => {
        void runEffect(
          logLifecycleError("a child process is gone", {
            processType: details.type,
            reason: details.reason,
            exitCode: details.exitCode,
            ...(details.serviceName === undefined ? {} : { serviceName: details.serviceName }),
            ...(details.name === undefined ? {} : { name: details.name }),
          }),
        );
      },
    );
    yield* electronApp.on("activate", () => {
      void runEffect(desktopWindow.activate.pipe(Effect.withSpan("desktop.lifecycle.activate")));
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const state = yield* DesktopState.DesktopState;
          if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
            yield* app.quit;
          }
        }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
      );
    });

    if (environment.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
