/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderMcpServerStatus,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@ch3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  /**
   * Read MCP server statuses from the live provider session. Served over the
   * provider CLI's local control channel — never a model request, so it
   * consumes no tokens.
   */
  readonly getMcpStatus: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<ProviderMcpServerStatus>, ProviderServiceError>;

  /**
   * Execute one MCP server action (reconnect / authenticate / enable /
   * disable) on the live provider session, returning fresh statuses and,
   * for authentication, an optional URL to open in the browser. Local
   * control channel only — never a model request.
   */
  readonly mcpServerAction: (input: {
    readonly threadId: ThreadId;
    readonly serverName: string;
    readonly action: "reconnect" | "authenticate" | "clear-auth" | "enable" | "disable";
  }) => Effect.Effect<
    {
      readonly servers: ReadonlyArray<ProviderMcpServerStatus>;
      readonly authUrl?: string;
    },
    ProviderServiceError
  >;

  /**
   * List user messages the live session can rewind tracked files to.
   */
  readonly listRewindTargets: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly createdAt: string; readonly preview: string }>,
    ProviderServiceError
  >;

  /**
   * Restore tracked files to their state at a user message. dryRun previews
   * the change without touching files.
   */
  readonly rewindFiles: (input: {
    readonly threadId: ThreadId;
    readonly userMessageId: string;
    readonly dryRun: boolean;
  }) => Effect.Effect<
    {
      readonly canRewind: boolean;
      readonly error?: string;
      readonly filesChanged?: ReadonlyArray<string>;
      readonly insertions?: number;
      readonly deletions?: number;
    },
    ProviderServiceError
  >;

  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "ch3/provider/Services/ProviderService",
) {}
