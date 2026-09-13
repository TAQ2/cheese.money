import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  configuredHostedAppUrl,
  hasHostedPairingRequest,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://hosted.example.test/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");

    const built = buildHostedPairingUrl({
      host: "https://backend.example.com:3773",
      token: "pairing-token",
      label: "Workstation",
    });
    expect(built).not.toBeNull();
    const url = new URL(built!);

    expect(url.origin).toBe("https://hosted.example.test");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("builds hosted channel selection URLs through the configured router origin", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");

    const built = buildHostedChannelSelectionUrl({ channel: "nightly" });
    expect(built).not.toBeNull();
    const url = new URL(built!);

    expect(url.origin).toBe("https://hosted.example.test");
    expect(url.pathname).toBe("/__ch3/channel");
    expect(url.searchParams.get("channel")).toBe("nightly");
    expect(url.searchParams.has("next")).toBe(false);
  });

  it("ignores incomplete hosted pairing requests", () => {
    expect(
      hasHostedPairingRequest(new URL("https://hosted.example.test/pair?host=backend.example.com")),
    ).toBe(false);
    expect(
      hasHostedPairingRequest(new URL("https://hosted.example.test/pair?token=ABCD1234")),
    ).toBe(false);
  });

  it("detects the hosted static app only when no backend URL is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://hosted.example.test/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://hosted.example.test/pair"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://backend.example.com/"))).toBe(false);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://hosted.example.test/"))).toBe(false);
  });

  it("detects hosted channel aliases as static apps", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://nightly.app.ch3.codes/"))).toBe(true);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://nightly.app.ch3.codes/"))).toBe(false);
  });
});

describe("hosted origin is opt-in", () => {
  it("builds no hosted links when no origin is configured", () => {
    // The shipped default. A baked-in origin naming an unregistered domain
    // would hand pairing and sign-in to whoever registered it, so there is
    // none — and every builder reports that rather than guessing.
    vi.stubEnv("VITE_HOSTED_APP_URL", "");

    expect(configuredHostedAppUrl()).toBeNull();
    expect(buildHostedPairingUrl({ host: "h:3773", token: "t" })).toBeNull();
    expect(buildHostedChannelSelectionUrl({ channel: "nightly" })).toBeNull();
    expect(isHostedStaticApp(new URL("https://anything.example.test/pair"))).toBe(false);
  });
});
