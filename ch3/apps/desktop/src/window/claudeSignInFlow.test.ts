import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";

import { attachClaudeSignInFlow, CLAUDE_OAUTH_WINDOW_CLOSE_DELAY_MS } from "./claudeSignInFlow.ts";

const OAUTH_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a";
const ACCOUNT = "claudio.dos@example.com";

/**
 * A window reduced to what the flow touches: the events it listens to, the
 * URL Electron reports, the one script it injects, and the three things it
 * does to the window itself. Everything observable is recorded.
 */
function makeFakeWindow(options: { readonly prefillResult?: unknown } = {}) {
  const listeners = new Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>();
  const log: Array<string> = [];
  let destroyed = false;
  let url = "https://claude.ai/login";
  const webContents = {
    on: (event: string, listener: (...args: ReadonlyArray<unknown>) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    getURL: () => url,
    executeJavaScript: (script: string) => {
      log.push(script.includes("__ch3ClaudeEmailPrefillRunning") ? "inject:prefill" : "inject:?");
      return Promise.resolve(options.prefillResult ?? true);
    },
  };
  const window = {
    webContents,
    isDestroyed: () => destroyed,
    show: () => void log.push("show"),
    close: () => {
      log.push("close");
      destroyed = true;
      emit("destroyed");
    },
  };
  const emit = (event: string, ...args: ReadonlyArray<unknown>) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  return {
    window: window as unknown as Electron.BrowserWindow,
    log,
    setUrl: (next: string) => void (url = next),
    emit,
    destroy: () => {
      destroyed = true;
      emit("destroyed");
    },
  };
}

const attach = (
  fake: ReturnType<typeof makeFakeWindow>,
  hint: { readonly email: string } | undefined,
) =>
  attachClaudeSignInFlow({
    window: fake.window,
    oauthUrl: OAUTH_URL,
    hint,
    log: () => Effect.void,
  });

/** Let the fibers forked from a window event run up to their next sleep. */
const settle = TestClock.adjust(0);

describe("attachClaudeSignInFlow", () => {
  it.effect("types the known address and lets the person finish the sign-in", () =>
    Effect.gen(function* () {
      const fake = makeFakeWindow();
      yield* attach(fake, { email: ACCOUNT });

      fake.emit("did-finish-load");
      yield* settle;
      assert.deepStrictEqual(fake.log, ["inject:prefill"]);

      // The CLI's loopback callback ends it, as it always did.
      fake.emit("did-navigate", {}, "http://localhost:54545/callback?code=abc");
      yield* TestClock.adjust(CLAUDE_OAUTH_WINDOW_CLOSE_DELAY_MS);
      assert.deepStrictEqual(fake.log, ["inject:prefill", "close"]);
    }),
  );

  it.effect("types nothing for a brand-new account", () =>
    Effect.gen(function* () {
      const fake = makeFakeWindow();
      yield* attach(fake, undefined);

      fake.emit("did-finish-load");
      yield* settle;
      assert.deepStrictEqual(fake.log, []);
    }),
  );

  it.effect("hands the address only to the sign-in origin", () =>
    Effect.gen(function* () {
      const fake = makeFakeWindow();
      yield* attach(fake, { email: ACCOUNT });

      fake.setUrl("https://accounts.google.com/signin");
      fake.emit("did-finish-load");
      yield* settle;
      assert.deepStrictEqual(fake.log, []);
    }),
  );
});
