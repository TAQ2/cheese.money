import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
  resolveSidebarV2Default,
  resolveSidebarV2Enabled,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "CH3",
            stageLabel: "Nightly",
            displayName: "CH3 (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("CH3");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("CH3 (Nightly)");
  });

  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("CH3 (Nightly)");
  });

  it("does not label the latest hosted app channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Latest");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("CH3");
  });

  it("ignores unknown hosted app channels", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "preview");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBeNull();
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

describe("branding logic", () => {
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "CH3",
        fallbackDisplayName: "CH3 (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("CH3 (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "CH3",
        fallbackDisplayName: "CH3 (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("CH3 (Alpha)");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "CH3",
        fallbackDisplayName: "CH3 (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("CH3 (Alpha)");
  });
});

describe("resolveSidebarV2Default", () => {
  it.each(["Nightly", "Dev", "nightly", " dev ", "Alpha", "Latest", ""])(
    "opens on the inbox for %s builds",
    (stage) => {
      // Every stage, not just the pre-release ones: the first thing a new
      // install shows should be the work waiting, not a folder list.
      expect(resolveSidebarV2Default(stage)).toBe(true);
    },
  );
});

describe("resolveSidebarV2Enabled", () => {
  const hydrated = { settingsHydrated: true } as const;

  it.each(["Alpha", "Latest"])(
    "keeps a legacy opt-in on %s builds even without the companion flag",
    (stageLabel) => {
      // `true` was never the schema default, so it can only be an explicit
      // opt-in from settings written before `sidebarV2ConfiguredByUser` existed.
      expect(
        resolveSidebarV2Enabled({
          ...hydrated,
          enabled: true,
          configuredByUser: false,
          stageLabel,
        }),
      ).toBe(true);
    },
  );

  it.each(["Nightly", "Latest", "Alpha"])(
    "opens on the inbox for %s when nothing was ever chosen",
    (stageLabel) => {
      expect(
        resolveSidebarV2Enabled({
          ...hydrated,
          enabled: false,
          configuredByUser: false,
          stageLabel,
        }),
      ).toBe(true);
    },
  );

  it("holds the inbox while settings are still loading, so the common path never swaps", () => {
    // Pre-hydration is the schema defaults, not the user's answer. Holding the
    // project tree here mounted one sidebar and replaced it a tick later for
    // everyone who ends up on the inbox — which is now nearly everyone.
    expect(
      resolveSidebarV2Enabled({
        settingsHydrated: false,
        enabled: false,
        configuredByUser: false,
        stageLabel: "Latest",
      }),
    ).toBe(true);
  });

  it("honors an explicit opt-out over the stage default", () => {
    expect(
      resolveSidebarV2Enabled({
        ...hydrated,
        enabled: false,
        configuredByUser: true,
        stageLabel: "Nightly",
      }),
    ).toBe(false);
  });

  it("ignores a stored answer until settings hydrate, holding the default", () => {
    // Pre-hydration the "stored" values are just schema defaults, so they are
    // not an answer to hold on to — the sidebar that mounts is the default one,
    // and the stored choice takes effect the moment it is really known.
    expect(
      resolveSidebarV2Enabled({
        enabled: true,
        configuredByUser: true,
        settingsHydrated: false,
        stageLabel: "Nightly",
      }),
    ).toBe(true);
  });
});
