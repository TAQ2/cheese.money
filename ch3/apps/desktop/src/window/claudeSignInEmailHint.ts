/**
 * Which account the sign-in window about to open is FOR.
 *
 * The renderer knows: it has the profile row the user clicked. The main
 * process is the one that can type into the sign-in page, and it sees only a
 * `window.open` with an OAuth URL — the URL says nothing about which of
 * several signed-out profiles this attempt belongs to. So the renderer states
 * it here, immediately before opening the window, and the window handler
 * consumes it.
 *
 * Module-level state on purpose, following `claudeAuthFailureSignal.ts` in the
 * server: the IPC handler and the window handler live in the same process, and
 * one small fact is all that travels between them.
 *
 * A hint is SINGLE USE and it EXPIRES. Both matter. A sign-in that never opens
 * a window — the CLI returned no URL, or the user cancelled — would otherwise
 * leave an address parked, and the next sign-in, possibly for an entirely
 * different account, would silently inherit it. Filling the wrong address into
 * a profile is exactly the mistake this feature exists to prevent, so its own
 * failure mode must not cause it.
 */

/**
 * Long enough to cover a slow window opening, short enough that an abandoned
 * attempt cannot reach the next one. The renderer sets the hint immediately
 * before `window.open`, so the real gap is milliseconds.
 */
export const CLAUDE_SIGN_IN_HINT_TTL_MS = 2 * 60 * 1000;

/** What the window handler gets back. */
export interface ClaudeSignInHint {
  readonly email: string;
}

interface PendingHint extends ClaudeSignInHint {
  readonly setAtMs: number;
}

let pending: PendingHint | undefined;

/**
 * Record the account the next sign-in window is for.
 *
 * `null` clears instead of recording, which is how the caller says "this
 * sign-in is for a brand-new account, there is nothing to prefill". Callers
 * must always call one or the other rather than skipping the call, so a hint
 * left by a previous attempt cannot survive into this one.
 */
export const rememberClaudeSignInEmail = (email: string | null, nowMs: number): void => {
  const trimmed = email?.trim() ?? "";
  pending = trimmed.length === 0 ? undefined : { email: trimmed, setAtMs: nowMs };
};

/**
 * Take the pending hint, if it is still good. Returns undefined when there is
 * none or it has expired, and leaves nothing behind either way.
 */
export const consumeClaudeSignInEmail = (nowMs: number): ClaudeSignInHint | undefined => {
  const held = pending;
  pending = undefined;
  if (!held) return undefined;
  if (nowMs - held.setAtMs > CLAUDE_SIGN_IN_HINT_TTL_MS) return undefined;
  return { email: held.email };
};

/** Test seam, and the reset a sign-out should perform. */
export const clearClaudeSignInEmailHint = (): void => {
  pending = undefined;
};
