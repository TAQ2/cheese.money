import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FolderTreeIcon, InboxIcon, Rows3Icon } from "lucide-react";

import { useSidebarV2Enabled, useUpdateClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type SidebarMode = "inbox" | "projects" | "kanban";

/**
 * Switch between the inbox sidebar, the project-grouped one, and the Kanban
 * board.
 *
 * The three views answer different questions — "what is still open?",
 * "what is in this project?", and "where is everything in its flow?" — so the
 * choice does not belong buried in Settings → Beta.
 *
 * Inbox/projects flip the persisted sidebar setting exactly as before (and
 * pin it via `sidebarV2ConfiguredByUser`, so a build that defaults the inbox
 * on cannot undo it). Kanban is a route, not a setting: entering and leaving
 * it never touches the inbox/projects choice, which is what makes leaving it
 * a single click with everything else intact.
 */
export function SidebarModeToggle({ className }: { readonly className?: string }) {
  const sidebarV2Enabled = useSidebarV2Enabled();
  const updateSettings = useUpdateClientSettings();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onKanban = pathname === "/kanban" || pathname.startsWith("/kanban/");
  const activeMode: SidebarMode = onKanban ? "kanban" : sidebarV2Enabled ? "inbox" : "projects";

  const selectMode = (mode: SidebarMode) => {
    if (mode === activeMode) {
      return;
    }
    if (mode === "kanban") {
      void router.navigate({ to: "/kanban" });
      return;
    }
    if (onKanban) {
      void router.navigate({ to: "/" });
    }
    updateSettings({
      sidebarV2Enabled: mode === "inbox",
      sidebarV2ConfiguredByUser: true,
    });
  };

  const MODE_WORD: Record<SidebarMode, string> = {
    inbox: "Inbox",
    projects: "Projects",
    kanban: "Kanban",
  };
  const modeButton = (mode: SidebarMode, label: string, icon: ReactNode) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={activeMode === mode}
            data-testid={`sidebar-mode-toggle-${mode}`}
            className={cn(
              "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] transition-colors hover:bg-accent hover:text-foreground",
              activeMode === mode ? "bg-accent text-foreground" : "text-muted-foreground/60",
            )}
            onClick={() => selectMode(mode)}
          />
        }
      >
        {icon}
        {activeMode === mode ? (
          <span className="ml-1 text-[10px] font-medium">{MODE_WORD[mode]}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      data-testid="sidebar-mode-toggle"
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {modeButton("inbox", "Inbox view", <InboxIcon className="size-3.5" />)}
      {modeButton("projects", "Projects view", <FolderTreeIcon className="size-3.5" />)}
      {modeButton("kanban", "Kanban board", <Rows3Icon className="size-3.5" />)}
    </div>
  );
}
