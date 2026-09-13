/**
 * The Claude sign-in window, built by the main process rather than by Electron.
 *
 * WHY NOT `overrideBrowserWindowOptions`. The obvious repair for the
 * shared-cookie bug is to hand the window-open handler a `partition` in
 * `overrideBrowserWindowOptions.webPreferences` and let Electron create the
 * child as before. That does not work, and it fails SILENTLY. A window opened
 * through `window.open` is created at the content layer from the opener's site
 * instance, so it inherits the OPENER'S session; Electron's `partition` and
 * `session` web preferences are only consulted when a WebContents is
 * constructed from scratch. Both were measured against Electron 41.5.0 on this
 * branch: the child came back with `isDefaultSession=true` and could read a
 * `claude.com` cookie planted in the default session moments earlier.
 *
 * So the handler denies the open and this module builds the window instead —
 * the same shape `GoogleWorkspaceAuth` already uses for the Workspace consent
 * screen. Constructing the WebContents ourselves is the only path on which
 * `partition` is honoured, and `apps/desktop/scripts/claude-oauth-window-harness.cjs`
 * re-measures that against a live Electron on every run.
 *
 * A second, quieter bug goes away with it. The old code stripped the user agent
 * in `did-create-window`, which fires AFTER Electron has already begun loading
 * the URL — the first request could still go out announcing `Electron/`. Here
 * the agent is set on the session and the contents before anything is loaded.
 *
 * @module claudeSignInWindow
 */
import * as Electron from "electron";

import { nextClaudeSignInPartition } from "./claudeSignInPartition.ts";

const CLAUDE_SIGN_IN_WINDOW_WIDTH = 520;
const CLAUDE_SIGN_IN_WINDOW_HEIGHT = 760;

/**
 * Identify as a browser, not as an embedded shell. Sign-in pages — Google's
 * Workspace consent among them — refuse user agents they read as Electron, so
 * this is not cosmetic: without it the flow cannot be completed at all.
 */
export function stripElectronUserAgent(userAgent: string): string {
  return userAgent.replace(/Electron\/[\d.]+ /, "").replace(/\s*ch3\/[\d.]+/, "");
}

export interface ClaudeSignInWindow {
  readonly window: Electron.BrowserWindow;
  /** The session this window — and only this window — browses in. */
  readonly partition: string;
}

/**
 * Opens the OAuth page in a window with its own empty cookie jar.
 *
 * `configure` runs after the window exists and BEFORE the load starts, which is
 * the only ordering in which a `did-finish-load` listener is guaranteed to see
 * the first load. The prefill and the automated magic-link flow are attached
 * there.
 */
export function openClaudeSignInWindow(input: {
  readonly url: string;
  readonly configure?: (window: Electron.BrowserWindow) => void;
  /**
   * Off for a sign-in CH3 drives itself — the page is typed into, navigated
   * and pressed without the person, and a window that appears invites them to
   * click into the middle of it — and for the harness, which must not flash
   * windows on a desktop. The caller shows it later if the automation hands
   * back.
   */
  readonly show?: boolean;
}): ClaudeSignInWindow {
  const partition = nextClaudeSignInPartition();
  // Created here rather than left to the BrowserWindow so the agent is already
  // rewritten when the first request leaves. The session is exclusive to this
  // window, so setting it here cannot affect anything else in the app — and it
  // covers popups the sign-in page opens for SSO, which inherit this session
  // and would otherwise announce themselves as Electron.
  const signInSession = Electron.session.fromPartition(partition);
  signInSession.setUserAgent(stripElectronUserAgent(signInSession.getUserAgent()));

  const window = new Electron.BrowserWindow({
    width: CLAUDE_SIGN_IN_WINDOW_WIDTH,
    height: CLAUDE_SIGN_IN_WINDOW_HEIGHT,
    autoHideMenuBar: true,
    ...(input.show === false ? { show: false } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition,
      // The automated flow runs with this window hidden, and Chromium clamps a
      // hidden page's timers to once a second and reports it as not visible.
      // The scripts injected into the page poll every 250ms and the page is a
      // single-page app that lays itself out on frames; throttled, the
      // automation crawls and the consent step may never paint. Off here, for
      // this window only, which also keeps a visible sign-in window responsive
      // while the main window sits in front of it.
      backgroundThrottling: false,
    },
  });
  window.webContents.setUserAgent(stripElectronUserAgent(window.webContents.getUserAgent()));

  input.configure?.(window);

  // Rejects on any aborted navigation — a redirect the page replaces, or the
  // user closing the window mid-load. Neither is a failure worth surfacing,
  // and an uncaught rejection here would take the main process's logs with it.
  void window.loadURL(input.url).catch(() => {});

  return { window, partition };
}
