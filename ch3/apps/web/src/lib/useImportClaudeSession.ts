import {
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ProviderDriverKind,
  type RuntimeMode,
} from "@ch3tools/contracts";
import { threadEnvironment } from "../state/threads";
import { createModelSelection } from "@ch3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { DEFAULT_RUNTIME_MODE } from "../types";
import { waitForStartedServerThread } from "../components/ChatView.logic";
import { scopeThreadRef } from "@ch3tools/client-runtime/environment";
import { useProjects } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { squashAtomCommandFailure } from "@ch3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId } from "./utils";

/** Full-string Claude session id (a UUID), as pasted by the user. */
export const CLAUDE_SESSION_ID_INPUT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Imports an external Claude Code conversation: resolves the session id to
 * the repository it was recorded in (from the CLI's own transcript store),
 * creates a new thread in the matching CH3 project, binds the id so the
 * thread's first turn resumes the conversation natively, and navigates
 * there. Shared by the composer's /resume command and the new-thread
 * palette. Every failure surfaces as a toast that names the way out.
 */
export function useImportClaudeSession() {
  const navigate = useNavigate();
  const allProjects = useProjects();
  const resolveExternalClaudeSession = useAtomCommand(
    threadEnvironment.resolveExternalClaudeSession,
    { reportFailure: false },
  );
  const adoptClaudeSession = useAtomCommand(threadEnvironment.adoptClaudeSession, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  return useCallback(
    async (
      sessionId: string,
      options: {
        /** Environment whose transcript store is scanned. */
        readonly environmentId: EnvironmentId;
        readonly runtimeMode?: RuntimeMode;
      },
    ) => {
      const resolved = await resolveExternalClaudeSession({
        environmentId: options.environmentId,
        input: { sessionId },
      });
      if (resolved._tag === "Failure") {
        const error = squashAtomCommandFailure(resolved) as Partial<{ detail: string }> | null;
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not resolve the Claude session",
            description:
              error?.detail && error.detail.length > 0
                ? error.detail
                : "The session id was not found in the Claude transcript store.",
          }),
        );
        return;
      }
      const cwd = resolved.value.cwd;
      const project =
        allProjects.find((candidate) => candidate.workspaceRoot === cwd) ??
        allProjects.find((candidate) => cwd.startsWith(`${candidate.workspaceRoot}/`));
      if (!project) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "No CH3 project for that session",
            description: `The session ran in ${cwd}. Add that folder as a project first, then paste ${sessionId} again.`,
          }),
        );
        return;
      }
      const createdAt = new Date().toISOString();
      const nextThreadId = newThreadId();
      const modelSelection =
        project.defaultModelSelection ??
        createModelSelection(
          defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
          DEFAULT_MODEL,
        );
      const createResult = await createThread({
        environmentId: project.environmentId,
        input: {
          threadId: nextThreadId,
          projectId: project.id,
          title: `Resumed session ${sessionId.slice(0, 8)}`,
          modelSelection,
          runtimeMode: options.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      if (createResult._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not create the thread",
            description: "Thread creation failed; the session was not imported.",
          }),
        );
        return;
      }
      const adopted = await adoptClaudeSession({
        environmentId: project.environmentId,
        input: {
          threadId: nextThreadId,
          sessionId,
          providerInstanceId: modelSelection.instanceId,
        },
      });
      if (adopted._tag === "Failure") {
        const error = squashAtomCommandFailure(adopted) as Partial<{ detail: string }> | null;
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not bind the session",
            description:
              error?.detail && error.detail.length > 0
                ? error.detail
                : "The thread was created but the session id could not be bound to it.",
          }),
        );
        return;
      }
      // Navigating before the client store knows the thread bounces the
      // router back to the draft page — wait for the thread (its seeded
      // messages satisfy the started check), then jump to it.
      await waitForStartedServerThread(scopeThreadRef(project.environmentId, nextThreadId), 5_000);
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: project.environmentId,
          threadId: nextThreadId,
        },
      });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Claude session imported",
          description:
            "Send any message in this thread — it resumes the original conversation from where it left off.",
        }),
      );
    },
    [adoptClaudeSession, allProjects, createThread, navigate, resolveExternalClaudeSession],
  );
}
