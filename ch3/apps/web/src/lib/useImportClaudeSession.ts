import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  type RuntimeMode,
} from "@ch3tools/contracts";
import { threadEnvironment } from "../state/threads";
import { createModelSelection, normalizeModelSlug } from "@ch3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { waitForStartedServerThread } from "../components/ChatView.logic";
import { scopeThreadRef } from "@ch3tools/client-runtime/environment";
import { useProjects } from "../state/entities";
import { primaryServerSettingsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { squashAtomCommandFailure } from "@ch3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newMessageId, newThreadId } from "./utils";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/** Full-string Claude session id (a UUID), as pasted by the user. */
export const CLAUDE_SESSION_ID_INPUT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ToastCopy {
  readonly title: string;
  readonly description: string;
}

/**
 * What the import says as it goes.
 *
 * Overridable because the two callers speak different languages: the composer
 * command and the new-thread palette are English, the orchestrator cockpit is
 * Spanish. Defaults are the English the palette has always shown.
 */
export interface ClaudeSessionImportCopy {
  readonly unresolved?: ToastCopy;
  readonly noProject?: ToastCopy;
  readonly createFailed?: ToastCopy;
  readonly bindFailed?: ToastCopy;
  /** The thread exists and is bound, but its opening turn never started. */
  readonly openingFailed?: ToastCopy;
  readonly success?: ToastCopy;
}

export interface ImportClaudeSessionOptions {
  /** Environment whose transcript store is scanned. */
  readonly environmentId: EnvironmentId;
  readonly runtimeMode?: RuntimeMode;
  /**
   * File the thread here instead of in whichever project contains the
   * session's recorded working directory.
   *
   * The lookup is still performed — it is what proves the transcript is on
   * this machine at the moment of acting — but its answer no longer decides
   * where the conversation lands. The orchestrator needs that: a run's session
   * was recorded inside the engine's own project, and a thread filed there
   * renders the cockpit instead of a chat.
   */
  readonly projectRef?: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  /** The conversation's name in the sidebar. */
  readonly title?: string;
  /**
   * Sent as the thread's first turn once the session is bound.
   *
   * A resumed session believes what it was told when it started. When that was
   * "nobody is watching, never ask a question", the caller has to say
   * otherwise on the first turn or the agent goes on guessing in front of a
   * person who is waiting to be asked.
   */
  readonly openingMessage?: string;
  /**
   * The model the conversation being imported ran on, when the caller knows
   * it. The resumed thread opens on it rather than on the Claude default — a
   * conversation keeps its model, and the follow-up to an Opus run answering
   * as Sonnet is a downgrade nobody asked for and nothing announces.
   */
  readonly model?: string | null;
  readonly copy?: ClaudeSessionImportCopy;
}

/** Enough of a project to file a thread in it. */
export interface ClaudeSessionImportTarget {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly defaultModelSelection: ModelSelection | null;
}

/**
 * Which project the imported conversation is filed in.
 *
 * Without a `projectRef` this is a lookup: the project rooted at the session's
 * recorded working directory, or the one that contains it.
 *
 * **With a `projectRef` the caller is believed, whether or not the project is
 * in the list yet.** That is the whole point of the parameter. The cockpit
 * creates the project and imports into it in one invocation, and the project
 * list a React callback closed over cannot contain a project created a moment
 * ago — so resolving the ref *through* the list failed the first click every
 * time, reported the workspace as unavailable when it had just been made, and
 * worked on the second click. The list is still consulted, but only for what
 * it can add: the project's own default model.
 */
export function resolveImportTarget(input: {
  readonly projectRef: ImportClaudeSessionOptions["projectRef"];
  readonly cwd: string;
  readonly projects: ReadonlyArray<ClaudeSessionImportTarget & { readonly workspaceRoot: string }>;
}): ClaudeSessionImportTarget | null {
  const ref = input.projectRef;
  if (ref === undefined) {
    return (
      input.projects.find((candidate) => candidate.workspaceRoot === input.cwd) ??
      input.projects.find((candidate) => input.cwd.startsWith(`${candidate.workspaceRoot}/`)) ??
      null
    );
  }
  return (
    input.projects.find(
      (candidate) =>
        candidate.id === ref.projectId && candidate.environmentId === ref.environmentId,
    ) ?? {
      id: ref.projectId,
      environmentId: ref.environmentId,
      defaultModelSelection: null,
    }
  );
}

/** Every model this driver carries is named `claude-*`; see `resolveImportModelSelection`. */
const CLAUDE_MODEL_SLUG_PREFIX = "claude-";

/**
 * The model the imported conversation opens on.
 *
 * **The conversation keeps the model it ran on.** A resumed session is the same
 * conversation, and reopening it anywhere else is a silent downgrade: the run
 * that adjudicated a decision on Fable 5.1 came back on Sonnet, answered from a
 * smaller context, and nothing on screen said the model had changed. So a
 * caller that knows what the session ran on — the orchestrator cockpit reads it
 * from the run's own `run_state.json` — hands it over here and it wins.
 *
 * `normalizeModelSlug` rather than the raw string, because the recorded id is
 * whatever the engine wrote: a bare `sonnet`, a dated `claude-opus-5-20260218`,
 * or a retired `claude-fable-5`. Each of those aliases to the slug the
 * catalogue lists.
 *
 * A recorded id it cannot alias is returned unchanged, so the result is checked
 * for the `claude-` prefix before it is trusted. That id is third-party data —
 * whatever the engine wrote into its own state file — and handing a Claude
 * instance a non-Claude slug produces a thread whose first turn comes back
 * "There is an issue with the selected model (gpt-5.6-sol)", which is exactly
 * the failure the tier default below already exists to prevent. A prefix rather
 * than a catalogue lookup, because the catalogue is per seat tier and a
 * conversation may legitimately have run on a model this seat cannot pick today
 * — that is what the retired-slug aliases are for.
 *
 * Only the **model** comes from the run. Effort, context window and response
 * style stay the project's, so a project that runs Caveman does not reopen in
 * the default voice just because the conversation's model won.
 *
 * Then the project's own default, whole, and only when it is a Claude
 * selection: the cursor being bound is a Claude Code session id, and a binding
 * recorded under any other instance is ignored at session start — the thread
 * would open a brand new conversation while reporting that it resumed one.
 */
export function resolveImportModelSelection(input: {
  readonly ranOn: string | null | undefined;
  readonly projectDefault: ModelSelection | null;
}): ModelSelection {
  const claudeDriverKind = ProviderDriverKind.make(CLAUDE_DRIVER_KIND);
  const claudeDefaultInstanceId = defaultInstanceIdForDriver(claudeDriverKind);
  const ranOn = normalizeModelSlug(input.ranOn, claudeDriverKind);
  const projectDefault = input.projectDefault;
  const claudeProjectDefault =
    projectDefault && projectDefault.instanceId === claudeDefaultInstanceId ? projectDefault : null;
  if (ranOn !== null && ranOn.startsWith(CLAUDE_MODEL_SLUG_PREFIX)) {
    return createModelSelection(claudeDefaultInstanceId, ranOn, claudeProjectDefault?.options);
  }
  if (claudeProjectDefault) {
    return claudeProjectDefault;
  }
  return createModelSelection(
    claudeDefaultInstanceId,
    // A Claude instance needs a Claude model. `DEFAULT_MODEL` is Codex's, and
    // pairing the two produced a thread whose first turn came back "There is
    // an issue with the selected model (gpt-5.6-sol)" — seen live, on a real
    // imported session.
    DEFAULT_MODEL_BY_PROVIDER[claudeDriverKind] ?? DEFAULT_MODEL,
  );
}

function warn(fallback: ToastCopy, override: ToastCopy | undefined, detail?: string) {
  const copy = override ?? fallback;
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: copy.title,
      description: detail && detail.length > 0 ? detail : copy.description,
    }),
  );
}

/**
 * Imports an external Claude Code conversation: resolves the session id to
 * the repository it was recorded in (from the CLI's own transcript store),
 * creates a new thread in the matching CH3 project, binds the id so the
 * thread's first turn resumes the conversation natively, and navigates
 * there. Shared by the composer's /resume command, the new-thread palette and
 * the cockpit's "talk to the agent that led this run". Every failure surfaces
 * as a toast that names the way out.
 *
 * This is the only path that binds a session id to a thread. A second one
 * would be a second place to get the instance id wrong, and getting it wrong
 * is silent: the cursor is ignored and the "resumed" thread starts a brand new
 * conversation that looks exactly like a working one.
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
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  // New-thread defaults live in the primary environment's settings.json, the
  // only one the settings UI writes to. An import with no thread to inherit
  // from is a new thread like any other, so it opens on the configured mode
  // rather than the shipped one.
  const defaultRuntimeMode = useAtomValue(primaryServerSettingsAtom).defaultRuntimeMode;

  return useCallback(
    async (sessionId: string, options: ImportClaudeSessionOptions) => {
      const copy = options.copy ?? {};
      const resolved = await resolveExternalClaudeSession({
        environmentId: options.environmentId,
        input: { sessionId },
      });
      if (resolved._tag === "Failure") {
        const error = squashAtomCommandFailure(resolved) as Partial<{ detail: string }> | null;
        warn(
          {
            title: "Could not resolve the Claude session",
            description: "The session id was not found in the Claude transcript store.",
          },
          copy.unresolved,
          error?.detail,
        );
        return;
      }
      const cwd = resolved.value.cwd;
      const target = resolveImportTarget({
        projectRef: options.projectRef,
        cwd,
        projects: allProjects,
      });
      if (!target) {
        warn(
          {
            title: "No CH3 project for that session",
            description: `The session ran in ${cwd}. Add that folder as a project first, then paste ${sessionId} again.`,
          },
          copy.noProject,
        );
        return;
      }
      const createdAt = new Date().toISOString();
      const nextThreadId = newThreadId();
      const modelSelection = resolveImportModelSelection({
        ranOn: options.model,
        projectDefault: target.defaultModelSelection,
      });
      const createResult = await createThread({
        environmentId: target.environmentId,
        input: {
          threadId: nextThreadId,
          projectId: target.id,
          title: options.title ?? `Resumed session ${sessionId.slice(0, 8)}`,
          modelSelection,
          runtimeMode: options.runtimeMode ?? defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      if (createResult._tag === "Failure") {
        warn(
          {
            title: "Could not create the thread",
            description: "Thread creation failed; the session was not imported.",
          },
          copy.createFailed,
        );
        return;
      }
      const adopted = await adoptClaudeSession({
        environmentId: target.environmentId,
        input: {
          threadId: nextThreadId,
          sessionId,
          providerInstanceId: modelSelection.instanceId,
        },
      });
      if (adopted._tag === "Failure") {
        const error = squashAtomCommandFailure(adopted) as Partial<{ detail: string }> | null;
        warn(
          {
            title: "Could not bind the session",
            description: "The thread was created but the session id could not be bound to it.",
          },
          copy.bindFailed,
          error?.detail,
        );
        return;
      }
      // Navigating before the client store knows the thread bounces the
      // router back to the draft page — wait for the thread (its seeded
      // messages satisfy the started check), then jump to it.
      await waitForStartedServerThread(scopeThreadRef(target.environmentId, nextThreadId), 5_000);
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: target.environmentId,
          threadId: nextThreadId,
        },
      });
      if (options.openingMessage !== undefined && options.openingMessage.trim().length > 0) {
        // After the navigation, so the person watches the answer arrive rather
        // than landing on a conversation that is already mid-turn.
        const opened = await startThreadTurn({
          environmentId: target.environmentId,
          input: {
            threadId: nextThreadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: options.openingMessage,
              attachments: [],
            },
            modelSelection,
            runtimeMode: options.runtimeMode ?? defaultRuntimeMode,
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });
        // Not decoration. The opening message is what tells a resumed session
        // that the conditions it started under no longer hold — for a finished
        // orchestrator run, that a human is present and questions are allowed
        // again. A turn that silently failed leaves the agent believing nobody
        // is watching, so this reports rather than congratulates.
        if (opened._tag === "Failure") {
          const error = squashAtomCommandFailure(opened) as Partial<{ detail: string }> | null;
          warn(
            {
              title: "The session was resumed, but its first message did not send",
              description:
                "The conversation is here and bound to the session. Send the first message yourself.",
            },
            copy.openingFailed,
            error?.detail,
          );
          return;
        }
      }
      const success = copy.success ?? {
        title: "Claude session imported",
        description:
          "Send any message in this thread — it resumes the original conversation from where it left off.",
      };
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: success.title,
          description: success.description,
        }),
      );
    },
    [
      adoptClaudeSession,
      allProjects,
      createThread,
      defaultRuntimeMode,
      navigate,
      resolveExternalClaudeSession,
      startThreadTurn,
    ],
  );
}
