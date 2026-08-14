import { WS_METHODS } from "@ch3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadKanbanInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  createThread,
  deleteThread,
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadKanban,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  ArchiveThreadInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadKanbanInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    updateKanban: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-kanban",
      execute: (input: UpdateThreadKanbanInput) => updateThreadKanban(input),
      scheduler,
      concurrency,
    }),
    /**
     * The provider CLI's own conversation id (what `claude --resume` takes),
     * which is not the CH3 thread id.
     */
    getProviderSessionId: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:get-provider-session-id",
      tag: WS_METHODS.threadsGetProviderSessionId,
      scheduler,
      concurrency,
    }),
    /**
     * MCP server statuses from the thread's live provider session. Read over
     * the CLI's local control channel — no model request, no token cost.
     */
    getMcpStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:get-mcp-status",
      tag: WS_METHODS.threadsGetMcpStatus,
      scheduler,
      concurrency,
    }),
    /**
     * One MCP server action (reconnect / authenticate / enable / disable) on
     * the live session, over the CLI's local control channel.
     */
    mcpServerAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:mcp-server-action",
      tag: WS_METHODS.threadsMcpServerAction,
      scheduler,
      concurrency,
    }),
    /** User messages the live session can rewind tracked files to. */
    listRewindTargets: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:list-rewind-targets",
      tag: WS_METHODS.threadsListRewindTargets,
      scheduler,
      concurrency,
    }),
    /** Restore tracked files to their state at a user message. */
    rewindFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:rewind-files",
      tag: WS_METHODS.threadsRewindFiles,
      scheduler,
      concurrency,
    }),
    /** Resolve an external Claude session id to the repository it ran in. */
    resolveExternalClaudeSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:resolve-external-claude-session",
      tag: WS_METHODS.claudeResolveExternalSession,
      scheduler,
      // Keyed on the session id — this lookup has no thread yet.
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId, input }: { environmentId: string; input: { sessionId: string } }) =>
          JSON.stringify([environmentId, input.sessionId]),
      },
    }),
    /** Bind a thread to an external Claude session so its next turn resumes it. */
    adoptClaudeSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:adopt-claude-session",
      tag: WS_METHODS.threadsAdoptClaudeSession,
      scheduler,
      concurrency,
    }),
    /** Drop an input and everything after it, and reposition the session. */
    rewindToInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:rewind-to-input",
      tag: WS_METHODS.threadsRewindToInput,
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
  };
}
