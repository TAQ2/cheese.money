/**
 * Copying a thread's provider conversation id.
 *
 * Shared because the inbox and the board both offer it, and the id is not a
 * field either of them holds: it is the provider CLI's own session id — what
 * `claude --resume` takes — which lives in the thread's resume cursor rather
 * than in the read model, so reading it is a round-trip that can fail, come
 * back empty, or be interrupted. Three outcomes, each with its own message.
 *
 * That is exactly the kind of handler that gets half-copied into the second
 * caller and then drifts. One implementation, two menus.
 *
 * Not the same identifier as the id on a thread's chip, which is CH3's own
 * and exists from the moment the thread does.
 */
import type { EnvironmentId, ThreadId } from "@ch3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@ch3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useCopyToClipboard } from "./useCopyToClipboard";

export function useCopyConversationId(): (threadRef: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) => Promise<void> {
  const getProviderSessionId = useAtomCommand(threadEnvironment.getProviderSessionId);
  const { copyToClipboard } = useCopyToClipboard<{ sessionId: string }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Conversation ID copied",
        description: ctx.sessionId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy conversation ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });

  return useCallback(
    async (threadRef) => {
      const sessionResult = await getProviderSessionId({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (sessionResult._tag === "Failure") {
        // An interruption is the user navigating away, not a failure to report.
        if (isAtomCommandInterrupted(sessionResult)) return;
        const error = squashAtomCommandFailure(sessionResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not read conversation ID",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const sessionId = sessionResult.value.sessionId;
      if (sessionId === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "No conversation ID yet",
            description: "This thread has not started a provider session.",
          }),
        );
        return;
      }
      copyToClipboard(sessionId, { sessionId });
    },
    [copyToClipboard, getProviderSessionId],
  );
}

/**
 * Copy CH3's own thread id.
 *
 * A plain field read — no round-trip, and it exists from the moment the thread
 * does, which is the whole difference from the conversation id above. Shared
 * for the toasts rather than the lookup: three menus offered this and each
 * carried its own copy of the success and failure wording.
 */
export function useCopyThreadId(): (threadId: ThreadId) => void {
  const { copyToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  return useCallback((threadId) => copyToClipboard(threadId, { threadId }), [copyToClipboard]);
}
