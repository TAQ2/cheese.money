import { scopeProjectRef, scopeThreadRef } from "@ch3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@ch3tools/contracts";
import { ChevronDownIcon, CloudIcon, MonitorIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useProject, useThread } from "../state/entities";
import { useIsMobile } from "../hooks/useMediaQuery";
import {
  type EnvMode,
  type EnvironmentOption,
  formatOutputStyleLabel,
  isDefaultOutputStyle,
  type OutputStyleChipState,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarOutputStyleSelector } from "./BranchToolbarOutputStyleSelector";
import { TheatreMaskIcon } from "./TheatreMaskIcon";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  /**
   * Response-style chip state, or absent when the running driver reports no
   * styles. The chip stands where the workspace picker used to; the workspace
   * itself is now chosen by the default env mode in Settings.
   */
  outputStyleChip?: OutputStyleChipState | null;
  onOutputStyleChange?: (outputStyle: string) => void;
  /** Redo the newest reply under the selected style, as a new turn. */
  onRedoLastReply?: () => void;
  /**
   * False for a project that is not under version control, where the branch
   * picker has nothing to offer. The strip still renders for the sake of the
   * response-style chip.
   */
  showBranchSelector?: boolean;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

interface MobileRunContextSelectorProps {
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  outputStyleChip: OutputStyleChipState | null;
  onOutputStyleChange: ((outputStyle: string) => void) | undefined;
}

const MobileRunContextSelector = memo(function MobileRunContextSelector({
  envLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  outputStyleChip,
  onOutputStyleChange,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const canPickOutputStyle = outputStyleChip !== null && onOutputStyleChange !== undefined;
  const environmentGroupVisible = Boolean(
    showEnvironmentPicker && availableEnvironments && onEnvironmentChange,
  );
  // Render a plain label rather than a menu that would open empty: with the
  // workspace group gone, a locked (or single-) environment and a driver that
  // reports no styles leaves nothing to pick.
  const isLocked = !canPickOutputStyle && (envLocked || !environmentGroupVisible);
  // The mask marks a style being worn; "None" wears none, so it goes bare.
  const styledSelection = Boolean(
    outputStyleChip?.selectedStyle && !isDefaultOutputStyle(outputStyleChip.selectedStyle),
  );
  const EnvironmentIcon = activeEnvironment?.isPrimary ? MonitorIcon : CloudIcon;
  const icon = showEnvironmentIndicator ? (
    // Button's base styles apply `-mx-0.5` to descendant SVGs, which eats 4px
    // out of whatever gap we set. mx-0! cancels that so gap-0.5 reads as 2px.
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <EnvironmentIcon className="size-3 shrink-0 mx-0!" />
      {styledSelection ? <TheatreMaskIcon className="size-3 shrink-0 mx-0!" /> : null}
    </span>
  ) : styledSelection ? (
    <TheatreMaskIcon className="size-3 shrink-0" />
  ) : null;
  const triggerContent = (
    <>
      {icon}
      <span className="min-w-0 truncate">
        {showEnvironmentIndicator
          ? (activeEnvironment?.label ?? "Run on")
          : (outputStyleChip?.label ?? "Run on")}
      </span>
    </>
  );

  if (isLocked) {
    return (
      <span className="inline-flex min-w-0 max-w-[48%] flex-1 items-center justify-start gap-1 rounded-md border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-muted-foreground/70 md:hidden">
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 max-w-[48%] flex-1 justify-start text-muted-foreground/70 hover:text-foreground/80 md:hidden"
      >
        {triggerContent}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        {showEnvironmentPicker && availableEnvironments && onEnvironmentChange ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={environmentId}
                onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
              >
                {availableEnvironments.map((env) => {
                  const Icon = env.isPrimary ? MonitorIcon : CloudIcon;
                  return (
                    <MenuRadioItem
                      key={env.environmentId}
                      disabled={envLocked}
                      value={env.environmentId}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3" />
                        <span className="min-w-0 truncate">{env.label}</span>
                      </span>
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        {outputStyleChip ? (
          <MenuGroup>
            <MenuGroupLabel>Response style</MenuGroupLabel>
            <MenuRadioGroup
              value={outputStyleChip.selectedStyle}
              onValueChange={(value) => {
                if (typeof value !== "string" || !value) return;
                onOutputStyleChange?.(value);
              }}
            >
              {outputStyleChip.styles.map((style) => (
                <MenuRadioItem key={style} disabled={!onOutputStyleChange} value={style}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    {isDefaultOutputStyle(style) ? null : <TheatreMaskIcon className="size-3" />}
                    <span className="min-w-0 truncate">{formatOutputStyleLabel(style)}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  draftId,
  outputStyleChip,
  onOutputStyleChange,
  onRedoLastReply,
  showBranchSelector = true,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const hasActiveThread = serverThread !== null || draftThread !== null;

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: showEnvironmentPicker,
  });
  const isMobile = useIsMobile();

  if (!hasActiveThread || !activeProject) return null;

  return (
    <div className="chat-composer-context-strip -mt-4 mx-auto flex w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] items-center gap-2 px-1 pt-5 pb-1">
      {isMobile ? (
        <MobileRunContextSelector
          envLocked={envLocked}
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          showEnvironmentPicker={showEnvironmentPicker}
          showEnvironmentIndicator={showEnvironmentIndicator}
          onEnvironmentChange={onEnvironmentChange}
          outputStyleChip={outputStyleChip ?? null}
          onOutputStyleChange={onOutputStyleChange}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {showEnvironmentIndicator && availableEnvironments && (
            <>
              <BranchToolbarEnvironmentSelector
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                {...(showEnvironmentPicker && onEnvironmentChange ? { onEnvironmentChange } : {})}
              />
              {outputStyleChip ? (
                <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
              ) : null}
            </>
          )}
          {outputStyleChip ? (
            <BranchToolbarOutputStyleSelector
              chip={outputStyleChip}
              disabled={onOutputStyleChange === undefined}
              onOutputStyleChange={onOutputStyleChange ?? (() => {})}
              onRedoLastReply={onRedoLastReply}
            />
          ) : null}
        </div>
      )}

      {showBranchSelector ? (
        <BranchToolbarBranchSelector
          className="min-w-0 flex-1 justify-end md:ml-auto md:flex-none"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
    </div>
  );
});
