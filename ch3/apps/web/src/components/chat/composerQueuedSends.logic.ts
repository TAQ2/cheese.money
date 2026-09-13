/**
 * The rules the composer applies to its own queue, kept out of the effects
 * that run them so they can be tested without a running turn.
 *
 * Both exist because the queue stopped being one message. `+` freezes what is
 * in the composer as another entry behind the ones already waiting, and once
 * there is more than one entry, "the thread has something queued" no longer
 * tells the composer whether *this* message is its business.
 */

export interface DraftQueueState {
  /** The draft's own entry is queued: the composer shows a spinner. */
  readonly draftIsQueued: boolean;
  /** Frozen messages ahead of the draft, put there by +. */
  readonly stackedCount: number;
}

/**
 * Whether the composer may release its own queued draft now.
 *
 * `QueuedSendWatcher` owns every frozen entry, one turn each, so the composer
 * has to wait its turn: releasing from the middle of the stack would send the
 * newest message first and reorder work the user queued in order.
 */
export function canComposerReleaseQueuedDraft(input: DraftQueueState): boolean {
  return input.draftIsQueued && input.stackedCount === 0;
}

/**
 * Whether the message now in the composer should take the emptied queue's
 * place in it.
 *
 * A stack built with + strands its own last message without this: + freezes
 * the message above and hands back an *unqueued* composer, so the bottom one
 * would sit there watching everything above it go out.
 *
 * Two things it must not do, both of which cost a real message if got wrong:
 *
 * - **React to a cancel.** Cancelling empties the queue exactly the way a send
 *   does, so counting releases is what tells them apart — only a claim bumps
 *   `releaseCountByThreadKey`. `cancelledDraftQueue` covers the other half: the
 *   user turning *this* draft's own queue off by hand, which a later release by
 *   a message ahead of it would otherwise quietly undo.
 * - **React to its own release twice.** The composer books the release it
 *   claims before submitting, because the submit that clears the draft has not
 *   run yet — re-arming off that pre-submit draft would send the message a
 *   second time.
 */
export function shouldRearmDraftAfterQueueDrain(
  input: DraftQueueState & {
    readonly releaseCount: number;
    /** The last release this composer already reacted to for this thread. */
    readonly handledReleaseCount: number;
    readonly cancelledDraftQueue: boolean;
    readonly hasSendableContent: boolean;
  },
): boolean {
  if (input.releaseCount === input.handledReleaseCount) return false;
  if (input.cancelledDraftQueue) return false;
  if (input.draftIsQueued) return false;
  if (input.stackedCount > 0) return false;
  return input.hasSendableContent;
}

/**
 * Does Enter add this draft to the queue instead of sending it?
 *
 * Only when a queue is already up. The messages in it are waiting on the
 * running turn, so sending this one straight out delivers it BEFORE them —
 * the opposite of what a queue is for, and both land in the same breath, so
 * the agent reads them as one message. Making the user reach for `+` on every
 * line to avoid that is not a queue either: Enter is what people press.
 *
 * An empty draft is left to the submit path, which has its own answer for it.
 */
export function shouldStackDraftOnEnter(input: {
  /** The draft itself is queued, or frozen entries are stacked behind it. */
  hasQueuedSends: boolean;
  hasSendableContent: boolean;
  /**
   * Anything that already stops a send: a disconnected socket, a thread whose
   * messages are still loading, a pasted image mid-compression.
   *
   * Enter now performs what the `+` button performs, so it answers to the same
   * gates. Without this Enter froze a snapshot while `+` sat visibly greyed
   * out beside it — and a snapshot taken mid-compression carries the image
   * array from before the compression finished, stranding the attachment.
   */
  sendBlocked: boolean;
}): boolean {
  if (input.sendBlocked) return false;
  return input.hasQueuedSends && input.hasSendableContent;
}
