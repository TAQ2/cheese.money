import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAgentPowerGuard from "../power/DesktopAgentPowerGuard.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as Option from "effect/Option";

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("CH3"),
        whenReady: Effect.void,
        quit: Effect.void,
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        requestSingleInstanceLock: Effect.succeed(true),
        getAppMetrics: Effect.succeed([]),
        isDefaultProtocolClient: () => Effect.succeed(false),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        setDockIcon: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);

      const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
        shouldUseDarkColors: Effect.succeed(false),
        setSource: () => Effect.void,
        onUpdated: () => Effect.void,
      });

      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected window creation"),
        ensureMain: Effect.die("unexpected window creation"),
        revealOrCreateMain: Effect.die("unexpected window creation"),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchMenuAction: () => Effect.void,
        syncAppearance: Effect.void,
      });

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }
});

/**
 * The quit dialog, driven through the same listeners the app registers.
 * Everything the effect needs is faked; what is asserted is what a person
 * sees: whether a dialog was asked, whether the app quit, and whether the
 * quit was cancelled.
 */
describe("DesktopLifecycle quit dialog", () => {
  const settle = () =>
    Effect.promise(async () => {
      for (let hop = 0; hop < 40; hop += 1) await Promise.resolve();
    });

  const scenario = (input: {
    readonly holding: boolean;
    readonly confirm: boolean;
    readonly installingUpdate?: boolean;
    readonly alreadyQuitting?: boolean;
  }) =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const calls = { quit: 0, confirm: 0 };
      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("CH3"),
        whenReady: Effect.void,
        quit: Effect.sync(() => {
          calls.quit += 1;
        }),
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        requestSingleInstanceLock: Effect.succeed(true),
        getAppMetrics: Effect.succeed([]),
        isDefaultProtocolClient: () => Effect.succeed(false),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        setDockIcon: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: () => Effect.void,
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(
          Layer.succeed(ElectronTheme.ElectronTheme, {
            shouldUseDarkColors: Effect.succeed(false),
            setSource: () => Effect.void,
            onUpdated: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopWindow.DesktopWindow, {
            createMain: Effect.die("unexpected window creation"),
            ensureMain: Effect.die("unexpected window creation"),
            revealOrCreateMain: Effect.die("unexpected window creation"),
            activate: Effect.void,
            createMainIfBackendReady: Effect.void,
            showConnectingSplash: Effect.void,
            handleBackendReady: () => Effect.void,
            handleBackendNotReady: Effect.void,
            flushMainWindowBounds: Effect.void,
            dispatchMenuAction: () => Effect.void,
            syncAppearance: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopAgentPowerGuard.DesktopAgentPowerGuard, {
            setActive: () => Effect.void,
            isHolding: Effect.succeed(input.holding),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ElectronDialog.ElectronDialog, {
            confirm: () =>
              Effect.sync(() => {
                calls.confirm += 1;
                return input.confirm;
              }),
          } as unknown as ElectronDialog.ElectronDialog["Service"]),
        ),
        Layer.provideMerge(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            focusedMainOrFirst: Effect.succeed(Option.none()),
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
        ),
        // Shutdown completes at once: there is no backend here to wait for,
        // and the real layer's wait would never return in this test.
        Layer.provideMerge(
          Layer.succeed(DesktopShutdown.DesktopShutdown, {
            request: Effect.void,
            awaitRequest: Effect.void,
            markComplete: Effect.void,
            awaitComplete: Effect.void,
            isComplete: Effect.succeed(true),
          }),
        ),
        Layer.provideMerge(DesktopState.layer),
      );
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          if (input.installingUpdate) yield* Ref.set(state.installingUpdate, true);
          if (input.alreadyQuitting) yield* Ref.set(state.quitting, true);
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
          let prevented = false;
          appListeners.get("before-quit")?.({
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event);
          yield* settle();
          return { prevented, calls, quitting: yield* Ref.get(state.quitting) };
        }),
      ).pipe(Effect.provide(layer));
    });

  it.effect("asks while an agent is working, and a declined dialog keeps the app alive", () =>
    Effect.gen(function* () {
      const result = yield* scenario({ holding: true, confirm: false });
      assert.equal(result.calls.confirm, 1);
      assert.isTrue(result.prevented);
      assert.equal(result.calls.quit, 0);
      assert.isFalse(result.quitting);
    }),
  );

  it.effect("a confirmed dialog shuts down and then quits", () =>
    Effect.gen(function* () {
      const result = yield* scenario({ holding: true, confirm: true });
      assert.equal(result.calls.confirm, 1);
      assert.equal(result.calls.quit, 1);
      assert.isTrue(result.quitting);
    }),
  );

  it.effect("never asks while install.sh is quitting the app to replace it", () =>
    Effect.gen(function* () {
      // The installer's quit has nobody to answer a dialog, and the script
      // gives up after ninety seconds having installed nothing.
      const result = yield* scenario({ holding: true, confirm: false, installingUpdate: true });
      assert.equal(result.calls.confirm, 0);
      assert.equal(result.calls.quit, 1);
      assert.isTrue(result.quitting);
    }),
  );

  it.effect("never asks for a quit already under way", () =>
    Effect.gen(function* () {
      // A process signal shut the app down and is now asking Electron to
      // leave; that second before-quit is not a question either.
      const result = yield* scenario({ holding: true, confirm: false, alreadyQuitting: true });
      assert.equal(result.calls.confirm, 0);
      assert.equal(result.calls.quit, 1);
    }),
  );

  it.effect("does not ask when no agent is working", () =>
    Effect.gen(function* () {
      const result = yield* scenario({ holding: false, confirm: false });
      assert.equal(result.calls.confirm, 0);
      assert.equal(result.calls.quit, 1);
    }),
  );
});
