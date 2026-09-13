// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "ch3:open-command-palette";

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "discover-projects" | "new-thread-in";
  /**
   * Where a "new thread in..." pick goes. Absent, it opens a draft
   * conversation as always; `kanban` hands the project to the board's own
   * new-thread dialog instead, so a person on the board stays on the board.
   */
  readonly newThreadTarget?: "kanban";
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
