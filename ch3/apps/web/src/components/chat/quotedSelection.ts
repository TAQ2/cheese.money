/**
 * Quoting a fragment of the transcript back into the composer.
 *
 * Following up on one specific passage — "this claim here, where did it come
 * from?" — meant selecting it, copying it, clicking into the composer, typing
 * the framing by hand and pasting. Every one of those steps re-states something
 * the app already knows at the moment of the right-click: which passage the
 * reader means.
 *
 * @module quotedSelection
 */

import type { ContextMenuItem } from "@ch3tools/contracts";

export type QuotedSelectionAction = "quote" | "copy" | "copy-conversation";

export type QuotedSelectionFailureOperation =
  | "show-selection-context-menu"
  | "quote"
  | "copy"
  | "copy-conversation";

const FAILURE_OPERATION_BY_ACTION = {
  quote: "quote",
  copy: "copy",
  "copy-conversation": "copy-conversation",
} as const satisfies Record<QuotedSelectionAction, QuotedSelectionFailureOperation>;

/**
 * The transcript is read-only, so the platform menu offers it Cut and Paste
 * permanently disabled, and a Select All that reaches the sidebar and the
 * composer while missing every message scrolled out of the virtualised list.
 *
 * "Copy entire conversation" is what that Select All was being used FOR, done
 * properly and named for its result rather than for the selection it no longer
 * has to make. It is offered whether or not anything is selected; the two
 * entries that act on a selection are not.
 */
const COPY_CONVERSATION_MENU_ITEM = {
  id: "copy-conversation",
  label: "Copy entire conversation",
} as const satisfies ContextMenuItem<QuotedSelectionAction>;

const SELECTION_MENU_ITEMS = [
  { id: "quote", label: "Quote" },
  { id: "copy", label: "Copy" },
] as const satisfies readonly ContextMenuItem<QuotedSelectionAction>[];

/** The menu for a right-click in the transcript, with or without a selection. */
export function transcriptContextMenuItems(
  hasSelection: boolean,
): readonly ContextMenuItem<QuotedSelectionAction>[] {
  return hasSelection
    ? [...SELECTION_MENU_ITEMS, COPY_CONVERSATION_MENU_ITEM]
    : [COPY_CONVERSATION_MENU_ITEM];
}

/** The parts of a DOM `Selection` this reads. Structural, so it can be tested without a DOM. */
export interface QuotableSelection {
  readonly isCollapsed: boolean;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
  /** Selections can hold more than one range in Firefox (ctrl-drag). */
  readonly rangeCount?: number;
  toString(): string;
}

/** The part of a DOM element this reads. */
export interface QuotableSelectionContainer {
  contains(node: Node | null): boolean;
}

/**
 * The selected transcript text a right-click can act on, or null when there is
 * none — in which case the caller must leave the platform's own menu alone
 * rather than replacing it with a two-entry menu that can do nothing.
 *
 * Both ends of the selection must sit inside the transcript, not just one: a
 * drag that runs out of it carries text the reader never meant to quote (the
 * draft in their own composer, a thread title in the sidebar), and quoting that
 * back to them puts words in their mouth.
 *
 * `serializeMarkdown` is how the transcript's own copy pipeline renders a
 * selection back to markdown, and it is preferred over the browser's flat
 * `toString()` for the same reason ⌘C uses it: `toString()` drops every link's
 * URL, every code fence, every list marker and every table pipe. Quoting a
 * fenced block that arrives as bare prose, or a link with its href gone, is a
 * quote that has lost exactly what made it worth quoting. It falls back to the
 * flat text for selections the serializer cannot render.
 */
export function quotableSelectionText(
  selection: QuotableSelection | null,
  container: QuotableSelectionContainer | null,
  serializeMarkdown?: (selection: QuotableSelection) => string | null,
): string | null {
  if (!selection || !container || selection.isCollapsed) return null;
  // The containment check below can only speak for the range that `anchorNode`
  // and `focusNode` describe — the last one. A multi-range selection is left to
  // the platform rather than quoted on the strength of one of its ranges.
  if (selection.rangeCount !== undefined && selection.rangeCount > 1) return null;
  if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) {
    return null;
  }
  const text = selection.toString();
  if (text.trim().length === 0) return null;
  const markdown = serializeMarkdown?.(selection);
  return markdown !== null && markdown !== undefined && markdown.trim().length > 0
    ? markdown
    : text;
}

/**
 * A selection as it should read inside quotes: line endings normalised, the
 * trailing whitespace a rendered layout contributes stripped per line, and the
 * whole trimmed at both ends.
 *
 * Leading indentation is deliberately left alone — it is load-bearing inside a
 * quoted code block — so the only indentation this touches is the first line's,
 * which `trim` takes along with the surrounding blank lines.
 */
export function normalizeQuotedFragment(raw: string): string {
  return raw
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

/**
 * The text a quote contributes to the composer. Empty when the fragment carries
 * nothing to quote.
 *
 * It ends on a newline because a quote is a block, and the reader's next move
 * is to write under it rather than beside the closing quote mark. Where it
 * *starts* is not decided here: the composer inserts it with a `"line"`
 * boundary, which is the only place that can read the live prompt.
 */
export function composerTextForQuotedSelection(fragment: string): string {
  const normalized = normalizeQuotedFragment(fragment);
  if (normalized.length === 0) return "";
  return `Quoted Text: "${normalized}"\n`;
}

interface RunQuotedSelectionContextMenuOptions {
  /** The selected passage, or null when the right-click had no selection. */
  readonly fragment: string | null;
  readonly position: { readonly x: number; readonly y: number };
  readonly showContextMenu: (
    items: readonly ContextMenuItem<QuotedSelectionAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<QuotedSelectionAction | null>;
  readonly quote: (fragment: string) => void;
  readonly copy: (fragment: string) => Promise<unknown>;
  readonly copyConversation: () => Promise<unknown>;
  readonly reportFailure: (operation: QuotedSelectionFailureOperation, cause: unknown) => void;
}

/** Shows the transcript menu and runs whatever was picked. */
export async function runQuotedSelectionContextMenu({
  fragment,
  position,
  showContextMenu,
  quote,
  copy,
  copyConversation,
  reportFailure,
}: RunQuotedSelectionContextMenuOptions): Promise<void> {
  let action: QuotedSelectionAction | null;
  try {
    action = await showContextMenu(transcriptContextMenuItems(fragment !== null), position);
  } catch (cause) {
    reportFailure("show-selection-context-menu", cause);
    return;
  }

  try {
    if (action === "copy-conversation") {
      await copyConversation();
    } else if (fragment !== null && action === "quote") {
      quote(fragment);
    } else if (fragment !== null && action === "copy") {
      await copy(fragment);
    }
  } catch (cause) {
    if (action) reportFailure(FAILURE_OPERATION_BY_ACTION[action], cause);
  }
}
