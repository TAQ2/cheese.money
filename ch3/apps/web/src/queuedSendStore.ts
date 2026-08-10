import { create } from "zustand";
import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
} from "@ch3tools/contracts";
import { scopedThreadKey } from "@ch3tools/client-runtime/environment";

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
  readonly ref: ScopedThreadRef;
  readonly snapshot: QueuedSendSnapshot;
}

interface QueuedSendStoreState {
  /** Armed threads keyed by `scopedThreadKey`. */
  entriesByThreadKey: Record<string, QueuedSendEntry>;
  arm: (ref: ScopedThreadRef, snapshot: QueuedSendSnapshot) => void;
  /**
   * Re-freezes an already-armed thread. A no-op when the thread is not armed,
   * so the composer can push every keystroke without racing a release that
   * already fired.
   */
  refresh: (ref: ScopedThreadRef, snapshot: QueuedSendSnapshot) => void;
  disarm: (ref: ScopedThreadRef) => void;
}

/**
 * Sends held until their thread's agent finishes.
 *
 * Deliberately in-memory and deliberately *not* a field on
 * `composerDraftStore`: that store persists through schema migrations, and a
 * queue that outlived a reload would point at a draft the user has since
 * changed. A queue that dies with the tab is the honest behaviour.
 */
export const useQueuedSendStore = create<QueuedSendStoreState>((set) => ({
  entriesByThreadKey: {},
  arm: (ref, snapshot) =>
    set((state) => ({
      entriesByThreadKey: {
        ...state.entriesByThreadKey,
        [scopedThreadKey(ref)]: { ref, snapshot },
      },
    })),
  refresh: (ref, snapshot) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!state.entriesByThreadKey[key]) return state;
      return { entriesByThreadKey: { ...state.entriesByThreadKey, [key]: { ref, snapshot } } };
    }),
  disarm: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!state.entriesByThreadKey[key]) return state;
      const next = { ...state.entriesByThreadKey };
      delete next[key];
      return { entriesByThreadKey: next };
    }),
}));

export function selectIsQueuedSendArmed(
  entriesByThreadKey: Record<string, QueuedSendEntry>,
  ref: ScopedThreadRef | null,
): boolean {
  return ref !== null && entriesByThreadKey[scopedThreadKey(ref)] !== undefined;
}

/**
 * Claims the release synchronously: returns the entry and disarms in the same
 * tick, so only the first caller of a given arm ever sends. The composer's
 * active-thread path and the background watcher both go through this.
 */
export function claimQueuedSend(ref: ScopedThreadRef): QueuedSendEntry | null {
  const key = scopedThreadKey(ref);
  const entry = useQueuedSendStore.getState().entriesByThreadKey[key];
  if (!entry) return null;
  useQueuedSendStore.getState().disarm(ref);
  return entry;
}
