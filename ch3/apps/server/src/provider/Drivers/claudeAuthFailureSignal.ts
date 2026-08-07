/**
 * The adapter's own record of Claude turns dying with authentication errors.
 *
 * This exists because no probe can see the state reliably from outside: the
 * CLI decides which credential store it reads per version and per config
 * directory, and a profile can look signed-in from every file while its
 * refresh token is revoked. The one source that cannot be wrong is the turn
 * failure the CLI itself reports — so the adapter records it here, and the
 * automatic account hand-over treats a recent record as its trigger.
 *
 * Module-level state on purpose: the adapter and the hand-over loop live in
 * the same process, and a timestamp is all that travels between them.
 */

const AUTH_FAILURE_PATTERN =
  /failed to authenticate|oauth.*(?:expired|revoked|no longer valid)|refresh token is no longer valid/i;

let lastAuthFailureAtMs: number | undefined;

export const isClaudeAuthFailureMessage = (message: string): boolean =>
  AUTH_FAILURE_PATTERN.test(message);

/** Records the failure time when the message is an authentication error. */
export const recordClaudeAuthFailure = (message: string, nowMs: number): boolean => {
  if (!isClaudeAuthFailureMessage(message)) return false;
  lastAuthFailureAtMs = nowMs;
  return true;
};

export const claudeAuthFailureWithin = (windowMs: number, nowMs: number): boolean =>
  lastAuthFailureAtMs !== undefined && nowMs - lastAuthFailureAtMs <= windowMs;

/**
 * Cleared after a hand-over: the failures on record belong to the account
 * that was just left, and must not condemn the one just switched to.
 */
export const resetClaudeAuthFailureSignal = (): void => {
  lastAuthFailureAtMs = undefined;
};
