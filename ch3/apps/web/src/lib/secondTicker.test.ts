import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { subscribeToSecondTicker } from "./secondTicker";

describe("subscribeToSecondTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives every subscriber from one interval", () => {
    let first = 0;
    let second = 0;
    const unsubscribeFirst = subscribeToSecondTicker(() => {
      first += 1;
    });
    const unsubscribeSecond = subscribeToSecondTicker(() => {
      second += 1;
    });

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(first).toBe(2);
    expect(second).toBe(2);

    unsubscribeFirst();
    vi.advanceTimersByTime(1_000);
    expect(first).toBe(2);
    expect(second).toBe(3);

    unsubscribeSecond();
  });

  it("stops the interval when the last subscriber leaves", () => {
    let ticks = 0;
    const unsubscribe = subscribeToSecondTicker(() => {
      ticks += 1;
    });
    unsubscribe();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(ticks).toBe(0);
  });

  it("survives a double unsubscribe without touching a later subscriber", () => {
    const unsubscribeFirst = subscribeToSecondTicker(() => {});
    unsubscribeFirst();
    unsubscribeFirst();

    let ticks = 0;
    const unsubscribeSecond = subscribeToSecondTicker(() => {
      ticks += 1;
    });
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(1);
    unsubscribeSecond();
  });
});
