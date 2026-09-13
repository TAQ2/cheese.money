/**
 * Everything that happens to a Claude sign-in window between its creation and
 * its end: the address typed into the page, and the window closed once the
 * grant is given.
 *
 * This is the wiring that `DesktopWindow.ts` used to hold inline. It is a
 * module of its own for one reason: it has to be exercised against a real
 * window and a real page — the live harness in
 * `apps/desktop/scripts/claude-oauth-window-harness.cjs` does that against a
 * fake `https://claude.ai` served inside the window's own session — and a
 * harness can only prove something about the code the app runs if it imports
 * the same module. The colocated unit test drives the same function with a
 * fake window under a test clock for the cases a harness cannot wait out.
 *
 * The person signs in; CH3 only saves them retyping the address they already
 * gave it. Nothing here drives the page on their behalf.
 *
 * @module claudeSignInFlow
 */
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

import type { ClaudeSignInHint } from "./claudeSignInEmailHint.ts";
import { buildClaudeSignInPrefillScript, isClaudeSignInPrefillUrl } from "./claudeSignInPrefill.ts";
import {
  buildClaudeSignInSuccessProbeScript,
  matchesClaudeSignInSuccess,
} from "./claudeSignInSuccess.ts";

/**
 * Long enough for the CLI's loopback success page to render before the
 * in-app OAuth child window closes itself.
 */
export const CLAUDE_OAUTH_WINDOW_CLOSE_DELAY_MS = 1_500;

export interface ClaudeSignInFlowInput {
  /** The sign-in window, already constructed, not yet loading. */
  readonly window: Electron.BrowserWindow;
  /** The authorize URL the window was opened on. */
  readonly oauthUrl: string;
  /**
   * The account this window is for, taken from the renderer's hint by whoever
   * opened the window. Undefined means a brand-new account: nothing to type.
   */
  readonly hint: ClaudeSignInHint | undefined;
  readonly log: (message: string, fields: Record<string, unknown>) => Effect.Effect<void>;
  /** Overridable so tests and the harness need not wait out the real value. */
  readonly callbackCloseDelayMs?: number;
}

/**
 * Attach the flow to a window. Returns once the listeners are registered; the
 * work itself runs from the window's events, on fibers forked in the caller's
 * context.
 */
export const attachClaudeSignInFlow = (
  input: ClaudeSignInFlowInput,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const child = input.window;
    const hint = input.hint;
    const callbackCloseDelayMs = input.callbackCloseDelayMs ?? CLAUDE_OAUTH_WINDOW_CLOSE_DELAY_MS;

    let prefilled = false;

    // Per load, because the field almost never exists at first paint: the
    // sign-in is a single-page app and navigates again before showing the
    // form. The script no-ops if one is already running, and re-injection
    // stops once it reports the box filled, so a later step of the flow is
    // never typed into.
    child.webContents.on("did-finish-load", () => {
      if (prefilled || child.isDestroyed()) return;
      // Decided out here, against the URL Electron reports, BEFORE the address
      // is put anywhere near the page. The script re-checks the origin
      // internally too, but that check runs on the page's own
      // `Array.prototype.indexOf` and `location`, which the page can replace —
      // it is a correctness guard, not a boundary. This is the boundary.
      // Without it, choosing "Continue with Google" would hand a script with
      // the address inlined to accounts.google.com's main world.
      if (!isClaudeSignInPrefillUrl(child.webContents.getURL())) return;
      runFork(
        Effect.gen(function* () {
          const held = hint;
          if (held === undefined) return;
          // A page that refuses evaluation costs the convenience, not the
          // sign-in — the user types the address as they did before.
          const filled = yield* Effect.tryPromise(() =>
            child.webContents.executeJavaScript(
              buildClaudeSignInPrefillScript({ email: held.email }),
            ),
          ).pipe(Effect.orElseSucceed(() => false));
          // Latching, not assigning: the OAuth flow navigates while a poll is
          // still running, so two injections overlap routinely. A plain
          // assignment lets the LOSER settle last and reset the flag, which
          // re-arms injection on every later page — the opposite of what it
          // is for.
          prefilled ||= filled === true;
        }),
      );
    });

    // Close on the success page, however the sign-in ended. The loopback
    // handler below only fires when the callback is a navigation to localhost,
    // which is not where every sign-in lands: the CLI shows a hosted "Sign in
    // successful" / "Build something great" page, and a person who finished the
    // consent was left with the window still open on it. This recognises that
    // terminal page by title and by body text — in either language — and closes
    // it. Reached only after the grant is given, so closing is safe; read by
    // content, never by URL, because the success URL is a credential.
    let closedOnSuccess = false;
    const closeIfSuccessPage = () =>
      runFork(
        Effect.gen(function* () {
          if (closedOnSuccess || child.isDestroyed()) return;
          const byTitle = matchesClaudeSignInSuccess(child.getTitle());
          const success = byTitle
            ? true
            : yield* Effect.tryPromise(() =>
                child.webContents.executeJavaScript(buildClaudeSignInSuccessProbeScript()),
              ).pipe(
                Effect.map((value) => value === true),
                Effect.orElseSucceed(() => false),
              );
          if (!success || closedOnSuccess || child.isDestroyed()) return;
          closedOnSuccess = true;
          yield* Effect.sleep(callbackCloseDelayMs);
          if (!child.isDestroyed()) child.close();
        }),
      );
    child.webContents.on("page-title-updated", () => closeIfSuccessPage());
    child.webContents.on("did-finish-load", () => closeIfSuccessPage());

    // The flow ends on the CLI's loopback callback page; once the child lands
    // there the sign-in is complete and the window has nothing left to say —
    // close it after a beat so the success page registers.
    child.webContents.on("did-navigate", (_event, navigatedUrl) => {
      try {
        const parsed = new URL(navigatedUrl);
        if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return;
      } catch {
        return;
      }
      runFork(
        Effect.sleep(callbackCloseDelayMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!child.isDestroyed()) child.close();
            }),
          ),
        ),
      );
    });
  });
