import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

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
  onBeforeQuitForUpdate: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeed(Option.none()),
  confirm: () => Effect.succeed(false),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialog["Service"]);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  emitState: Effect.void,
  disabledReason: Effect.succeed(Option.none()),
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
} satisfies DesktopUpdates.DesktopUpdates["Service"]);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(true),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const makeDesktopLifecycleLayer = (relaunched: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopLifecycle.DesktopLifecycle, {
    relaunch: (reason) => Deferred.succeed(relaunched, reason).pipe(Effect.asVoid),
    register: Effect.void,
  } satisfies DesktopLifecycle.DesktopLifecycle["Service"]);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const configureMenu = (input: {
  readonly platform: DesktopEnvironment.MakeDesktopEnvironmentInput["platform"];
  readonly selectedAction: Deferred.Deferred<string>;
  readonly relaunched: Deferred.Deferred<string>;
  readonly applicationMenuTemplate: Deferred.Deferred<
    readonly Electron.MenuItemConstructorOptions[]
  >;
}) =>
  // Hands the resolved environment back so a test can assert against the same
  // display name the menu labels itself with, rather than restating it.
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
    return environment;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(makeElectronMenuLayer(input.applicationMenuTemplate)),
        Layer.provideMerge(makeDesktopWindowLayer(input.selectedAction)),
        Layer.provideMerge(makeDesktopLifecycleLayer(input.relaunched)),
        Layer.provideMerge(desktopUpdatesLayer),
        Layer.provideMerge(electronDialogLayer),
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(
          DesktopEnvironment.layer({ ...environmentInput, platform: input.platform }).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          ),
        ),
      ),
    ),
  );

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const relaunched = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu({
        platform: "linux",
        selectedAction,
        relaunched,
        applicationMenuTemplate,
      });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  it.effect("offers Restart directly under Quit and relaunches through the lifecycle", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const relaunched = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      const environment = yield* configureMenu({
        platform: "darwin",
        selectedAction,
        relaunched,
        applicationMenuTemplate,
      });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const appMenu = template.find((item) => item.label === "CH3");
      assert.isDefined(appMenu);
      if (!Array.isArray(appMenu.submenu)) {
        throw new Error("Expected the application menu submenu to be an array.");
      }
      // Position is the whole request: Restart is the item after Quit, which is
      // where the eye lands once it has found the bottom of the menu.
      const quitIndex = appMenu.submenu.findIndex((item) => item.role === "quit");
      assert.isAtLeast(quitIndex, 0);
      const restartItem = appMenu.submenu[quitIndex + 1];
      assert.isDefined(restartItem);
      assert.equal(restartItem.label, `Restart ${environment.displayName}`);
      // ⇧⌘Q logs the user out and ⌃⌘Q locks the screen; neither may be shadowed.
      assert.isUndefined(restartItem.accelerator);

      const restartClick = restartItem.click;
      if (typeof restartClick !== "function") {
        throw new Error("Expected Restart menu item to have a click handler.");
      }
      restartClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(relaunched), "menu");
    }),
  );

  it.effect("keeps Restart beside Quit in the File menu off macOS", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const relaunched = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      const environment = yield* configureMenu({
        platform: "linux",
        selectedAction,
        relaunched,
        applicationMenuTemplate,
      });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const quitIndex = fileMenu.submenu.findIndex((item) => item.role === "quit");
      assert.isAtLeast(quitIndex, 0);
      assert.equal(fileMenu.submenu[quitIndex + 1]?.label, `Restart ${environment.displayName}`);
    }),
  );
});
