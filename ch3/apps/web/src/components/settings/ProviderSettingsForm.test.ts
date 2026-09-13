import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@ch3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});

describe("the Claude session-tool switches, as the form will really render them", () => {
  // Pinned against the SHIPPED schema, not a fixture. These three arrived
  // annotated with only a title and description, and the renderer defaults
  // `control` to "text" — no boolean had ever reached it before, so they
  // would have shipped as three text boxes nobody could switch on, and typing
  // "true" would have written a string that fails the schema and takes the
  // whole Claude instance to "unavailable".
  const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
  const switches = ["artifactToolEnabled", "chromeIntegrationEnabled", "claudeAiConnectorsEnabled"];

  it("renders each one as a switch, not a text box", () => {
    expect(claude).toBeDefined();
    const fields = deriveProviderSettingsFields(claude!);
    for (const key of switches) {
      const field = fields.find((candidate) => candidate.key === key);
      expect(field, `${key} is missing from the form`).toBeDefined();
      expect(field!.control, `${key} renders as ${field!.control}`).toBe("switch");
    }
  });

  it("ships every one of them off, and says so to the renderer", () => {
    // `defaultBooleanValue` is what an unset config reads as, and what
    // `clearWhenEmpty` compares against — off has to be the default on both
    // sides or the switch lies about its own state.
    const fields = deriveProviderSettingsFields(claude!);
    for (const key of switches) {
      const field = fields.find((candidate) => candidate.key === key)!;
      expect(field.defaultBooleanValue, `${key} default`).toBe(false);
      expect(readProviderConfigBoolean({}, key, field.defaultBooleanValue ?? false)).toBe(false);
    }
  });

  it("writes a real boolean when switched on, never the string the schema rejects", () => {
    const fields = deriveProviderSettingsFields(claude!);
    const field = fields.find((candidate) => candidate.key === "artifactToolEnabled")!;
    const next = nextProviderConfigWithFieldValue({}, field, true);
    expect(next?.["artifactToolEnabled"]).toBe(true);
    expect(typeof next?.["artifactToolEnabled"]).toBe("boolean");
  });
});
