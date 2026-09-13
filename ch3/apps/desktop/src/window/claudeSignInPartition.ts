/**
 * A private, throwaway cookie jar for every Claude sign-in attempt.
 *
 * The bug this exists to kill: the OAuth child window used to run in Electron's
 * DEFAULT session, the same jar the whole app browses in. The first sign-in
 * left a `claude.ai` session cookie behind, so the second one opened already
 * authenticated as the first person and completed OAuth for the WRONG account
 * into the target directory — silently. Three config directories on the
 * developer's machine ended up holding credentials for the same address.
 *
 * Two properties, both load-bearing:
 *
 *   EPHEMERAL — an Electron partition name WITHOUT the `persist:` prefix is
 *   held in memory only and is discarded once nothing references it. Nothing
 *   this window does can survive to the next app run. The prefix below cannot
 *   begin with `persist:`, and `partitionIsEphemeral` states that as a rule
 *   rather than leaving it to whoever edits the string next.
 *
 *   UNIQUE PER ATTEMPT — an in-memory session still lives for as long as the
 *   app does, so reusing ONE name would leak cookies between two sign-ins in a
 *   single run, which is exactly the reported failure. A fresh name per attempt
 *   means the second window cannot see the first window's cookies even without
 *   an app restart.
 *
 * Kept apart from the window module so the rule is unit-testable without
 * Electron: `claudeSignInWindow.ts` cannot be imported outside a live Electron
 * process, and a naming rule this load-bearing should not be provable only by
 * launching an app.
 *
 * @module claudeSignInPartition
 */
import * as NodeCrypto from "node:crypto";

/**
 * Marks these sessions as CH3's own when they turn up in a debugger, and
 * guarantees the name cannot collide with the preview browser's partitions.
 * Deliberately not `persist:`-prefixed — see the module note.
 */
export const CLAUDE_SIGN_IN_PARTITION_PREFIX = "ch3-claude-signin-";

/** Whether a partition name is in-memory rather than written to disk. */
export function partitionIsEphemeral(partition: string): boolean {
  return !partition.startsWith("persist:");
}

/**
 * The name for one attempt. Split out from the counter so the shape can be
 * asserted directly, without reaching for the module's mutable state.
 */
export function formatClaudeSignInPartition(input: {
  readonly attempt: number;
  readonly nonce: string;
}): string {
  return `${CLAUDE_SIGN_IN_PARTITION_PREFIX}${input.attempt}-${input.nonce}`;
}

/**
 * The counter is only for readability in logs and debuggers — the nonce is what
 * makes the name unique. A counter alone would repeat across app runs, which
 * does not matter for an in-memory session but reads as though it might.
 */
let attempts = 0;

/** A partition no previous sign-in in this app run has used. */
export function nextClaudeSignInPartition(): string {
  attempts += 1;
  return formatClaudeSignInPartition({ attempt: attempts, nonce: NodeCrypto.randomUUID() });
}
