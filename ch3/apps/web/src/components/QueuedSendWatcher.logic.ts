import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type MessageId,
  type UploadChatAttachment,
} from "@ch3tools/contracts";

import type { SessionPhase } from "../types";
import type { ComposerThreadDraftState } from "../composerDraftStore";
import { composerDraftSignature, type QueuedSendEntry } from "../queuedSendStore";

export interface BackgroundQueuedEntry {
  threadKey: string;
  entry: QueuedSendEntry;
}

/**
 * The queued sends the watcher owns: the head of every thread's queue, except
 * the one the on-screen composer is about to send itself.
 *
 * Only one entry per thread, because sending it starts a turn — everything
 * behind it has to wait for that turn to end, exactly as it waited for the
 * one before.
 *
 * The active thread is normally left alone: its composer releases the message
 * with an optimistic bubble and a scroll anchor, which a background send has
 * no way to produce. That only holds while the head still *is* that composer's
 * draft. A stacked entry is a frozen message the composer no longer carries,
 * so nobody else would ever send it.
 */
export function selectBackgroundQueuedEntries(
  entriesByThreadKey: Record<string, ReadonlyArray<QueuedSendEntry>>,
  activeThreadKey: string | null,
): BackgroundQueuedEntry[] {
  const background: BackgroundQueuedEntry[] = [];
  for (const [threadKey, entries] of Object.entries(entriesByThreadKey)) {
    const head = entries[0];
    if (!head) continue;
    if (threadKey === activeThreadKey && head.tracksDraft) continue;
    background.push({ threadKey, entry: head });
  }
  return background;
}

export type QueuedSendDecision =
  | { kind: "wait" }
  /** Drop without sending. `reason` is null when the draft simply went empty. */
  | { kind: "drop"; reason: string | null }
  | { kind: "send" };

/**
 * Whether a queued send for an inactive thread should fire now.
 *
 * `phase` covers every way a turn can end — completed, interrupted, or failed
 * — so a queued message is never stranded by a turn that stopped without
 * finishing cleanly.
 */
export function decideQueuedSend(input: {
  hasShell: boolean;
  phase: SessionPhase;
  /**
   * An entry claimed for this thread has not reached the server yet.
   *
   * `phase` cannot answer this: it only leaves `ready` once a server event has
   * come back, and the next entry's watcher mounts in the same synchronous
   * pass the claim happened in. Waiting on it is what keeps a stacked queue in
   * order instead of firing every entry at once.
   */
  dispatchInFlight: boolean;
  text: string;
  images: ReadonlyArray<{ sizeBytes: number }>;
  /**
   * The composer's verdict at freeze time. `text` is never empty — it falls
   * back to an image-only bootstrap prompt — so an emptied draft is only
   * detectable through this.
   */
  hasSendableContent: boolean;
  interactiveBuiltin: string | null;
}): QueuedSendDecision {
  // No shell yet (the thread index is still syncing): stay armed rather than
  // drop a message the user is owed.
  if (!input.hasShell) return { kind: "wait" };
  if (input.phase === "running" || input.phase === "connecting") return { kind: "wait" };
  if (input.dispatchInFlight) return { kind: "wait" };
  if (!input.hasSendableContent) {
    return { kind: "drop", reason: null };
  }
  if (input.interactiveBuiltin !== null) {
    // These never reach the server: the composer's send path runs them against
    // the app itself, so a background send would post the literal text.
    return {
      kind: "drop",
      reason: `/${input.interactiveBuiltin} has to be run from inside the thread.`,
    };
  }
  if (input.text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
    return { kind: "drop", reason: "the message is longer than this provider accepts." };
  }
  if (input.images.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return {
      kind: "drop",
      reason: `only ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments can be sent at once.`,
    };
  }
  if (input.images.some((image) => image.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)) {
    return { kind: "drop", reason: "one of the attached images is too large." };
  }
  return { kind: "send" };
}

/**
 * The turn a background release dispatches.
 *
 * Modes come from the snapshot, not the thread record: a mode picked in the
 * composer (Plan, or a different approval mode) lives only in the draft until
 * a send persists it, so reading the server's copy would silently downgrade a
 * queued plan-mode turn into one that edits.
 *
 * The turn input alone cannot carry them, which is why `dispatchQueuedSend`
 * persists the modes to the thread record immediately before starting the
 * turn: `decider.ts` reads `targetThread.runtimeMode`, not the command's,
 * because the command's modes have a decoding default and honouring them
 * would let any caller that omits them reset the thread. Writing thread
 * metadata from a background release does change a thread the user is not
 * looking at — and that is the lesser surprise. The alternative shipped a
 * message queued in Plan mode as a turn that edited files.
 */
export function buildQueuedTurnInput(input: {
  entry: QueuedSendEntry;
  messageId: MessageId;
  createdAt: string;
  attachments: ReadonlyArray<UploadChatAttachment>;
}) {
  const { snapshot, ref } = input.entry;
  return {
    threadId: ref.threadId,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: snapshot.text,
      attachments: input.attachments,
    },
    modelSelection: snapshot.modelSelection,
    runtimeMode: snapshot.runtimeMode,
    interactionMode: snapshot.interactionMode,
    createdAt: input.createdAt,
  };
}

/**
 * Whether the draft may be cleared after a background send.
 *
 * Only what was actually sent gets cleared. A draft edited after the snapshot
 * froze — a pasted image that finished compressing once the thread went
 * off-screen, say — was never sent, so deleting it would be data loss.
 *
 * A stacked entry never clears anything. Stacking already cleared the draft it
 * came from, and the composer holds the *next* message now: a signature that
 * happened to match again (the same text retyped) would delete a message the
 * user is still writing.
 */
export function shouldClearDraftAfterQueuedSend(
  entry: QueuedSendEntry,
  liveDraft: ComposerThreadDraftState | null,
): boolean {
  if (!entry.tracksDraft) return false;
  if (liveDraft === null) return true;
  return composerDraftSignature(liveDraft) === entry.snapshot.draftSignature;
}
