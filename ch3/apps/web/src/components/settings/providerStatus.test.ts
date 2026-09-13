import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderUpdateState, ServerProviderVersionAdvisory } from "@ch3tools/contracts";

import { getProviderVersionAdvisoryPresentation } from "./providerStatus";

const behindLatest: ServerProviderVersionAdvisory = {
  status: "behind_latest",
  currentVersion: "1.18.23",
  latestVersion: "1.18.24",
  updateCommand: "opencode upgrade",
  canUpdate: true,
  checkedAt: "2026-08-27T00:00:00.000Z",
  message: "Install the update now or review provider settings.",
};

const terminalState = (
  status: ServerProviderUpdateState["status"],
  message: string,
): ServerProviderUpdateState => ({
  status,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: "2026-08-27T00:01:00.000Z",
  message,
  output: null,
});

describe("getProviderVersionAdvisoryPresentation", () => {
  it("offers the update when nothing has been attempted", () => {
    const presentation = getProviderVersionAdvisoryPresentation(behindLatest, undefined);

    expect(presentation?.title).toBe("Update available");
    expect(presentation?.retry).toBe(false);
    expect(presentation?.emphasis).toBe("normal");
  });

  it("explains the last failure instead of repeating the offer", () => {
    const presentation = getProviderVersionAdvisoryPresentation(
      behindLatest,
      terminalState(
        "failed",
        "The update command finished without an error, but this provider is still on 1.18.23. GitHub rate-limits anonymous API requests per network address, and this one has spent its hourly quota.",
      ),
    );

    expect(presentation?.title).toBe("Update failed");
    expect(presentation?.detail).toContain("hourly quota");
    expect(presentation?.emphasis).toBe("strong");
    // The way back in stays open, and is a deliberate press.
    expect(presentation?.retry).toBe(true);
    expect(presentation?.updateCommand).toBe("opencode upgrade");
  });

  it("says so when an update ran but did not install", () => {
    const presentation = getProviderVersionAdvisoryPresentation(
      behindLatest,
      terminalState("unchanged", "Update command completed, but CH3 could not verify it."),
    );

    expect(presentation?.title).toBe("Update did not install");
    expect(presentation?.retry).toBe(true);
  });

  it("drops the badge entirely once the provider is current", () => {
    expect(
      getProviderVersionAdvisoryPresentation(
        { ...behindLatest, status: "current", currentVersion: "1.18.24" },
        terminalState("succeeded", "Updated from 1.18.23 to 1.18.24."),
      ),
    ).toBeNull();
  });
});
