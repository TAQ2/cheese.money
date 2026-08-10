import { useEffect, useMemo, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@ch3tools/contracts";
import { scopedThreadKey } from "@ch3tools/client-runtime/environment";

import { newMessageId } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { claimQueuedSend, useQueuedSendStore, type QueuedSendEntry } from "../queuedSendStore";
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
 * The active thread is deliberately excluded: the composer releases that one
 * itself, keeping the optimistic message and scroll anchor a visible send
 * needs.
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
      {backgroundEntries.map(({ threadKey, entry }) => (
        <QueuedThreadSendWatcher key={threadKey} entry={entry} />
      ))}
    </>
  );
}

/** One armed, inactive thread. Renders nothing; it exists for its subscription. */
function QueuedThreadSendWatcher({ entry }: { entry: QueuedSendEntry }) {
  const { ref, snapshot } = entry;
  const shell = useThreadShell(ref);
  const startThreadTurn = useStartThreadTurn();
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  // The effect can re-run before the store update that disarms lands.
  const sentRef = useRef(false);

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
    });
    if (decision.kind === "wait" || shell === null) return;
    if (decision.kind === "drop") {
      useQueuedSendStore.getState().disarm(ref);
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
    // Claiming disarms in the same tick, so the composer's own release path
    // can never also send this one.
    if (claimQueuedSend(ref) === null) return;
    sentRef.current = true;
    // The queue is already consumed, so a throw here would lose the message
    // silently. Reading an attachment can genuinely fail.
    dispatchQueuedSend({
      ref,
      entry,
      startThreadTurn,
      clearComposerDraftContent,
      threadTitle,
    }).catch(() => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Queued message failed to send",
          description: `${threadTitle}: the message could not be prepared. The draft is still there.`,
        }),
      );
    });
  }, [clearComposerDraftContent, entry, phase, ref, shell, snapshot, startThreadTurn, threadTitle]);

  return null;
}

async function dispatchQueuedSend(params: {
  ref: ScopedThreadRef;
  entry: QueuedSendEntry;
  startThreadTurn: ReturnType<typeof useStartThreadTurn>;
  clearComposerDraftContent: (ref: ScopedThreadRef) => void;
  threadTitle: string;
}): Promise<void> {
  const { ref, entry, startThreadTurn, clearComposerDraftContent, threadTitle } = params;
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
    return;
  }
  const draftUnchanged = shouldClearDraftAfterQueuedSend(
    entry,
    useComposerDraftStore.getState().getComposerDraft(ref),
  );
  if (draftUnchanged) {
    clearComposerDraftContent(ref);
  }
  // The send happened off-screen, so it has to be announced.
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: "Queued message sent",
      description: draftUnchanged
        ? `${threadTitle} finished, so the message you queued went out.`
        : `${threadTitle} finished, so the message you queued went out. Edits you made after queuing are still in its composer.`,
    }),
  );
}
