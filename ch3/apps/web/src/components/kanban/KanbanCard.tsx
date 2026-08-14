import { scopeThreadRef, scopedThreadKey } from "@ch3tools/client-runtime/environment";
import type { KanbanCardType } from "@ch3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../../lib/utils";
import type { SidebarThreadSummary } from "../../types";
import { kanbanCardType } from "./Kanban.logic";
import { KANBAN_CARD_TYPES, kanbanCardTypeConfig, type KanbanCardTypeConfig } from "./kanbanConfig";

export interface KanbanCardProps {
  readonly thread: SidebarThreadSummary;
  readonly lane: "user" | "agent" | "waiting";
  /** Snoozed/Settled render a slimmed card: no summary, no type controls —
      those columns are holding areas, not flow (F11). */
  readonly compact?: boolean;
  readonly projectTitle: string;
  readonly canMoveLeft: boolean;
  readonly canMoveRight: boolean;
  readonly onOpen: (thread: SidebarThreadSummary) => void;
  readonly onMove: (thread: SidebarThreadSummary, direction: -1 | 1) => void;
  readonly onSetType: (thread: SidebarThreadSummary, cardType: KanbanCardType) => void;
  readonly onSetDeadline: (thread: SidebarThreadSummary, deadline: string | null) => void;
  readonly onTogglePin: (thread: SidebarThreadSummary) => void;
  readonly onContextMenu?: (thread: SidebarThreadSummary, x: number, y: number) => void;
  /** Runtime type list (built-ins + user-created). */
  readonly cardTypes?: ReadonlyArray<KanbanCardTypeConfig>;
}

/**
 * One conversation as a kanban ticket: title, the Sonnet-generated two-line
 * description, three keywords, project tag, and the type's ghost glow around
 * the contour. Arrows at the bottom-right move one column at a time; drag
 * moves anywhere. Clicking the body opens the conversation.
 */
export function KanbanCard({
  thread,
  lane,
  compact = false,
  projectTitle,
  canMoveLeft,
  canMoveRight,
  onOpen,
  onMove,
  onSetType,
  onSetDeadline,
  onTogglePin,
  onContextMenu,
  cardTypes = KANBAN_CARD_TYPES,
}: KanbanCardProps) {
  const cardType = kanbanCardType(thread);
  const typeConfig = kanbanCardTypeConfig(cardType, cardTypes);
  const kanban = thread.kanban ?? null;
  const pinned = kanban?.pinned === true;
  const deadline = kanban?.deadline ?? null;

  return (
    <div
      draggable
      data-testid="kanban-card"
      onClick={(event) => {
        // The whole card opens the conversation, except its own controls.
        if ((event.target as HTMLElement).closest("button, select, input")) {
          return;
        }
        onOpen(thread);
      }}
      onContextMenu={(event) => {
        if (onContextMenu) {
          event.preventDefault();
          onContextMenu(thread, event.clientX, event.clientY);
        }
      }}
      onDragStart={(event) => {
        // A drag that starts inside a select/date input is the user operating
        // the control, not moving the card.
        if (
          event.target !== event.currentTarget &&
          (event.target as HTMLElement).closest("select, input")
        ) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(
          "text/plain",
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
        event.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "kanban-card group relative flex cursor-grab flex-col gap-1.5 rounded-lg border border-border bg-card p-2 text-left",
        lane === "waiting" && "opacity-70",
        !compact && (cardType === "urgent" || cardType === "deadline") && "kanban-card-loud",
        compact && "kanban-card-compact",
      )}
      // The type's glow travels as a variable so the hover state can amplify
      // it in CSS — an inline box-shadow has no hover to hand.
      style={{ "--kanban-glow": typeConfig.glow } as CSSProperties}
    >
      <button
        type="button"
        className="cursor-pointer text-left text-[13px] leading-snug font-medium text-foreground"
        onClick={() => onOpen(thread)}
      >
        {lane === "agent" ? (
          <span
            className="kanban-agent-dot mr-2 inline-block size-2 rounded-full bg-primary align-middle"
            aria-label="Agent working"
          />
        ) : null}
        {thread.title}
      </button>

      {!compact && kanban?.description ? (
        <p className="line-clamp-1 text-xs leading-snug text-muted-foreground transition-all group-hover:line-clamp-3">
          {kanban.description}
        </p>
      ) : null}

      <div className={cn("flex flex-wrap items-center gap-1", compact && "hidden")}>
        {(kanban?.keywords ?? []).slice(0, 2).map((keyword) => (
          <span
            key={keyword}
            className="rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground"
          >
            {keyword}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span
          aria-label={projectTitle}
          title={projectTitle}
          className="size-1.5 flex-none rounded-full bg-muted-foreground/50"
        />
        {compact ? (
          <span className="truncate text-[10px] text-muted-foreground">{projectTitle}</span>
        ) : (
          // The type is a colored dot, not a label: hue carries the class of
          // service, the tooltip carries the words — and clicking opens the
          // FULL type dropdown (an invisible native select over the dot).
          <span
            className="relative inline-flex flex-none items-center rounded-full p-1 hover:bg-accent"
            title={`${typeConfig.label} — click to change type`}
          >
            <span
              className="block size-2.5 rounded-full"
              style={{ backgroundColor: typeConfig.glow }}
            />
            <select
              aria-label={`Card type: ${typeConfig.label}`}
              className="absolute inset-0 cursor-pointer opacity-0"
              value={cardType}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onSetType(thread, event.target.value)}
            >
              {cardTypes.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
              {cardTypes.some((entry) => entry.id === cardType) ? null : (
                <option value={cardType}>{typeConfig.label}</option>
              )}
            </select>
          </span>
        )}
        {!compact && cardType === "deadline" ? (
          <input
            type="date"
            aria-label="Deadline"
            className="w-[6.5rem] flex-none rounded border border-border bg-transparent px-1 text-[10px] text-muted-foreground"
            value={deadline ? deadline.slice(0, 10) : ""}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) =>
              onSetDeadline(
                thread,
                // Noon UTC round-trips to the same calendar date in every
                // timezone (UTC-12 … UTC+14).
                event.target.value ? `${event.target.value}T12:00:00.000Z` : null,
              )
            }
          />
        ) : null}

        <span className="flex-1" />

        {/* The pin state and both move arrows are one atomic cluster: grouped
            and flex-none so flex-wrap can never orphan the right arrow on its
            own line (it did). If the row truly can't fit, the whole cluster
            drops together, still aligned right. */}
        <div className="flex flex-none items-center gap-0.5">
          {!compact ? (
            // F7: a two-state fact gets a word, not a mystery sparkle.
            <button
              type="button"
              title={
                pinned
                  ? "Pinned by you — the classifier won't move it. Click to release."
                  : "Placed by the classifier. Click to pin it in place."
              }
              className={cn(
                "rounded border px-1 text-[9px] leading-4 transition-colors",
                pinned
                  ? "border-border font-semibold text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(thread);
              }}
            >
              {pinned ? "pinned" : "auto"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Move left"
            disabled={!canMoveLeft}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
            onClick={(event) => {
              event.stopPropagation();
              onMove(thread, -1);
            }}
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Move right"
            disabled={!canMoveRight}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
            onClick={(event) => {
              event.stopPropagation();
              onMove(thread, 1);
            }}
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
