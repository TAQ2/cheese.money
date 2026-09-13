/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderMcpServerStatus,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@ch3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

/** A session rebuilt at boot around a process that survived the restart. */
export interface ProviderReattachedSession {
  readonly session: ProviderSession;
  /** The turn the previous server was in the middle of, or null when idle. */
  readonly activeTurnId: string | null;
  /** The MCP credential the live process was given, for the registry to adopt. */
  readonly mcpSession: McpProviderSessionConfig | null;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Read the live session's MCP server statuses over the provider CLI's
   * local control channel. Optional — only providers whose runtime exposes
   * an MCP status control implement it. This is stdio to the local
   * subprocess, never a model request: it consumes no tokens and bills
   * nothing.
   */
  readonly mcpServerStatus?: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProviderMcpServerStatus>, TError>;

  /**
   * Execute one MCP server action (reconnect / authenticate / enable /
   * disable) over the provider CLI's local control channel, then return the
   * fresh statuses. Optional — same support caveat as mcpServerStatus.
   * Authentication may return a URL the client has to open in the browser.
   */
  readonly mcpServerAction?: (
    threadId: ThreadId,
    serverName: string,
    action: "reconnect" | "authenticate" | "clear-auth" | "enable" | "disable",
  ) => Effect.Effect<
    {
      readonly servers: ReadonlyArray<ProviderMcpServerStatus>;
      readonly authUrl?: string;
    },
    TError
  >;

  /**
   * List user messages the live session can rewind tracked files to.
   * Optional — only providers with a native checkpointing control implement
   * it. Targets cover only messages seen by the current session process.
   */
  readonly listRewindTargets?: (
    threadId: ThreadId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly createdAt: string; readonly preview: string }>,
    TError
  >;

  /**
   * Restore tracked files to their state at a user message (dryRun previews
   * without touching files). Local control request — no model turn.
   */
  readonly rewindFiles?: (
    threadId: ThreadId,
    userMessageId: string,
    options: { readonly dryRun: boolean },
  ) => Effect.Effect<
    {
      readonly canRewind: boolean;
      readonly error?: string;
      readonly filesChanged?: ReadonlyArray<string>;
      readonly insertions?: number;
      readonly deletions?: number;
    },
    TError
  >;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Let go of every session whose process can outlive this server without
   * stopping it, and say which threads were let go. Only an adapter whose
   * processes run behind a keeper has one; the rest are stopped by `stopAll`.
   */
  readonly detachAll?: () => Effect.Effect<ReadonlyArray<ThreadId>, TError>;

  /**
   * Rebuild every session a previous server let go of and whose process is
   * still alive. Runs once at boot, before the reconcilers decide what the
   * previous server lost.
   */
  /**
   * Take back every session a previous server left running.
   *
   * `knownInstanceIds` is every provider instance this server is configured
   * with. An adapter that keeps per-instance state on disk uses it to tell
   * "another instance will claim this" from "nobody ever will": the second is
   * a process left holding a CLI that no restart can reach, and it is retired
   * rather than skipped.
   */
  readonly reattachAll?: (
    knownInstanceIds?: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<ProviderReattachedSession>, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
