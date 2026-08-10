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
 * The armed threads the watcher owns: everything except the one on screen,
 * whose composer releases it itself.
 */
export function selectBackgroundQueuedEntries(
  entriesByThreadKey: Record<string, QueuedSendEntry>,
  activeThreadKey: string | null,
): BackgroundQueuedEntry[] {
  return Object.entries(entriesByThreadKey)
    .filter(([threadKey]) => threadKey !== activeThreadKey)
    .map(([threadKey, entry]) => ({ threadKey, entry }));
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
 * Deliberately does not persist those choices back to the thread record the
 * way an on-screen send does. The turn runs with what the user picked; the
 * record keeps its previous values until the next visible send. Writing
 * thread metadata from a background release would change a thread the user is
 * not looking at, which is a bigger surprise than the drift.
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
 */
export function shouldClearDraftAfterQueuedSend(
  entry: QueuedSendEntry,
  liveDraft: ComposerThreadDraftState | null,
): boolean {
  if (liveDraft === null) return true;
  return composerDraftSignature(liveDraft) === entry.snapshot.draftSignature;
}
