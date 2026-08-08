import { SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <CH3Wordmark />
    </Link>
  );
}

function CH3Wordmark() {
  return (
    <svg
      aria-label="CH3"
      className="h-2.5 w-auto shrink-0"
      viewBox="11.776 42.6 104.448 45.568"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M38.976 45.328C33.275 41.548 26.359 41.706 20.779 45.742C15.197 49.778 11.776 57.097 11.776 65C11.776 72.903 15.197 80.222 20.779 84.258C26.359 88.294 33.275 88.452 38.976 84.672L38.976 75.08C38.016 77 36.976 78.6 35.376 78.6L28.976 78.6C25.22 78.6 22.176 75.556 22.176 71.8L22.176 58.2C22.176 54.444 25.22 51.4 28.976 51.4L35.376 51.4C36.976 51.4 38.016 53 38.976 54.92ZM43.776 42.6H54.176V59.8H65.376V42.6H75.776V87.4H65.376V68.6H54.176V87.4H43.776V42.6ZM97.664 88.168C94.549 88.168 91.456 87.763 88.384 86.952C85.312 86.099 82.709 84.904 80.576 83.368L84.608 75.432C86.315 76.669 88.299 77.651 90.56 78.376C92.821 79.101 95.104 79.464 97.408 79.464C100.011 79.464 102.059 78.952 103.552 77.928C105.045 76.904 105.792 75.496 105.792 73.704C105.792 71.997 105.131 70.653 103.808 69.672C102.485 68.691 100.352 68.2 97.408 68.2H92.672V61.352L105.152 47.208L106.304 50.92H82.816V42.6H114.176V49.32L101.76 63.464L96.512 60.456H99.52C105.024 60.456 109.184 61.693 112 64.168C114.816 66.643 116.224 69.821 116.224 73.704C116.224 76.221 115.563 78.589 114.24 80.808C112.917 82.984 110.891 84.755 108.16 86.12C105.429 87.485 101.931 88.168 97.664 88.168Z"
        fill="currentColor"
      />
    </svg>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={handleSettingsClick}>
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});
