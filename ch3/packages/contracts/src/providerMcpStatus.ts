import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Domain Types

export const ProviderMcpStatusInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderMcpStatusInput = typeof ProviderMcpStatusInput.Type;

/**
 * One MCP server as reported by the provider CLI's live session. Read over
 * the CLI's local control channel (stdio) — never an Anthropic API request,
 * so querying this consumes no tokens and bills nothing.
 */
export const ProviderMcpServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** connected | failed | needs-auth | pending | disabled — open union so a
      newer CLI can report states this build doesn't know yet. */
  status: TrimmedNonEmptyString,
  /** Error message when status is "failed". */
  error: Schema.optionalKey(Schema.String),
  /** Server-reported name/version when connected. */
  serverVersion: Schema.optionalKey(Schema.String),
  /** Configuration scope (project, user, local, ...). */
  scope: Schema.optionalKey(Schema.String),
  /** Number of tools the server exposes, when known. */
  toolCount: Schema.optionalKey(Schema.Number),
  /** Endpoint for http/sse servers, from the CLI's config echo. */
  url: Schema.optionalKey(Schema.String),
  /** Transport kind (stdio | http | sse | ...), when the config reports it. */
  transport: Schema.optionalKey(Schema.String),
  /** Tools the server exposes (available when connected). */
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        description: Schema.optionalKey(Schema.String),
        readOnly: Schema.optionalKey(Schema.Boolean),
        destructive: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
export type ProviderMcpServerStatus = typeof ProviderMcpServerStatus.Type;

export const ProviderMcpStatusResult = Schema.Struct({
  servers: Schema.Array(ProviderMcpServerStatus),
});
export type ProviderMcpStatusResult = typeof ProviderMcpStatusResult.Type;

/**
 * A concrete action on one MCP server, executed over the same local control
 * channel as the status read — no model request, no token cost.
 * - reconnect: drop and re-establish the server connection.
 * - authenticate: start the server's OAuth flow; the result may carry a URL
 *   the client must open in the browser.
 * - clear-auth: forget the server's stored credentials.
 * - enable / disable: toggle the server for this session.
 */
export const ProviderMcpServerAction = Schema.Literals([
  "reconnect",
  "authenticate",
  "clear-auth",
  "enable",
  "disable",
]);
export type ProviderMcpServerAction = typeof ProviderMcpServerAction.Type;

export const ProviderMcpActionInput = Schema.Struct({
  threadId: ThreadId,
  serverName: TrimmedNonEmptyString,
  action: ProviderMcpServerAction,
});
export type ProviderMcpActionInput = typeof ProviderMcpActionInput.Type;

export const ProviderMcpActionResult = Schema.Struct({
  /** Fresh statuses read after the action, so the dialog can re-render. */
  servers: Schema.Array(ProviderMcpServerStatus),
  /** OAuth URL to open in the browser when authentication needs the user. */
  authUrl: Schema.optionalKey(Schema.String),
});
export type ProviderMcpActionResult = typeof ProviderMcpActionResult.Type;

// Errors

export class ProviderMcpStatusError extends Schema.TaggedErrorClass<ProviderMcpStatusError>()(
  "ProviderMcpStatusError",
  {
    /** "no-session" | "unsupported" | "failed" — drives the client's copy. */
    reason: Schema.Literals(["no-session", "unsupported", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
