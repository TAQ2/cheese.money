import { useEffect, useMemo, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import type { ProviderInteractionMode, RuntimeMode, ScopedThreadRef } from "@ch3tools/contracts";
import { scopedThreadKey } from "@ch3tools/client-runtime/environment";

import { newMessageId } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  claimQueuedSend,
  selectQueuedDispatchInFlight,
  useQueuedSendStore,
  type QueuedSendEntry,
} from "../queuedSendStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../threadRoutes";
import { derivePhase } from "../session-logic";
import { useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { readFileAsDataUrl } from "./ChatView.logic";
import {
  buildQueuedTurnInput,
  decideQueuedSend,
  selectBackgroundQueuedEntries,
  shouldClearDraftAfterQueuedSend,
} from "./QueuedSendWatcher.logic";

function useStartThreadTurn() {
  return useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
}

function useSetThreadRuntimeMode() {
  return useAtomCommand(threadEnvironment.setRuntimeMode, { reportFailure: false });
}

function useSetThreadInteractionMode() {
  return useAtomCommand(threadEnvironment.setInteractionMode, { reportFailure: false });
}

/**
 * Releases queued sends for threads the user is *not* looking at.
 *
 * The composer's own release effect only runs while its thread is mounted, so
 * without this a queue armed before switching threads sat dormant and fired on
 * the user's return instead of when the turn ended. Mounted in the app shell
 * rather than the chat route, so it also survives a trip to Settings — a
 * sibling top-level route that would otherwise unmount it and reproduce the
 * original bug.
 *
 * The active thread's own draft is deliberately excluded: the composer
 * releases that one itself, keeping the optimistic message and scroll anchor a
 * visible send needs. Messages stacked *behind* that draft are this watcher's
 * even while the thread is on screen — they are frozen, the composer no longer
 * carries them, so nothing else would send them.
 */
export function QueuedSendWatcher() {
  const entriesByThreadKey = useQueuedSendStore((store) => store.entriesByThreadKey);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  // A promoted draft keeps rendering the draft route while its server thread
  // starts, so the route params alone would report "no active thread" and hand
  // the on-screen thread to this watcher.
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const activeThreadRef = resolveActiveThreadRouteRef(routeTarget ?? null, draftSession);
  const activeThreadKey = activeThreadRef === null ? null : scopedThreadKey(activeThreadRef);
  const backgroundEntries = useMemo(
    () => selectBackgroundQueuedEntries(entriesByThreadKey, activeThreadKey),
    [activeThreadKey, entriesByThreadKey],
  );

  return (
    <>
      {backgroundEntries.map(({ entry }) => (
        // Keyed by entry, not by thread: when the head is sent the next entry
        // takes its place, and a reused instance would still be carrying
        // `sentRef` from the message before it and so send nothing.
        <QueuedThreadSendWatcher key={entry.id} entry={entry} />
      ))}
    </>
  );
}

/** One queued send. Renders nothing; it exists for its subscription. */
function QueuedThreadSendWatcher({ entry }: { entry: QueuedSendEntry }) {
  const { ref, snapshot } = entry;
  const shell = useThreadShell(ref);
  const startThreadTurn = useStartThreadTurn();
  const setThreadRuntimeMode = useSetThreadRuntimeMode();
  const setThreadInteractionMode = useSetThreadInteractionMode();
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  // The effect can re-run before the store update that removes the entry
  // lands.
  const sentRef = useRef(false);

  const sessionUpdatedAt = shell?.session?.updatedAt ?? null;
  const dispatchInFlight = useQueuedSendStore((store) =>
    selectQueuedDispatchInFlight(store.dispatchingByThreadKey, ref, sessionUpdatedAt),
  );
  const phase = derivePhase(shell?.session ?? null);
  const threadTitle = shell?.title ?? "a thread";

  useEffect(() => {
    if (sentRef.current) return;
    const decision = decideQueuedSend({
      hasShell: shell !== null,
      phase,
      text: snapshot.text,
      images: snapshot.images,
      hasSendableContent: snapshot.hasSendableContent,
      interactiveBuiltin: snapshot.interactiveBuiltin,
      dispatchInFlight,
    });
    if (decision.kind === "wait" || shell === null) return;
    if (decision.kind === "drop") {
      useQueuedSendStore.getState().remove(ref, entry.id);
      if (decision.reason !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Queued message not sent",
            description: `${threadTitle}: ${decision.reason}`,
          }),
        );
      }
      return;
    }
    // Claiming removes the entry in the same tick, so the composer's own
    // release path can never also send this one. The session reading goes with
    // it: everything behind this entry waits for the server to report past it.
    if (claimQueuedSend(ref, sessionUpdatedAt) === null) return;
    sentRef.current = true;
    // The queue is already consumed, so a throw here would lose the message
    // silently. Reading an attachment can genuinely fail.
    dispatchQueuedSend({
      ref,
      entry,
      startThreadTurn,
      setThreadRuntimeMode,
      setThreadInteractionMode,
      threadRuntimeMode: shell?.runtimeMode ?? null,
      threadInteractionMode: shell?.interactionMode ?? null,
      clearComposerDraftContent,
      threadTitle,
    })
      // Released ONLY when the send did not reach the server. A send that did
      // is released by the session moving past the mark the claim took —
      // releasing on the ack instead is what let three queued messages go out
      // as three turns inside 175 ms, each seeing a `phase` that had not
      // caught up yet.
      .then((sent) => {
        if (!sent) useQueuedSendStore.getState().finishQueuedDispatch(ref);
      })
      .catch(() => {
        // A thread left marked would never send the rest of its queue, which
        // is a worse failure than the one that got us here.
        useQueuedSendStore.getState().finishQueuedDispatch(ref);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Queued message failed to send",
            description: `${threadTitle}: the message could not be prepared. The draft is still there.`,
          }),
        );
      });
  }, [
    clearComposerDraftContent,
    dispatchInFlight,
    entry,
    phase,
    ref,
    sessionUpdatedAt,
    setThreadInteractionMode,
    setThreadRuntimeMode,
    shell,
    snapshot,
    startThreadTurn,
    threadTitle,
  ]);

  return null;
}

/**
 * Sends one claimed entry. Resolves true when the turn reached the server —
 * which is what lets the queue's dispatch gate stand until the session moves —
 * and false when it did not, so the caller can release the gate by hand.
 */
async function dispatchQueuedSend(params: {
  ref: ScopedThreadRef;
  entry: QueuedSendEntry;
  startThreadTurn: ReturnType<typeof useStartThreadTurn>;
  setThreadRuntimeMode: ReturnType<typeof useSetThreadRuntimeMode>;
  setThreadInteractionMode: ReturnType<typeof useSetThreadInteractionMode>;
  threadRuntimeMode: RuntimeMode | null;
  threadInteractionMode: ProviderInteractionMode | null;
  clearComposerDraftContent: (ref: ScopedThreadRef) => void;
  threadTitle: string;
}): Promise<boolean> {
  const {
    ref,
    entry,
    startThreadTurn,
    setThreadRuntimeMode,
    setThreadInteractionMode,
    threadRuntimeMode,
    threadInteractionMode,
    clearComposerDraftContent,
    threadTitle,
  } = params;
  // The modes the message was queued WITH have to be made the thread's before
  // the turn starts, because the turn does not carry them: the decider reads
  // `targetThread.runtimeMode`, not the command's, and it is right to — the
  // command's modes have a decoding default, so honouring them would let any
  // caller that omits them reset the thread. So the sender persists first,
  // exactly as the composer's own send path does.
  //
  // Without this a message queued in Plan mode ran in build mode and edited
  // files, because the composer only persists the mode for the send it makes
  // itself, and a stacked message is sent from here instead.
  const createdAt = new Date().toISOString();
  if (threadRuntimeMode !== null && entry.snapshot.runtimeMode !== threadRuntimeMode) {
    await setThreadRuntimeMode({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, runtimeMode: entry.snapshot.runtimeMode, createdAt },
    });
  }
  if (threadInteractionMode !== null && entry.snapshot.interactionMode !== threadInteractionMode) {
    await setThreadInteractionMode({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        interactionMode: entry.snapshot.interactionMode,
        createdAt,
      },
    });
  }
  const attachments = await Promise.all(
    entry.snapshot.images.map(async (image) => ({
      type: "image" as const,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await readFileAsDataUrl(image.file),
    })),
  );
  const result = await startThreadTurn({
    environmentId: ref.environmentId,
    input: buildQueuedTurnInput({
      entry,
      messageId: newMessageId(),
      createdAt: new Date().toISOString(),
      attachments,
    }),
  });
  if (result._tag === "Failure") {
    // The draft is intentionally left intact so the message is recoverable.
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Queued message failed to send",
        description: `${threadTitle}: the turn could not be started. The draft is still there.`,
      }),
    );
    return false;
  }
  const draftUnchanged = shouldClearDraftAfterQueuedSend(
    entry,
    useComposerDraftStore.getState().getComposerDraft(ref),
  );
  if (draftUnchanged) {
    clearComposerDraftContent(ref);
  }
  // The send is not attached to anything the user is typing — either the
  // thread is off-screen, or this was a stacked message the composer stopped
  // carrying — so it has to be announced.
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: "Queued message sent",
      description: !entry.tracksDraft
        ? // Saying "still in its composer" here would be a lie: the composer
          // holds the *next* message, not an edit of this one.
          `${threadTitle} finished, so the next message in its queue went out.`
        : draftUnchanged
          ? `${threadTitle} finished, so the message you queued went out.`
          : `${threadTitle} finished, so the message you queued went out. Edits you made after queuing are still in its composer.`,
    }),
  );
  return true;
}
