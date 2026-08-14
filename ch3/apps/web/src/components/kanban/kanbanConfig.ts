/**
 * Kanban board configuration — columns and card types are plain data so
 * adding, removing, or reordering either is a one-line change here.
 *
 * "snoozed" and "settled" are derived columns: they reuse the inbox snooze
 * machinery and the settle/archive lifecycle instead of storing a stage.
 * Only the middle stages persist on the thread (contracts KanbanStageId).
 */
import type { KanbanCardType, KanbanStageId } from "@ch3tools/contracts";

/** "snoozed"/"settled" are derived; everything else is a stage id — built-in
    or user-created (stage ids are free-form strings server-side). */
export type KanbanColumnId = "snoozed" | KanbanStageId | "settled";

export interface KanbanCustomColumnSetting {
  readonly id: string;
  readonly label: string;
  readonly accent: string;
}

export interface KanbanColumnConfig {
  readonly id: KanbanColumnId;
  readonly label: string;
  readonly hint: string;
  /** Built-in WIP limit; null = unlimited. Overridable live per column. */
  readonly defaultWipLimit: number | null;
  /**
   * Column accent hue, fed to CSS as `--kanban-accent` and mixed there for the
   * header tint, the rail above it, the count pill and the column wash. Every
   * hue is kept clear of the four card-type glows (red / violet / yellow /
   * green) so a column's identity never reads as a card's class of service:
   * the two quiet holding columns are near-neutral (cool grey at the start,
   * warm grey at the end) and the five flow columns walk cyan → blue → pink →
   * orange → teal, warming toward the column that wants you and cooling again
   * as work is verified.
   */
  readonly accent: string;
}

export const KANBAN_COLUMNS: ReadonlyArray<KanbanColumnConfig> = [
  {
    id: "snoozed",
    label: "Snoozed",
    hint: "Waiting on time — the inbox snooze, as a column.",
    defaultWipLimit: null,
    accent: "#64748b",
  },
  {
    id: "exploration",
    label: "Exploration",
    hint: "Fleshing out or investigating an idea.",
    defaultWipLimit: null,
    accent: "#22d3ee",
  },
  {
    id: "move-along",
    label: "Move along",
    hint: "Needs only a quick nudge to advance.",
    defaultWipLimit: null,
    accent: "#60a5fa",
  },
  {
    id: "full-attention",
    label: "Full attention",
    hint: "A complex proposal needs your focused reading.",
    defaultWipLimit: 2,
    accent: "#f472b6",
  },
  {
    id: "decision-needed",
    label: "Decision needed",
    hint: "Blocked on a choice only you can make.",
    defaultWipLimit: 1,
    accent: "#fb923c",
  },
  {
    id: "final-review",
    label: "Final review",
    hint: "Done or not? Proof over report.",
    defaultWipLimit: 3,
    accent: "#2dd4bf",
  },
  {
    id: "settled",
    label: "Settled",
    hint: "Settled — the existing archive sweep takes it from here.",
    defaultWipLimit: null,
    accent: "#a8a29e",
  },
];

export const KANBAN_WIP_OPTIONS: ReadonlyArray<number | null> = [null, 1, 2, 3, 4, 5];

/** Accent rotation for user-created columns — hues kept clear of the four
    card-type glows and of the built-in column accents. */
export const KANBAN_CUSTOM_ACCENTS: ReadonlyArray<string> = [
  "#818cf8",
  "#e879f9",
  "#f97316",
  "#0ea5e9",
  "#f43f5e",
  "#14b8a6",
];

/**
 * The board's live column list: built-ins with user-created columns spliced
 * in front of Final review, in creation order, then rearranged by the saved
 * order. Custom columns are pure client config — the server only ever stores
 * their id as a thread's stage.
 *
 * The saved order is advisory, never authoritative: ids it no longer knows
 * are dropped, columns it does not mention keep their default position (next
 * to their default predecessor), and the two derived columns are pinned to
 * the ends regardless of what it says — Snoozed first, Settled last, because
 * push-left WIP displacement and the lifecycle both assume those endpoints.
 */
export function resolveKanbanColumns(
  custom: ReadonlyArray<KanbanCustomColumnSetting>,
  order: ReadonlyArray<string> = [],
): ReadonlyArray<KanbanColumnConfig> {
  const customConfigs: ReadonlyArray<KanbanColumnConfig> = custom.map((entry) => ({
    id: entry.id,
    label: entry.label,
    hint: "Custom column.",
    defaultWipLimit: null,
    accent: entry.accent,
  }));
  const finalReviewIndex = KANBAN_COLUMNS.findIndex((entry) => entry.id === "final-review");
  const base = [
    ...KANBAN_COLUMNS.slice(0, finalReviewIndex),
    ...customConfigs,
    ...KANBAN_COLUMNS.slice(finalReviewIndex),
  ];
  if (order.length === 0) {
    return base;
  }
  const byId = new Map(base.map((entry) => [entry.id, entry]));
  const result: KanbanColumnConfig[] = [];
  for (const id of order) {
    const config = byId.get(id);
    if (config !== undefined && !result.includes(config)) {
      result.push(config);
    }
  }
  for (const [index, config] of base.entries()) {
    if (result.includes(config)) {
      continue;
    }
    let insertAt = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      const placed = result.indexOf(base[i]!);
      if (placed >= 0) {
        insertAt = placed + 1;
        break;
      }
    }
    result.splice(insertAt, 0, config);
  }
  const middle = result.filter((entry) => entry.id !== "snoozed" && entry.id !== "settled");
  return [byId.get("snoozed")!, ...middle, byId.get("settled")!];
}

export function isBuiltinKanbanColumn(columnId: KanbanColumnId): boolean {
  return KANBAN_COLUMNS.some((entry) => entry.id === columnId);
}

export interface KanbanCardTypeConfig {
  readonly id: KanbanCardType;
  readonly label: string;
  /** Ghost glow around the card contour. */
  readonly glow: string;
  /** May enter a WIP-full column by pushing the newest non-urgent card left. */
  readonly pushesThroughWip?: boolean;
  /** Who rises first into a freed WIP slot (lower = first). */
  readonly risePriority?: number;
}

export interface KanbanCustomCardTypeSetting {
  readonly id: string;
  readonly label: string;
  readonly glow: string;
}

export const KANBAN_CARD_TYPES: ReadonlyArray<KanbanCardTypeConfig> = [
  {
    id: "urgent",
    label: "Expedite urgently",
    glow: "#ef4444",
    pushesThroughWip: true,
    risePriority: 0,
  },
  { id: "deadline", label: "Deadline", glow: "#a78bfa", risePriority: 1 },
  { id: "standard", label: "Standard", glow: "#eab308", risePriority: 2 },
  { id: "platform", label: "Platform improvement", glow: "#22c55e", risePriority: 3 },
];

/** Candidate glows offered when creating a card type; the picker filters out
    hues already taken by built-ins or existing customs. */
export const KANBAN_TYPE_COLOR_CHOICES: ReadonlyArray<string> = [
  "#f97316",
  "#0ea5e9",
  "#ec4899",
  "#14b8a6",
  "#818cf8",
  "#facc15",
  "#84cc16",
  "#f43f5e",
  "#06b6d4",
  "#d946ef",
];

/** Built-ins + user-created card types, in that order. Custom types rise
    between deadline and standard work. */
export function resolveKanbanCardTypes(
  custom: ReadonlyArray<KanbanCustomCardTypeSetting>,
): ReadonlyArray<KanbanCardTypeConfig> {
  if (custom.length === 0) {
    return KANBAN_CARD_TYPES;
  }
  return [
    ...KANBAN_CARD_TYPES,
    ...custom.map((entry) => ({
      id: entry.id,
      label: entry.label,
      glow: entry.glow,
      risePriority: 2.5,
    })),
  ];
}

export const DEFAULT_KANBAN_CARD_TYPE: KanbanCardType = "standard";

export function kanbanCardTypeConfig(
  cardType: KanbanCardType,
  cardTypes: ReadonlyArray<KanbanCardTypeConfig> = KANBAN_CARD_TYPES,
): KanbanCardTypeConfig {
  return (
    cardTypes.find((entry) => entry.id === cardType) ?? {
      // A type whose definition was deleted: neutral grey, standard behavior.
      id: cardType,
      label: cardType,
      glow: "#94a3b8",
      risePriority: 2.5,
    }
  );
}

export function kanbanColumnConfig(
  columnId: KanbanColumnId,
  columns: ReadonlyArray<KanbanColumnConfig> = KANBAN_COLUMNS,
): KanbanColumnConfig {
  return (
    columns.find((entry) => entry.id === columnId) ?? {
      // A stage whose column was deleted mid-flight: render something sane
      // rather than crash — the board logic files these back to Exploration.
      id: columnId,
      label: columnId,
      hint: "",
      defaultWipLimit: null,
      accent: "#94a3b8",
    }
  );
}
