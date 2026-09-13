import { assert, describe, it } from "vite-plus/test";

import {
  collectMacLauncherSignTargets,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveLocalSignIdentity,
  resolveMacLauncherPaths,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
        CH3CODE_PORT: "16566",
        CH3CODE_HOME: "/tmp/ch3",
      },
    });

    assert.include(
      script,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.notInclude(script, "\nexport VITE_DEV_SERVER_URL=");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --ch3-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/CH3 (Dev).app",
      "CH3 (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "CH3 (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/CH3 (Dev).app/Contents/MacOS/CH3 (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/CH3 (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {},
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/CH3 (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("signs with the stable local identity when configured, ad-hoc otherwise", () => {
    assert.equal(resolveLocalSignIdentity({}), "-");
    assert.equal(resolveLocalSignIdentity({ CH3CODE_DESKTOP_LOCAL_SIGN_IDENTITY: "  " }), "-");
    assert.equal(
      resolveLocalSignIdentity({ CH3CODE_DESKTOP_LOCAL_SIGN_IDENTITY: " CH3 Dev " }),
      "CH3 Dev",
    );
  });

  it("re-signs patched helpers before the outer bundle, and only the bundle on a script refresh", () => {
    const bundle = "/repo/apps/desktop/.electron-runtime/CH3 (Dev).app";
    const listHelperBundleNames = () => ["Electron Helper.app", "Electron Helper (GPU).app"];

    assert.deepEqual(
      collectMacLauncherSignTargets(bundle, { helpers: true, listHelperBundleNames }),
      [
        `${bundle}/Contents/Frameworks/Electron Helper.app`,
        `${bundle}/Contents/Frameworks/Electron Helper (GPU).app`,
        bundle,
      ],
    );
    assert.deepEqual(collectMacLauncherSignTargets(bundle, { helpers: false }), [bundle]);
  });
});
