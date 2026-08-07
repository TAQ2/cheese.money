import { InboxIcon, FolderTreeIcon } from "lucide-react";

import { useSidebarV2Enabled, useUpdateClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Switch between the inbox sidebar and the project-grouped one.
 *
 * The two views answer different questions — "what is still open?" versus
 * "what is in this project?" — and both are worth having, so the choice does
 * not belong buried in Settings → Beta where a round trip through the settings
 * page discourages using either.
 *
 * Flipping here pins the choice (`sidebarV2ConfiguredByUser`) exactly as the
 * settings switch does, so a build that defaults the inbox on cannot undo it.
 */
export function SidebarModeToggle({ className }: { readonly className?: string }) {
  const sidebarV2Enabled = useSidebarV2Enabled();
  const updateSettings = useUpdateClientSettings();
  const label = sidebarV2Enabled ? "Switch to projects view" : "Switch to inbox view";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid="sidebar-mode-toggle"
            className={cn(
              "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground",
              className,
            )}
            onClick={() =>
              updateSettings({
                sidebarV2Enabled: !sidebarV2Enabled,
                sidebarV2ConfiguredByUser: true,
              })
            }
          />
        }
      >
        {sidebarV2Enabled ? (
          <FolderTreeIcon className="size-3.5" />
        ) : (
          <InboxIcon className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
