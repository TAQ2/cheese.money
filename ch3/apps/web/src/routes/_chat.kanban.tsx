import { createFileRoute } from "@tanstack/react-router";

import { KanbanBoardView } from "../components/kanban/KanbanBoardView";
import { SidebarInset } from "../components/ui/sidebar";

/**
 * Kanban mode: conversations as cards flowing Snoozed → … → Settled, with the
 * agent lane below the user lane. A view over the same threads the inbox and
 * project modes show — entering and leaving it changes nothing about them.
 */
function KanbanRouteView() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <KanbanBoardView />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/kanban")({
  component: KanbanRouteView,
});
