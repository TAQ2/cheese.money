import { describe, expect, it } from "vite-plus/test";

import { VISIBILITY_WAKEUP_MIN_INTERVAL_MS, shouldEmitVisibilityWakeup } from "./visibilityWakeup";

describe("shouldEmitVisibilityWakeup", () => {
  it("always emits the first wakeup", () => {
    expect(shouldEmitVisibilityWakeup(null, 0)).toBe(true);
  });

  it("suppresses returns within the floor", () => {
    expect(shouldEmitVisibilityWakeup(1_000, 1_000 + VISIBILITY_WAKEUP_MIN_INTERVAL_MS - 1)).toBe(
      false,
    );
  });

  it("emits again once the floor elapsed", () => {
    expect(shouldEmitVisibilityWakeup(1_000, 1_000 + VISIBILITY_WAKEUP_MIN_INTERVAL_MS)).toBe(true);
  });

  it("collapses a cmd-tab storm to one emission", () => {
    let lastEmittedAtMs: number | null = null;
    let emissions = 0;
    // Ten returns over one second — a fast cmd-tab cycle.
    for (let index = 0; index < 10; index += 1) {
      const nowMs = index * 100;
      if (shouldEmitVisibilityWakeup(lastEmittedAtMs, nowMs)) {
        lastEmittedAtMs = nowMs;
        emissions += 1;
      }
    }
    expect(emissions).toBe(1);
  });
});
