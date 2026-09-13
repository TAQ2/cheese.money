import { create } from "zustand";
import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
} from "@ch3tools/contracts";
import { scopedThreadKey } from "@ch3tools/client-runtime/environment";
import { stripClaudePromptEffortPrefix } from "@ch3tools/shared/model";

import { randomUUID } from "./lib/utils";
import type { ComposerImageAttachment, ComposerThreadDraftState } from "./composerDraftStore";

/**
 * The frozen turn a queued send will dispatch.
 *
 * `text` is already the fully formatted outgoing prompt — terminal, element,
 * preview-annotation and review-comment blocks appended, effort prefix applied
 * — because only the mounted composer knows the provider, model list and
 * effort those steps need. Capturing it here is what lets a background watcher
 * send for a thread whose composer is long gone.
 */
export interface QueuedSendSnapshot {
  readonly text: string;
  /**
   * What the user actually typed, without the terminal, element, annotation
   * and review blocks `text` carries or the effort marker on the front.
   *
   * `text` is what gets SENT; this is what goes back in the composer when a
   * queued message is taken out of the queue. Putting the built string back
   * would hand the user machine-appended blocks to edit around.
   */
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly modelSelection: ModelSelection;
  /**
   * The composer's *effective* modes, not the thread's persisted ones. A mode
   * picked in the composer (Plan, or a different approval mode) lives only in
   * the draft until a send persists it, so reading the thread record here
   * would silently downgrade a queued plan-mode turn to an executing one.
   */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * The composer's own sendability verdict. `text` always has content — it
   * falls back to an image-only bootstrap prompt — so it cannot be used to
   * detect an emptied draft.
   */
  readonly hasSendableContent: boolean;
  /**
   * Set only for a builtin CH3 itself would intercept (`/mcp`, `/rewind`,
   * `/resume …`, and `/clear` on runtimes that do not advertise their own).
   * Those never reach the server, so a background send would post the literal
   * text as a message. A builtin the runtime executes itself is left null and
   * sent as ordinary text, exactly as the composer would send it.
   */
  readonly interactiveBuiltin: string | null;
  /**
   * Identity of the draft at freeze time, so a background send never deletes
   * an edit the user made after the snapshot was taken.
   */
  readonly draftSignature: string;
}

/**
 * Identifies a draft's full contents, not just its text: `clearComposerContent`
 * wipes terminal and element contexts, preview annotations and review comments
 * along with the prompt and images, so any of them arriving after the freeze
 * must also block the post-send clear.
 */
/**
 * NUL, matching the composite-key separator used elsewhere in the composer: it
 * cannot occur in a prompt, so the encoding is collision-free. Written as an
 * escape rather than a literal byte because a raw NUL inside git's 8 KiB
 * binary-sniff window makes the whole file binary, costing diffs and blame.
 */
const SIGNATURE_SEPARATOR = "\u0000";

export function composerDraftSignature(
  draft: Pick<
    ComposerThreadDraftState,
    "prompt" | "images" | "terminalContexts" | "elementContexts" | "previewAnnotations"
  > &
    Pick<ComposerThreadDraftState, "reviewComments">,
): string {
  return [
    draft.images.length,
    draft.terminalContexts.length,
    draft.elementContexts.length,
    draft.previewAnnotations.length,
    draft.reviewComments.length,
    draft.prompt,
  ].join(SIGNATURE_SEPARATOR);
}

export interface QueuedSendEntry {
  /** Stable across edits and refreshes, so a row can be keyed and targeted. */
  readonly id: string;
  readonly ref: ScopedThreadRef;
  readonly snapshot: QueuedSendSnapshot;
  /**
   * True while this entry still *is* the composer's live draft: `refresh`
   * keeps it in step with every keystroke, it is drawn by the composer itself
   * rather than as a queued row, and the mounted composer — not the watcher —
   * is what sends it.
   *
   * `stack` flips it to false for good. That is the whole feature: a frozen
   * entry no longer follows the composer, so the composer is free to start the
   * next message behind it. Only the tail can ever track, because only the
   * tail was the draft when it was armed.
   */
  readonly tracksDraft: boolean;
}

/**
 * The session state a claim was made against, held until the server moves past
 * it. `null` is a thread with no session projection yet, which is not the same
 * as "no mark" — it still gates, because a thread that has never reported a
 * session cannot have reported the turn we just started either.
 */
export interface QueuedDispatchMark {
  readonly sessionUpdatedAt: string | null;
}

interface QueuedSendStoreState {
  /**
   * Each thread's queue by `scopedThreadKey`, oldest first. A thread with
   * nothing queued has no key at all — an empty array left behind would read
   * as "armed" to every `!== undefined` check.
   */
  entriesByThreadKey: Record<string, ReadonlyArray<QueuedSendEntry>>;
  /**
   * How many entries this thread has released for sending.
   *
   * The composer re-arms whatever you are writing once the queue drains, and
   * "the queue is empty" alone cannot tell a send from a cancel — re-arming
   * after a cancel would make the X button do nothing. Only a claim bumps
   * this, so the composer can react to the one and ignore the other.
   */
  releaseCountByThreadKey: Record<string, number>;
  /**
   * Threads whose claimed entry is still on its way to the server, each marked
   * with the session state its claim was made against.
   *
   * Claiming an entry does not make the thread look busy: `phase` only leaves
   * `ready` once a server event has come back, and the next entry's watcher
   * mounts in the same synchronous pass the claim happened in. Without this
   * every stacked message would be dispatched at once — and a message
   * carrying an image, which awaits `readFileAsDataUrl` before its RPC, could
   * be overtaken by the one queued behind it. Ordering is the whole promise of
   * a queue.
   *
   * The mark is what makes it *last long enough*. Releasing on the RPC's own
   * resolution does not: the ack and the session projection are two different
   * messages, and the ack wins. A real drain went out at `.261`, `.304` and
   * `.436` — three turns in 175 ms — because each entry saw the flag cleared by
   * its predecessor's ack while `phase` was still the stale `ready` from before
   * the first send. So the gate holds until server state that POSTDATES the
   * claim has landed, and `sessionUpdatedAt` is that test: it is stamped by the
   * server, so comparing it for change carries no clock skew, and a started
   * turn always writes at least one `starting` session-set. Once it moves,
   * `phase` is telling the truth again and takes the gating back.
   */
  dispatchingByThreadKey: Record<string, QueuedDispatchMark>;
  /**
   * Threads where the user took their own draft back out of the queue.
   *
   * The composer re-arms whatever is in it once the queue drains, so a cancel
   * has to be remembered until they ask for the queue again. It lives here
   * rather than in the composer because the composer forgets: it held the flag
   * in a ref that reset on a thread switch and died on unmount, so cancelling
   * a message and then leaving the thread let an entry ahead of it quietly put
   * it back — and send it.
   */
  cancelledDraftByThreadKey: Record<string, boolean>;
  /**
   * How many of this thread's releases the composer has already accounted for.
   *
   * Kept here rather than in a composer ref because the composer is not always
   * there. A stack built with `+` hands back an *unqueued* composer and relies
   * on the next release to re-arm it — so if the user leaves the thread, the
   * release lands while nothing is mounted, and a ref that resets per thread
   * would adopt the new count on the way back and read the release as
   * ancient history. The last message of the stack then sat in the composer
   * forever, never queued, with nothing to say it had been meant to go.
   *
   * A thread with no entry here has never been seen in this tab: its current
   * count is adopted rather than read as a release.
   */
  handledReleaseByThreadKey: Record<string, number>;
  /** The composer has accounted for this thread's releases up to `count`. */
  noteQueueReleaseHandled: (ref: ScopedThreadRef, count: number) => void;
  /** The user cancelled their own draft's queue. Remembered until they re-arm. */
  noteDraftQueueCancelled: (ref: ScopedThreadRef) => void;
  /**
   * The claimed entry FAILED to reach the server. Lets the next one go.
   *
   * The success path deliberately does not call this: a send that worked is
   * released by the session moving past the claim's mark, not by the ack. A
   * failed send never moves it, so without this the thread would gate forever
   * and strand every message behind the one that failed.
   */
  finishQueuedDispatch: (ref: ScopedThreadRef) => void;
  /** Appends a new tail entry that tracks the live draft. */
  arm: (ref: ScopedThreadRef, snapshot: QueuedSendSnapshot) => void;
  /**
   * Re-freezes the tail entry, and only while it still tracks the draft. A
   * no-op otherwise, so the composer can push every keystroke without racing a
   * release that already fired — and without rewriting a stacked entry, which
   * would make every message in the queue identical.
   */
  refresh: (ref: ScopedThreadRef, snapshot: QueuedSendSnapshot) => void;
  /** Freezes the tail so the composer can start the next message behind it. */
  stack: (ref: ScopedThreadRef) => void;
  /**
   * Edits one queued entry's outgoing text.
   *
   * Text only, deliberately. Images, terminal and element contexts, preview
   * annotations and review comments ride along frozen from when the entry was
   * queued and render read-only: those pipelines are wired to the single
   * active draft, so a queued row cannot take a new one. Attaching is done in
   * the bottom composer, which is a real draft.
   */
  updateQueuedText: (ref: ScopedThreadRef, id: string, text: string) => void;
  /** Drops one entry. The rest keep their order. */
  remove: (ref: ScopedThreadRef, id: string) => void;
  /**
   * Swaps one entry's message for another, in place.
   *
   * Taking a queued message back into the composer must not cost the message
   * already there: the composer's draft takes the vacated slot, so both
   * survive and the queue keeps its order.
   */
  replaceSnapshot: (ref: ScopedThreadRef, id: string, snapshot: QueuedSendSnapshot) => void;
}

const NO_QUEUED_ENTRIES: ReadonlyArray<QueuedSendEntry> = [];

/**
 * Writes `entries` back for `key`, dropping the key when the queue is empty.
 */
function withQueue(
  entriesByThreadKey: Record<string, ReadonlyArray<QueuedSendEntry>>,
  key: string,
  entries: ReadonlyArray<QueuedSendEntry>,
): Record<string, ReadonlyArray<QueuedSendEntry>> {
  if (entries.length === 0) {
    const next = { ...entriesByThreadKey };
    delete next[key];
    return next;
  }
  return { ...entriesByThreadKey, [key]: entries };
}

/**
 * Sends held until their thread's agent finishes.
 *
 * Deliberately in-memory and deliberately *not* a field on
 * `composerDraftStore`: that store persists through schema migrations, and a
 * queue that outlived a reload would point at a draft the user has since
 * changed. A queue that dies with the tab is the honest behaviour. Stacked
 * entries inherit that.
 */
export const useQueuedSendStore = create<QueuedSendStoreState>((set) => ({
  entriesByThreadKey: {},
  releaseCountByThreadKey: {},
  dispatchingByThreadKey: {},
  cancelledDraftByThreadKey: {},
  handledReleaseByThreadKey: {},
  noteQueueReleaseHandled: (ref, count) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (state.handledReleaseByThreadKey[key] === count) return state;
      return {
        handledReleaseByThreadKey: { ...state.handledReleaseByThreadKey, [key]: count },
      };
    }),
  noteDraftQueueCancelled: (ref) =>
    set((state) => ({
      cancelledDraftByThreadKey: {
        ...state.cancelledDraftByThreadKey,
        [scopedThreadKey(ref)]: true,
      },
    })),
  finishQueuedDispatch: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!state.dispatchingByThreadKey[key]) return state;
      const next = { ...state.dispatchingByThreadKey };
      delete next[key];
      return { dispatchingByThreadKey: next };
    }),
  arm: (ref, snapshot) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const entries = state.entriesByThreadKey[key] ?? NO_QUEUED_ENTRIES;
      const cancelled = { ...state.cancelledDraftByThreadKey };
      // Arming is the user asking for the queue again, which retires the cancel
      // that was holding the composer back.
      delete cancelled[key];
      return {
        entriesByThreadKey: withQueue(state.entriesByThreadKey, key, [
          ...entries,
          { id: randomUUID(), ref, snapshot, tracksDraft: true },
        ]),
        cancelledDraftByThreadKey: cancelled,
      };
    }),
  refresh: (ref, snapshot) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const entries = state.entriesByThreadKey[key];
      if (!entries || entries.length === 0) return state;
      const tail = entries[entries.length - 1]!;
      if (!tail.tracksDraft) return state;
      return {
        entriesByThreadKey: withQueue(state.entriesByThreadKey, key, [
          ...entries.slice(0, -1),
          { ...tail, snapshot },
        ]),
      };
    }),
  stack: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const entries = state.entriesByThreadKey[key];
      if (!entries || entries.length === 0) return state;
      const tail = entries[entries.length - 1]!;
      if (!tail.tracksDraft) return state;
      return {
        entriesByThreadKey: withQueue(state.entriesByThreadKey, key, [
          ...entries.slice(0, -1),
          { ...tail, tracksDraft: false },
        ]),
      };
    }),
  updateQueuedText: (ref, id, text) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const entries = state.entriesByThreadKey[key];
      if (!entries) return state;
      let changed = false;
      const next = entries.map((entry) => {
        if (entry.id !== id || entry.snapshot.text === text) return entry;
        changed = true;
        // Sendability is recomputed, not carried over. It was the composer's
        // verdict on the message as queued; editing a row down to nothing left
        // it saying "yes" and sent an empty user message, which the thread
        // recorded before the provider refused the turn. An entry with images
        // stays sendable with no text, exactly as the composer would treat it.
        //
        // The effort marker comes off first. `text` is the built outgoing
        // prompt, so a message queued on ultrathink and emptied in the row
        // still reads `Ultrathink:` — not empty by any string test, and not a
        // message either.
        return {
          ...entry,
          snapshot: {
            ...entry.snapshot,
            text,
            // What the row now says is the message, so it is also what comes
            // back if this row is taken out of the queue — minus the effort
            // marker, which the composer puts on again by itself. Handing
            // `Ultrathink:` back as literal text is the thing `prompt` exists
            // to avoid.
            prompt: stripClaudePromptEffortPrefix(text),
            hasSendableContent:
              stripClaudePromptEffortPrefix(text).length > 0 || entry.snapshot.images.length > 0,
          },
        };
      });
      if (!changed) return state;
      return { entriesByThreadKey: withQueue(state.entriesByThreadKey, key, next) };
    }),
  replaceSnapshot: (ref, id, snapshot) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const entries = state.entriesByThreadKey[key];
      if (!entries) return state;
      let changed = false;
      const next = entries.map((entry) => {
        if (entry.id !== id) return entry;
        changed = true;
        return { ...entry, snapshot, tracksDraft: false };
      });
      if (!changed) return state;
      return { entriesByThreadKey: withQueue(state.entriesByThreadKey, key, next) };
    }),
  remove: (ref, id) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const entries = state.entriesByThreadKey[key];
      if (!entries) return state;
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return state;
      return { entriesByThreadKey: withQueue(state.entriesByThreadKey, key, next) };
    }),
}));

/**
 * One thread's queue, oldest first. Returns a shared empty array so an unarmed
 * thread does not hand a new identity to every subscriber on every store write.
 */
export function selectQueuedSends(
  entriesByThreadKey: Record<string, ReadonlyArray<QueuedSendEntry>>,
  ref: ScopedThreadRef | null,
): ReadonlyArray<QueuedSendEntry> {
  if (ref === null) return NO_QUEUED_ENTRIES;
  return entriesByThreadKey[scopedThreadKey(ref)] ?? NO_QUEUED_ENTRIES;
}

/**
 * The entry that is the composer's live draft, if the draft is queued at all.
 * This is what the queue button reflects: it is a toggle over *this* message,
 * not over the whole stack behind it.
 */
export function selectDraftQueuedSend(
  entriesByThreadKey: Record<string, ReadonlyArray<QueuedSendEntry>>,
  ref: ScopedThreadRef | null,
): QueuedSendEntry | null {
  const entries = selectQueuedSends(entriesByThreadKey, ref);
  const tail = entries[entries.length - 1];
  return tail && tail.tracksDraft ? tail : null;
}

/**
 * Releases this thread has already been accounted for, or null when the tab
 * has never seen it — which the caller must adopt rather than treat as zero.
 */
export function selectHandledReleaseCount(
  handledReleaseByThreadKey: Record<string, number>,
  ref: ScopedThreadRef | null,
): number | null {
  if (ref === null) return null;
  return handledReleaseByThreadKey[scopedThreadKey(ref)] ?? null;
}

/** Did the user cancel this thread's own draft queue since they last armed it? */
export function selectDraftQueueCancelled(
  cancelledDraftByThreadKey: Record<string, boolean>,
  ref: ScopedThreadRef | null,
): boolean {
  return ref !== null && cancelledDraftByThreadKey[scopedThreadKey(ref)] === true;
}

/**
 * Is a claimed entry for this thread still unaccounted for by the server?
 *
 * True from the claim until the thread's session reports a state the claim did
 * not see. Not until the RPC resolves — that ack races the session projection
 * and wins, which is what let a three-message queue go out as three turns in
 * 175 ms. `sessionUpdatedAt` is the caller's *current* reading of
 * `session.updatedAt`; pass `null` for a thread with no session yet.
 *
 * The mark is left behind once it expires rather than swept: it is one entry
 * per thread, the next claim overwrites it, and `session.updatedAt` only ever
 * moves forward, so a stale mark can never match again.
 */
export function selectQueuedDispatchInFlight(
  dispatchingByThreadKey: Record<string, QueuedDispatchMark>,
  ref: ScopedThreadRef | null,
  sessionUpdatedAt: string | null,
): boolean {
  if (ref === null) return false;
  const mark = dispatchingByThreadKey[scopedThreadKey(ref)];
  if (mark === undefined) return false;
  return mark.sessionUpdatedAt === sessionUpdatedAt;
}

/**
 * Claims the head synchronously: returns the oldest entry and removes it in
 * the same tick, so only the first caller of a given arm ever sends. The
 * composer's active-thread path and the background watcher both go through
 * this. Entries behind the head keep their order and stay queued.
 *
 * `sessionUpdatedAt` is the thread's `session.updatedAt` as the claimer sees it
 * right now — the state this send is about to invalidate. Everything queued
 * behind it waits until the server reports something newer.
 */
export function claimQueuedSend(
  ref: ScopedThreadRef,
  sessionUpdatedAt: string | null,
): QueuedSendEntry | null {
  const key = scopedThreadKey(ref);
  const state = useQueuedSendStore.getState();
  const entries = state.entriesByThreadKey[key];
  const head = entries?.[0];
  if (!head) return null;
  useQueuedSendStore.setState({
    entriesByThreadKey: withQueue(state.entriesByThreadKey, key, entries.slice(1)),
    releaseCountByThreadKey: {
      ...state.releaseCountByThreadKey,
      [key]: (state.releaseCountByThreadKey[key] ?? 0) + 1,
    },
    // Expires by itself once the server moves past this mark. Whoever claims
    // still owes a `finishQueuedDispatch` on the FAILURE path — a send that
    // never reached the server never moves the session, so the mark would
    // otherwise hold forever and strand the rest of the queue.
    dispatchingByThreadKey: { ...state.dispatchingByThreadKey, [key]: { sessionUpdatedAt } },
  });
  return head;
}
