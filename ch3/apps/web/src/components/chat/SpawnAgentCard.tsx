import { memo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { ThreadId, type EnvironmentId } from "@ch3tools/contracts";
import { scopeThreadRef } from "@ch3tools/client-runtime/environment";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { WorkLogEntry } from "../../session-logic";
import { Button } from "../ui/button";

export type SpawnAgentCardStatus = "completed" | "running" | "error";

export interface SpawnAgentCardData {
  /** Null while the call is still in flight and no child thread id has come back yet. */
  readonly threadId: string | null;
  readonly model: string;
  readonly title: string;
  readonly status: SpawnAgentCardStatus;
  readonly output: string | null;
}

const SPAWN_TOOL_NAME = "spawn_model_agent";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isStatus(value: unknown): value is SpawnAgentCardStatus {
  return value === "completed" || value === "running" || value === "error";
}

/**
 * The tool's own result object, dug out of whatever wrapper the runtime put
 * it in. The Claude runtime hands an MCP result back as
 * `{ tool_use_id, type: "tool_result", content }` where `content` is the
 * result JSON as a STRING; other shapes put it under `structuredContent`, or
 * as an array of `{ type: "text", text }` blocks, or hand the bare object.
 * Every one of those is tried, and anything unparseable reads as no result.
 */
function readToolResult(result: unknown): Record<string, unknown> | null {
  const record = asRecord(result);
  if (!record) return null;
  if (typeof record.threadId === "string") return record;
  const structured = asRecord(record.structuredContent);
  if (structured && typeof structured.threadId === "string") return structured;
  const content = record.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => asTrimmedString(asRecord(block)?.text) ?? "")
            .join("")
            .trim()
        : null;
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Recognises a `spawn_model_agent` call on its work entry and reads the card.
 *
 * For an `mcp_tool_call`, `toolData` is what the runtime carried on the call:
 * flat `{ toolName, input, result }` from the Claude runtime, or a nested
 * `item` from another. Detection is by `toolName`, which is present from the
 * first lifecycle row on, so the card shows while the child still runs and
 * fills in the thread id and output once the result lands. A result shaped
 * like the tool's own output is accepted even without a name, for a runtime
 * that drops it.
 */
export function readSpawnAgentCard(entry: WorkLogEntry): SpawnAgentCardData | null {
  if (entry.itemType !== "mcp_tool_call") {
    return null;
  }
  const toolData = asRecord(entry.toolData);
  if (!toolData) {
    return null;
  }
  const item = asRecord(toolData.item) ?? toolData;
  const toolName = asTrimmedString(item.toolName) ?? asTrimmedString(item.tool) ?? null;
  const isSpawnCall = toolName !== null && toolName.endsWith(SPAWN_TOOL_NAME);
  const input = asRecord(item.input) ?? asRecord(item.arguments);

  // The name decides, first and for every branch. A result carrying a
  // threadId, a model and a known status used to be enough on its own, so any
  // MCP server whose tool answered in that shape drew a CH3 delegation card
  // — with an Open button pointing at a thread id it had invented.
  if (!isSpawnCall) {
    return null;
  }

  const result = readToolResult(item.result);
  if (result) {
    const threadId = asTrimmedString(result.threadId);
    const model = asTrimmedString(result.model);
    if (threadId && model && isStatus(result.status)) {
      return {
        threadId,
        model,
        title: asTrimmedString(result.title) ?? model,
        status: result.status,
        output: typeof result.output === "string" ? result.output : null,
      };
    }
  }

  // No usable result: what the card says depends on how the call ended. A call
  // the runtime marked failed (an unknown model, a caller thread gone, a
  // dispatch the engine refused) is an error card carrying the tool's own
  // message — never a "Running" that outlives the call. A call marked
  // completed whose result is unreadable is nothing this card can explain; the
  // generic row shows the raw result instead. Only a call still in flight is
  // "running".
  const model = asTrimmedString(input?.model);
  if (!model) {
    return null;
  }
  const lifecycle = entry.toolLifecycleStatus;
  const title = asTrimmedString(input?.title) ?? model;
  if (lifecycle === "failed" || lifecycle === "declined") {
    return {
      threadId: null,
      model,
      title,
      status: "error",
      output: readToolResultText(item.result),
    };
  }
  if (lifecycle === "completed") {
    return null;
  }
  return { threadId: null, model, title, status: "running", output: null };
}

/** The result's text as the runtime carried it, for an error the tool wrote in prose. */
function readToolResultText(result: unknown): string | null {
  const record = asRecord(result);
  const content = record?.content ?? result;
  if (typeof content === "string") return asTrimmedString(content);
  if (Array.isArray(content)) {
    const text = content
      .map((block) => asTrimmedString(asRecord(block)?.text) ?? "")
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

const STATUS_LABEL: Record<SpawnAgentCardStatus, string> = {
  completed: "Completed",
  running: "Running",
  error: "Error",
};

const STATUS_CLASS: Record<SpawnAgentCardStatus, string> = {
  completed: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  running: "bg-muted/60 text-muted-foreground/80",
  error: "bg-destructive/12 text-destructive",
};

/**
 * Copy the child thread's id, and say so. Mirrors `AgentIdCopyButton` in
 * MessagesTimeline.tsx: same two-second copied state from the same hook, same
 * icon swap so a click that changes nothing on screen still reads as a click
 * that did something.
 */
function CopyThreadIdButton({ threadId }: { threadId: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "thread id" });
  return (
    <button
      type="button"
      aria-label="Copy the child thread's id"
      title={isCopied ? "Copied" : "Copy this thread's id"}
      data-testid="spawn-agent-copy-thread-id"
      className={cn(
        "shrink-0 px-1 leading-none transition-colors",
        isCopied ? "text-emerald-500" : "text-muted-foreground/40 hover:text-foreground",
      )}
      onClick={() => copyToClipboard(threadId, undefined)}
    >
      {isCopied ? (
        <CheckIcon className="size-3" aria-hidden />
      ) : (
        <CopyIcon className="size-3" aria-hidden />
      )}
    </button>
  );
}

/**
 * The agent card for a `spawn_model_agent` tool call: the Maple model it ran
 * on, the child thread's title and status, a copy control for the thread id,
 * an Open button that navigates straight to the child thread, and (once
 * completed) the child's own output. Copy and Open appear only once a thread
 * id has come back; while the child is still starting there is nothing to
 * copy or open yet.
 *
 * `environmentId` comes from the timeline's shared row context
 * (`TimelineRowCtx.activeThreadEnvironmentId`), which every row already
 * carries — no additional prop-drilling needed to reach it here.
 */
export const SpawnAgentCard = memo(function SpawnAgentCard({
  card,
  environmentId,
}: {
  card: SpawnAgentCardData;
  environmentId: EnvironmentId | undefined;
}) {
  const navigate = useNavigate();
  const [outputExpanded, setOutputExpanded] = useState(false);
  // Shown for any status that left text: the answer when it completed, the
  // tool's own message when it failed.
  const hasOutput = !!card.output;
  const threadId = card.threadId;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border/45 bg-muted/10 px-2.5 py-2"
      data-testid="spawn-agent-card"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          data-testid="spawn-agent-model"
          title={card.model}
          className="max-w-[12rem] shrink-0 truncate rounded bg-muted/60 px-1 text-[11px] text-muted-foreground/80"
        >
          {card.model}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/82">
          {card.title}
        </span>
        <span
          data-testid="spawn-agent-status"
          className={cn("shrink-0 rounded px-1 text-[11px]", STATUS_CLASS[card.status])}
        >
          {STATUS_LABEL[card.status]}
        </span>
      </div>
      {threadId !== null || hasOutput ? (
        <div className="flex items-center gap-1.5 text-muted-foreground/55">
          {threadId !== null ? <CopyThreadIdButton threadId={threadId} /> : null}
          {threadId !== null && environmentId ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="spawn-agent-open"
              onClick={() => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(
                    scopeThreadRef(environmentId, ThreadId.make(threadId)),
                  ),
                });
              }}
            >
              Open
            </Button>
          ) : null}
          {hasOutput ? (
            <button
              type="button"
              data-testid="spawn-agent-toggle-output"
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:text-foreground"
              onClick={() => setOutputExpanded((value) => !value)}
            >
              {outputExpanded ? "Hide output" : "Show output"}
            </button>
          ) : null}
        </div>
      ) : null}
      {outputExpanded && hasOutput ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border/30 bg-background/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
          {card.output}
        </pre>
      ) : null}
    </div>
  );
});
