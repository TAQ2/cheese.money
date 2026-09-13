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
import { useStageBackdropMotion } from "../stageBackdropMotion";
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
  const { hostRef, onPointerMove, onPointerLeave } = useStageBackdropMotion<HTMLDivElement>();

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header stage-motion-host relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      ref={hostRef}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-violet-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
        )}
      />
      {/*
        Three columns: a leading gutter that reserves the traffic lights and the
        toggle, the lockup, and whatever is left. The gutter and the trailing
        column are both `1fr`, so the lockup centres on the sidebar itself
        rather than on the run beside the controls — and the gutter's `min`
        stops it there, so on a narrow sidebar the mark parks beside the toggle
        instead of climbing onto it. The template lives in
        `.sidebar-brand-run`. The pill rides in the middle column so it stays
        beside the mark rather than being flung to the far edge.
      */}
      <div className="sidebar-brand-run relative z-10 min-w-0 flex-1">
        <span aria-hidden />
        <span className="flex min-w-0 items-center gap-1">
          <SidebarBrand onBackdrop={backdropVariant !== null} />
          {pillLabel ? (
            <Badge
              className="rounded-full px-1.5 text-muted-foreground"
              data-environment-identification="pill"
              size="sm"
              variant="secondary"
            >
              {pillLabel}
            </Badge>
          ) : null}
        </span>
      </div>
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 h-11 w-fit min-w-0 shrink items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <CH3Wordmark onBackdrop={onBackdrop} />
    </Link>
  );
}

/**
 * The CH3 titlebar lockup.
 *
 * Keeps the two-tone rhythm of the mark it replaces: a solid leading syllable
 * against a lighter tail, split Bau|Dex to match the app icon's two rows. The
 * gradient is what gives it the glassy read — a bright top edge falling to a
 * dimmer base, exactly as an embossed metal wordmark catches light.
 *
 * Set at 2.5x the 0.875rem it used to be. `leading-none` is load-bearing at
 * that size: an arbitrary font size inherits the body's 1.5 line height, which
 * would make one line of text taller than the 52px titlebar it sits in.
 */
function CH3Wordmark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <span
      aria-label="CH3"
      className="flex shrink-0 items-baseline text-[2.1875rem] leading-none font-semibold tracking-tight"
    >
      <span
        className={cn(
          "bg-clip-text text-transparent",
          onBackdrop
            ? "bg-linear-to-b from-white to-white/70"
            : "bg-linear-to-b from-foreground to-foreground/65",
        )}
      >
        Bau
      </span>
      <span
        className={cn(
          "font-medium bg-clip-text text-transparent",
          onBackdrop
            ? "bg-linear-to-b from-white/80 to-white/45"
            : "bg-linear-to-b from-muted-foreground to-muted-foreground/55",
        )}
      >
        Dex
      </span>
    </span>
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
