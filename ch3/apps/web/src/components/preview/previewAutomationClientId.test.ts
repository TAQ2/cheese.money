import { describe, expect, it } from "vite-plus/test";

import { createPreviewAutomationClientId } from "./previewAutomationClientId";

describe("createPreviewAutomationClientId", () => {
  it("creates distinct identities carrying 128 bits of randomness", () => {
    const clientIds = Array.from({ length: 32 }, createPreviewAutomationClientId);

    expect(new Set(clientIds).size).toBe(clientIds.length);
    // The prefix and exactly 16 random bytes as hex — a counter would fail this.
    expect(clientIds.every((clientId) => /^preview-[0-9a-f]{32}$/.test(clientId))).toBe(true);
  });
});
