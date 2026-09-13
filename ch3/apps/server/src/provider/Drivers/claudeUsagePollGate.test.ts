import { describe, expect, it } from "vite-plus/test";

import { resolveClaudeUsagePoll, USAGE_IDLE_SUSPEND_MS } from "./claudeUsagePollGate.ts";

const nowMs = Date.parse("2026-08-20T18:00:00.000Z");
const minutesAgo = (minutes: number) => nowMs - minutes * 60_000;

describe("resolveClaudeUsagePoll", () => {
  it("polls while somebody is watching, however long the machine sat quiet before", () => {
    expect(
      resolveClaudeUsagePoll({
        clientActive: true,
        turnActive: false,
        lastActivityMs: minutesAgo(120),
        nowMs,
      }),
    ).toEqual({ poll: true, idleForMs: 0 });
  });

  it("polls for an unattended run, because nobody is there to wake it", () => {
    // The failure this prevents: an overnight run hits its account cap, the
    // hand-over needs a usage read to see it, and the gate had gone quiet
    // because nobody had touched the app for hours.
    expect(
      resolveClaudeUsagePoll({
        clientActive: false,
        turnActive: true,
        lastActivityMs: minutesAgo(120),
        nowMs,
      }),
    ).toEqual({ poll: true, idleForMs: 0 });
  });

  it("keeps polling inside the idle window", () => {
    const verdict = resolveClaudeUsagePoll({
      clientActive: false,
      turnActive: false,
      lastActivityMs: minutesAgo(7),
      nowMs,
    });
    expect(verdict.poll).toBe(true);
    expect(verdict.idleForMs).toBe(7 * 60_000);
  });

  it("stops once the machine has been quiet past the window", () => {
    const verdict = resolveClaudeUsagePoll({
      clientActive: false,
      turnActive: false,
      lastActivityMs: minutesAgo(9),
      nowMs,
    });
    expect(verdict.poll).toBe(false);
    expect(verdict.idleForMs).toBe(9 * 60_000);
  });

  it("draws the line at eight minutes", () => {
    expect(USAGE_IDLE_SUSPEND_MS).toBe(8 * 60_000);
    expect(
      resolveClaudeUsagePoll({
        clientActive: false,
        turnActive: false,
        lastActivityMs: nowMs - USAGE_IDLE_SUSPEND_MS,
        nowMs,
      }).poll,
    ).toBe(false);
    expect(
      resolveClaudeUsagePoll({
        clientActive: false,
        turnActive: false,
        lastActivityMs: nowMs - USAGE_IDLE_SUSPEND_MS + 1,
        nowMs,
      }).poll,
    ).toBe(true);
  });

  it("polls on a server that has seen no activity at all yet", () => {
    // Booting is itself a sign somebody is arriving, and starting suspended
    // would leave the first band on screen with nothing to show.
    expect(
      resolveClaudeUsagePoll({
        clientActive: false,
        turnActive: false,
        lastActivityMs: null,
        nowMs,
      }),
    ).toEqual({ poll: true, idleForMs: 0 });
  });

  it("suspends once the ticks themselves are the only thing happening", () => {
    // MF-3: the caller used to stamp activity whenever the gate said "yes",
    // which refreshed the window on every tick — so `idleForMs` never exceeded
    // the sixty-second poll interval and the suspension never engaged: 240
    // polls over four idle hours. Modelled here as the caller now behaves:
    // stamp ONLY on observed activity, then tick a quiet machine.
    const tickMs = 60_000;
    let lastActivityMs: number | null = nowMs;
    let suspended = 0;
    for (let tick = 1; tick <= 12; tick += 1) {
      const at = nowMs + tick * tickMs;
      const clientActive = false;
      const turnActive = false;
      if (clientActive || turnActive) lastActivityMs = at;
      const verdict = resolveClaudeUsagePoll({
        clientActive,
        turnActive,
        lastActivityMs,
        nowMs: at,
      });
      if (!verdict.poll) suspended += 1;
    }
    // Eight minutes in it goes quiet and stays quiet: ticks 8 through 12.
    expect(suspended).toBe(5);
  });

  it("takes the window as an argument, so a caller can tighten it", () => {
    expect(
      resolveClaudeUsagePoll(
        { clientActive: false, turnActive: false, lastActivityMs: minutesAgo(2), nowMs },
        60_000,
      ).poll,
    ).toBe(false);
  });
});
