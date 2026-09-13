import type { ScopedProjectRef } from "@ch3tools/contracts";

/**
 * Hands a picked project to the Kanban board's new-thread dialog.
 *
 * The project picker lives in the command palette and the dialog lives on the
 * board; neither owns the other's React state. The sidebar button, the
 * keyboard shortcut and the board's own button all end here once a project is
 * chosen, and the board — mounted whenever the route is `/kanban` — opens the
 * dialog. Same shape as `commandPaletteBus.ts`, for the same reason.
 */
const KANBAN_NEW_THREAD_EVENT = "ch3:kanban-new-thread";

export interface KanbanNewThreadDetail {
  readonly projectRef: ScopedProjectRef;
}

export function openKanbanNewThread(projectRef: ScopedProjectRef): void {
  window.dispatchEvent(
    new CustomEvent<KanbanNewThreadDetail>(KANBAN_NEW_THREAD_EVENT, { detail: { projectRef } }),
  );
}

export function onKanbanNewThread(listener: (detail: KanbanNewThreadDetail) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<KanbanNewThreadDetail>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(KANBAN_NEW_THREAD_EVENT, handler);
  return () => window.removeEventListener(KANBAN_NEW_THREAD_EVENT, handler);
}
