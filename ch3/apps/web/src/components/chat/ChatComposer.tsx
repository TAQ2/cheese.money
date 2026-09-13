import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@ch3tools/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@ch3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@ch3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@ch3tools/client-runtime/environment";
import { serializeComposerFileLink } from "@ch3tools/shared/composerTrigger";
import { createModelSelection, normalizeModelSlug } from "@ch3tools/shared/model";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  parseComposerInteractiveBuiltin,
  replaceTextRange,
  resolveInterceptedComposerBuiltin,
  shouldSubmitComposerOnEnter,
} from "../../composer-logic";
import {
  buildOutgoingTurnText,
  deriveComposerSendState,
  readFileAsDataUrl,
} from "../ChatView.logic";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import { takeFilesFromInput } from "./composerFilePicker";
import { composerInsertSeparator, type ComposerInsertBoundary } from "./composerInsert";
import { composerTextForDroppedPaths, resolveDroppedFilePaths } from "./droppedFilePaths";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  claimQueuedSend,
  selectDraftQueueCancelled,
  selectHandledReleaseCount,
  selectQueuedDispatchInFlight,
  composerDraftSignature,
  selectDraftQueuedSend,
  selectQueuedSends,
  useQueuedSendStore,
  type QueuedSendSnapshot,
  type QueuedSendEntry,
} from "../../queuedSendStore";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { compressImageForStash } from "../../lib/imageCompression";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { type ElementContextDraft } from "../../lib/elementContext";
import { ComposerPendingElementContexts } from "./ComposerPendingElementContexts";
import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";
import { ComposerPreviewAnnotationCards } from "./ComposerPreviewAnnotationCards";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../pierre-icons";
import { acceptComposerImageFiles, compressComposerImageFiles } from "~/composerImageAttachments";
import { cn, randomUUID } from "~/lib/utils";
import { Separator } from "../ui/separator";

function ComposerCommandMenuLayer(props: { anchor: HTMLElement | null; children: ReactNode }) {
  const [position, setPosition] = useState<{
    bottom: number;
    left: number;
    maxHeight: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        maxHeight: Math.max(96, rect.top - 24),
        width: rect.width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    observer?.observe(anchor);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.anchor]);

  if (!position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadShell } from "~/state/entities";
import { ComposerQueuedSends } from "./ComposerQueuedSends";
import {
  canComposerReleaseQueuedDraft,
  shouldRearmDraftAfterQueueDrain,
  shouldStackDraftOnEnter,
} from "./composerQueuedSends.logic";
import {
  BookmarkIcon,
  BotIcon,
  CircleAlertIcon,
  ListTodoIcon,
  PanelBottomIcon,
  PaperclipIcon,
  PencilRulerIcon,
  XIcon,
} from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import { getProviderDisplayName, getProviderInteractionModeToggle } from "../../providerModels";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  resolveProviderDriverKindForInstanceSelection,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@ch3tools/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import {
  deriveLatestContextWindowSnapshot,
  formatProviderDisplayName,
} from "../../lib/contextWindow";
import { ClaudeUsageBand } from "./ClaudeUsageBand";
import { OpenCodeUsageMetricsRow } from "./OpenCodeUsageMetricsRow";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { interactionModeConfig, runtimeModeConfig, runtimeModeOptions } from "./threadModes";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showPlanToggle: boolean;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTogglePlanSidebar: () => void;
  showTerminalToggle: boolean;
  terminalOpen: boolean;
  /**
   * Work is running underneath this thread — a terminal subprocess, or a
   * background task the agent launched. Pulses the control so a run is
   * visible without opening the drawer.
   */
  terminalBusy: boolean;
  terminalShortcutLabel: string | null;
  onToggleTerminal: () => void;
  onAttachFiles: () => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const terminalTooltip = `${props.terminalOpen ? "Hide" : "Open"} terminal pane${
    props.terminalBusy ? " — something is running" : ""
  }${props.terminalShortcutLabel ? ` (${props.terminalShortcutLabel})` : ""}`;
  const attachTooltip = "Attach files — images attach, other files add their path";
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";
  const planSidebarTooltip = props.planSidebarOpen
    ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
    : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`;

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              className={cn(
                "shrink-0 whitespace-nowrap",
                props.interactionMode === "plan"
                  ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                  : "text-muted-foreground/70 hover:text-foreground/80",
              )}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon icon={PencilRulerIcon} className="text-current opacity-100" />
          ) : (
            <ComposerControlIcon icon={BotIcon} opticalSize="large" />
          )}
          <span className="sr-only sm:not-sr-only">
            {interactionModeConfig[props.interactionMode].label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={<ComposerSelectControl className="font-medium" aria-label="Runtime mode" />}
          >
            <ComposerControlIcon icon={RuntimeModeIcon} />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}

      {props.showPlanToggle ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <Tooltip>
            <TooltipTrigger
              render={
                <ComposerControl
                  className={cn(
                    "shrink-0 whitespace-nowrap",
                    props.planSidebarOpen
                      ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  type="button"
                  onClick={props.onTogglePlanSidebar}
                  aria-label={planSidebarTooltip}
                />
              }
            >
              <ComposerControlIcon
                icon={ListTodoIcon}
                className={props.planSidebarOpen ? "text-current opacity-100" : undefined}
              />
              <span className="sr-only sm:not-sr-only">{props.planSidebarLabel}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{planSidebarTooltip}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}

      {props.showTerminalToggle ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <Tooltip>
            <TooltipTrigger
              render={
                <ComposerControl
                  className={cn(
                    "shrink-0 whitespace-nowrap",
                    props.terminalOpen
                      ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                      : props.terminalBusy
                        ? // Same teal the sidebar uses for a running terminal,
                          // so one colour means "running" everywhere.
                          "text-teal-600 hover:text-teal-500 dark:text-teal-300/90"
                        : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  type="button"
                  onClick={props.onToggleTerminal}
                  aria-label={terminalTooltip}
                />
              }
            >
              <ComposerControlIcon
                icon={PanelBottomIcon}
                className={cn(
                  props.terminalOpen ? "text-current opacity-100" : undefined,
                  props.terminalBusy ? "animate-status-pulse" : undefined,
                )}
              />
              <span className="sr-only sm:not-sr-only">Terminal</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{terminalTooltip}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}

      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              className="shrink-0 whitespace-nowrap text-muted-foreground/70 hover:text-foreground/80"
              type="button"
              onClick={props.onAttachFiles}
              aria-label={attachTooltip}
            />
          }
        >
          <ComposerControlIcon icon={PaperclipIcon} />
          <span className="sr-only sm:not-sr-only">Attach</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{attachTooltip}</TooltipPopup>
      </Tooltip>
    </>
  );
});

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  activeThreadProviderDisplayName: string | null;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  isQueued: boolean;
  canStackQueuedSend: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onQueue: () => void;
  onStackQueuedSend: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          providerDisplayName={props.activeThreadProviderDisplayName}
        />
      ) : null}
      {props.isPreparingWorktree ? (
        <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        isQueued={props.isQueued}
        canStackQueuedSend={props.canStackQueuedSend}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onQueue={props.onQueue}
        onStackQueuedSend={props.onStackQueuedSend}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  insertTextAtEnd: (
    text: string,
    options?: { ensureLeadingBoundary?: ComposerInsertBoundary },
  ) => boolean;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
    elementContexts: ElementContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  };
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isPreparingWorktree: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activePlan: { turnId?: TurnId } | null;
  sidebarProposedPlan: { turnId?: TurnId } | null;
  planSidebarLabel: string;
  planSidebarOpen: boolean;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;
  /** Whether this thread has already run a turn (it has a session). */
  activeThreadHasStarted?: boolean;
  // Context window
  activeThreadActivities: Thread["activities"] | undefined;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  /** Something is running under this thread: a terminal subprocess, or a
      background task the agent launched. */
  terminalBusy?: boolean | undefined;
  gitCwd: string | null;
  /** Opens the terminal drawer, mirroring the window-level panel control so the
   * pane is reachable from the composer instead of only a keyboard shortcut. */
  onToggleTerminal?: (() => void) | undefined;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerElementContextsRef: React.RefObject<ElementContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  togglePlanSidebar: () => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  /** Opens the native MCP servers dialog (the /mcp menu entry). */
  onOpenMcpStatus?: (() => void) | undefined;
  /** Opens the native file rewind dialog (the /rewind menu entry). */
  onOpenRewind?: (() => void) | undefined;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId,
    activeThread,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    isConnecting,
    isSendBusy,
    sendDisabledReason,
    isPreparingWorktree,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    activePlan,
    sidebarProposedPlan,
    planSidebarLabel,
    planSidebarOpen,
    runtimeMode,
    interactionMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeThreadHasStarted,
    activeThreadActivities,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    terminalBusy = false,
    gitCwd,
    onToggleTerminal,
    promptRef,
    composerRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerElementContextsRef,
    onSend,
    onInterrupt,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    getModelDisabledReason,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    togglePlanSidebar,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
    onOpenMcpStatus,
    onOpenRewind,
  } = props;
  const isSendDisabled = sendDisabledReason !== null;

  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerElementContexts = composerDraft.elementContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftElementContext = useComposerDraftStore(
    (store) => store.removeElementContext,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.session?.providerInstanceId ??
    activeThreadModelSelection?.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider;

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(
      providerInstanceEntries,
      providerStatuses,
      explicitSelectedInstanceId,
    ) ??
    providerInstanceEntries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const requestedDriverKind: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const lockedContinuationGroupKey = useMemo((): string | null => {
    if (!lockedProvider || !activeThread) return null;
    const lockedInstanceId =
      activeThread.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId;
    if (!lockedInstanceId) return null;
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
        ?.continuationGroupKey ?? null
    );
  }, [
    activeThread,
    activeThreadModelSelection?.instanceId,
    lockedProvider,
    providerInstanceEntries,
  ]);

  // Resolve which configured instance the composer is currently targeting.
  // Priority:
  //   1. The composer draft's `activeProvider` — the user's unsaved pick
  //      from the model picker (must win, otherwise the UI appears to
  //      ignore picker selections).
  //   2. Thread's persisted instance id (server-side saved selection).
  //   3. Project default's instance id.
  //   4. First enabled entry matching the current driver kind.
  //   5. First enabled entry overall / default instance for the kind.
  //
  const selectedInstanceId = useMemo<ProviderInstanceId>(() => {
    const candidates: Array<string | null | undefined> = [
      composerDraft.activeProvider,
      activeThread?.session?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const match = providerInstanceEntries.find(
        (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
      );
      if (match) {
        // When locked to a specific driver kind, ignore persisted instance
        // ids from a different kind or continuation group.
        if (lockedProvider && match.driverKind !== lockedProvider) continue;
        if (
          lockedContinuationGroupKey &&
          match.continuationGroupKey !== lockedContinuationGroupKey
        ) {
          continue;
        }
        return match.instanceId;
      }
    }
    const compatibleEntries = providerInstanceEntries.filter(
      (entry) =>
        (!lockedProvider || entry.driverKind === lockedProvider) &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    const requestedDriverEntries = compatibleEntries.filter(
      (entry) => entry.driverKind === requestedDriverKind,
    );
    return (
      resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined)?.instanceId ??
      resolveSelectableProviderInstanceEntry(compatibleEntries, undefined)?.instanceId ??
      NO_PROVIDER_MODEL_SELECTION.instanceId
    );
  }, [
    activeProjectDefaultModelSelection?.instanceId,
    activeThread?.session?.providerInstanceId,
    activeThreadModelSelection?.instanceId,
    composerDraft.activeProvider,
    lockedContinuationGroupKey,
    lockedProvider,
    providerInstanceEntries,
    requestedDriverKind,
  ]);

  /**
   * The Claude account the composer's own picker is deciding for.
   *
   * Without it the picker asks `isMeteredModelChoice` with no account, and
   * "not known" is metered by design — so the Fable confirmation and its
   * badge appeared on a personal account that shares no quota with anyone.
   * `ChatView` had been resolving this for its own checks; the picker in the
   * composer, which is the surface people actually use, was never handed it.
   */

  // Resolve the active instance's snapshot by `instanceId` so a custom
  // instance gets its own slash commands, skills, and model list — not
  // the first snapshot for the same driver kind.
  const selectedProviderEntry = useMemo(
    () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
    [providerInstanceEntries, selectedInstanceId],
  );
  const noProviderAvailable = selectedProviderEntry === undefined;
  // The driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind;

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    threadHasStarted: activeThreadHasStarted ?? false,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const composerProviderControls = useMemo(
    () => ({
      showInteractionModeToggle: getProviderInteractionModeToggle(
        providerStatuses,
        selectedProvider,
      ),
    }),
    [providerStatuses, selectedProvider],
  );
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThreadActivities ?? []),
    [activeThreadActivities],
  );

  /**
   * The thread-level reasons a model is out of reach, on top of the ones
   * ChatView already supplies.
   *
   * The context ceiling on the metered model is composed in here rather than
   * in ChatView because this is where the context reading is derived — sending
   * it upwards only to have the answer sent back down would put the two out of
   * step for a render on every turn.
   */
  const getComposerModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      const inherited = getModelDisabledReason(instanceId, model);
      if (inherited) return inherited;
      return null;
    },
    [getModelDisabledReason],
  );
  const activeThreadProviderDisplayName = useMemo(() => {
    if (!activeThreadModelSelection) return null;
    const entry = providerStatuses.find(
      (p) => p.instanceId === activeThreadModelSelection.instanceId,
    );
    if (entry) {
      return getProviderDisplayName(providerStatuses, entry.driver);
    }
    return formatProviderDisplayName(activeThreadModelSelection.instanceId);
  }, [providerStatuses, activeThreadModelSelection]);

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState<{ key: number; active: boolean }>({
    key: 0,
    active: false,
  });
  const isMobileViewport = useMediaQuery("max-sm");
  const isComposerCollapsedMobile =
    isMobileViewport && !forceExpandedOnMobile && !isComposerFocused;

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerAttachInputRef = useRef<HTMLInputElement>(null);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const stashPulseKeyRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  /**
   * Snapshots currently being encoded, keyed by target+prompt+image ids.
   * Keyed rather than boolean so a genuinely different prompt (or a different
   * thread) can still be stashed while an earlier encode is running.
   */
  const stashInFlightRef = useRef<Set<string>>(new Set());
  /**
   * Count of pasted images still being compressed, per thread. Reserved
   * against the attachment limit so concurrent pastes can't overshoot it,
   * and checked by `submitComposer` so a send can't race an image into the
   * next draft.
   */
  const pendingImageCompressionsRef = useRef<Map<ThreadId, number>>(new Map());

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount:
          composerElementContexts.length +
          composerPreviewAnnotations.length +
          composerReviewComments.length,
      }),
    [
      composerElementContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  );

  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal build mode",
        },
        ...(onOpenMcpStatus
          ? [
              {
                id: "slash:mcp",
                type: "slash-command",
                command: "mcp",
                label: "/mcp",
                description: "MCP server status and actions for this session",
              } as const,
            ]
          : []),
        ...(onOpenRewind
          ? [
              {
                id: "slash:rewind",
                type: "slash-command",
                command: "rewind",
                label: "/rewind",
                description: "Rewind to an earlier input, edit it, and resume from there",
              } as const,
              {
                id: "slash:resume",
                type: "slash-command",
                command: "resume",
                label: "/resume",
                description: "Continue an external Claude conversation here: /resume <session-id>",
              } as const,
            ]
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = (selectedProviderStatus?.slashCommands ?? []).map(
        (command) => ({
          id: `provider-slash-command:${selectedProvider}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: selectedProvider,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }),
      );
      const query = composerTrigger.query.trim().toLowerCase();
      const slashCommandItems = [...builtInSlashCommandItems, ...providerSlashCommandItems];
      if (!query) {
        return slashCommandItems;
      }
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderStatus?.skills ?? [], composerTrigger.query).map(
        (skill) => ({
          id: `skill:${selectedProvider}:${skill.name}`,
          type: "skill" as const,
          provider: selectedProvider,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description:
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
        }),
      );
    }
    return [];
  }, [
    composerTrigger,
    onOpenMcpStatus,
    onOpenRewind,
    selectedProvider,
    selectedProviderStatus,
    workspaceEntries.entries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;

  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const showPlanSidebarToggle = Boolean(activePlan || sidebarProposedPlan || planSidebarOpen);
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending;
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [composerTriggerKind]);

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  );
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    isSendDisabled ||
    isConnecting ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    !composerSendState.hasSendableContent;
  const collapsedComposerPrimaryActionLabel = "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftImage],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftImages],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftImage],
  );

  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) return;
      const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = removal.prompt;
      setPrompt(removal.prompt);
      removeComposerDraftTerminalContext(composerDraftTarget, contextId);
      const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
    },
    [
      composerDraftTarget,
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setPrompt,
    ],
  );

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  useEffect(() => {
    composerElementContextsRef.current = composerElementContexts;
  }, [composerElementContexts, composerElementContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    promptRef,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId, promptRef]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThreadId, composerFooterActionLayoutKey, composerFooterHasWideActions]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(composerDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          composerDraftTarget,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts, promptRef]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `${serializeComposerFileLink(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        if (item.command === "resume") {
          const replacement = "/resume ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.command === "mcp" || item.command === "rewind") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            if (item.command === "mcp") {
              onOpenMcpStatus?.();
            } else {
              onOpenRewind?.();
            }
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [
      applyPromptReplacement,
      handleInteractionModeChange,
      onOpenMcpStatus,
      onOpenRewind,
      resolveActiveComposerTrigger,
    ],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const blurMobileComposerAfterSend = useCallback(() => {
    if (!isMobileViewport) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  }, [isMobileViewport]);

  const shouldBlurMobileComposerOnSubmit = useCallback(() => {
    if (!isMobileViewport) return false;
    if (
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      environmentUnavailable !== null ||
      phase === "running"
    ) {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    composerSendState.hasSendableContent,
    environmentUnavailable,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    noProviderAvailable,
    phase,
    showPlanFollowUpPrompt,
  ]);

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      if (noProviderAvailable || isSendDisabled) {
        event?.preventDefault();
        return;
      }
      // A send while a pasted image is still compressing would strand that
      // image: the turn snapshot wouldn't include it, and it would surface
      // in the *next* draft instead. Only oversized images hit this — small
      // files clear the pending counter within a microtask.
      if (activeThreadId && (pendingImageCompressionsRef.current.get(activeThreadId) ?? 0) > 0) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still compressing a pasted image.",
          description: "Send again once its thumbnail appears.",
        });
        return;
      }
      onSend(event);
      if (shouldBlurMobileComposerOnSubmit()) {
        blurMobileComposerAfterSend();
      }
    },
    [
      activeThreadId,
      blurMobileComposerAfterSend,
      isSendDisabled,
      noProviderAvailable,
      onSend,
      shouldBlurMobileComposerOnSubmit,
    ],
  );
  /**
   * A send held until the agent finishes.
   *
   * Two paths release it, one owner each. This effect owns the thread the user
   * is looking at, so the send keeps its optimistic message and scroll anchor.
   * `QueuedSendWatcher` owns every other armed thread, which is what makes a
   * queued send fire while you work elsewhere instead of on your return.
   *
   * The snapshot below is what the watcher sends. It is refreshed on every
   * edit while this thread is active — so the text stays live and editable —
   * and freezes at whatever it last held when the composer unmounts.
   */
  const queuedSendRef = useMemo(
    () =>
      activeThreadId && activeThreadEnvironmentId
        ? scopeThreadRef(activeThreadEnvironmentId, activeThreadId)
        : null,
    [activeThreadEnvironmentId, activeThreadId],
  );
  const armQueuedSend = useQueuedSendStore((store) => store.arm);
  const refreshQueuedSend = useQueuedSendStore((store) => store.refresh);
  const stackQueuedSend = useQueuedSendStore((store) => store.stack);
  const removeQueuedSend = useQueuedSendStore((store) => store.remove);
  const noteDraftQueueCancelled = useQueuedSendStore((store) => store.noteDraftQueueCancelled);
  const replaceQueuedSnapshot = useQueuedSendStore((store) => store.replaceSnapshot);
  const draftQueueCancelled = useQueuedSendStore((store) =>
    selectDraftQueueCancelled(store.cancelledDraftByThreadKey, queuedSendRef),
  );
  /**
   * The session reading the queue's dispatch gate is measured against. `phase`
   * alone cannot do it: it is derived from the same projection and so carries
   * the same lag, and the lag is exactly the window a queued message slips
   * through.
   */
  const queuedSendSessionUpdatedAt = useThreadShell(queuedSendRef)?.session?.updatedAt ?? null;
  const queuedDispatchInFlight = useQueuedSendStore((store) =>
    selectQueuedDispatchInFlight(
      store.dispatchingByThreadKey,
      queuedSendRef,
      queuedSendSessionUpdatedAt,
    ),
  );
  // Subscribing to the boolean rather than the entry keeps a refresh per
  // keystroke from re-rendering the composer.
  const isSendQueued = useQueuedSendStore(
    (store) => selectDraftQueuedSend(store.entriesByThreadKey, queuedSendRef) !== null,
  );
  /**
   * The messages frozen ahead of this composer, drawn as their own rows above
   * it. The live draft's entry is deliberately filtered out: `refresh`
   * rewrites it on every keystroke, so keeping it here would mean a second
   * render per character typed — `useShallow` only holds because what is left
   * changes on stack, remove and release, and not on typing.
   */
  const stackedQueuedSends = useQueuedSendStore(
    useShallow((store) =>
      selectQueuedSends(store.entriesByThreadKey, queuedSendRef).filter(
        (entry) => !entry.tracksDraft,
      ),
    ),
  );
  /**
   * Bumped only by a claim, never by a cancel — which is the whole reason the
   * store counts releases instead of watching the queue empty out. See the
   * drain effect below.
   */
  const queuedSendReleaseCount = useQueuedSendStore((store) =>
    queuedSendRef === null
      ? 0
      : (store.releaseCountByThreadKey[scopedThreadKey(queuedSendRef)] ?? 0),
  );
  /**
   * What the drain effect has already reacted to for this thread.
   *
   * In the store, per thread, and not in a ref: a ref is reset on a thread
   * switch and lost on unmount, and both of the things that read this outlive
   * the composer. The cancel guard moved for the same reason, one bug earlier.
   */
  const handledReleaseCount = useQueuedSendStore((store) =>
    selectHandledReleaseCount(store.handledReleaseByThreadKey, queuedSendRef),
  );
  const noteQueueReleaseHandled = useQueuedSendStore((store) => store.noteQueueReleaseHandled);
  const hasQueuedSends = isSendQueued || stackedQueuedSends.length > 0;
  /**
   * The builtin CH3 would intercept rather than send — mirroring `onSend`'s
   * guard exactly, both halves of it.
   *
   * A builtin only counts when nothing is attached, and only when the runtime
   * does *not* advertise it: Claude executes its own `/clear` in-session, and
   * intercepting that broke real work. Treating every slash builtin as
   * un-sendable would refuse "finish this turn, then clear the context".
   */
  const queuedInterceptedBuiltin = useMemo(
    () =>
      resolveInterceptedComposerBuiltin({
        trimmedPrompt: composerSendState.trimmedPrompt,
        hasAttachments:
          composerImages.length > 0 ||
          composerSendState.sendableTerminalContexts.length > 0 ||
          composerElementContexts.length > 0 ||
          composerPreviewAnnotations.length > 0 ||
          composerReviewComments.length > 0,
        providerCommandNames: (selectedProviderStatus?.slashCommands ?? []).map(
          (command) => command.name,
        ),
      }),
    [
      composerElementContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerSendState.sendableTerminalContexts.length,
      composerSendState.trimmedPrompt,
      selectedProviderStatus?.slashCommands,
    ],
  );
  const buildQueuedSendSnapshot = useCallback(
    (): QueuedSendSnapshot => ({
      text: buildOutgoingTurnText({
        prompt,
        terminalContexts: composerSendState.sendableTerminalContexts,
        elementContexts: composerElementContexts,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
      }),
      prompt,
      images: composerImages,
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
      hasSendableContent: composerSendState.hasSendableContent,
      interactiveBuiltin: queuedInterceptedBuiltin,
      draftSignature: composerDraftSignature(composerDraft),
    }),
    [
      composerElementContexts,
      composerImages,
      composerPreviewAnnotations,
      composerReviewComments,
      composerSendState.hasSendableContent,
      composerSendState.sendableTerminalContexts,
      composerDraft,
      interactionMode,
      queuedInterceptedBuiltin,
      runtimeMode,
      selectedModel,
      selectedModelSelection,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
    ],
  );
  const toggleQueuedSend = useCallback(() => {
    if (!queuedSendRef) return;
    const draftEntry = selectDraftQueuedSend(
      useQueuedSendStore.getState().entriesByThreadKey,
      queuedSendRef,
    );
    if (draftEntry !== null) {
      // A cancel has to stick. The drain effect re-arms whatever is in the
      // composer when the queue empties, and without this flag it would put
      // back the very message the user just clicked out of the queue.
      noteDraftQueueCancelled(queuedSendRef);
      removeQueuedSend(queuedSendRef, draftEntry.id);
      return;
    }
    armQueuedSend(queuedSendRef, buildQueuedSendSnapshot());
  }, [
    armQueuedSend,
    buildQueuedSendSnapshot,
    noteDraftQueueCancelled,
    queuedSendRef,
    removeQueuedSend,
  ]);

  /**
   * Take a queued message back into the composer, rather than destroy it.
   *
   * The X on a queued row used to delete the message outright, with no undo —
   * the one control on a row people press to EDIT what they wrote. It now
   * hands the message back to the composer. If the composer is holding
   * something of its own, that draft takes the vacated slot in the queue, so
   * the click costs nothing either way and the queue keeps its order.
   */
  const restoreQueuedSendToComposer = useCallback(
    (entry: QueuedSendEntry) => {
      if (queuedSendRef === null || composerDraftTarget === null) return;
      // Read before the write: the swap overwrites this entry's snapshot.
      const restored = entry.snapshot;
      if (composerSendState.hasSendableContent) {
        replaceQueuedSnapshot(queuedSendRef, entry.id, buildQueuedSendSnapshot());
      } else {
        removeQueuedSend(queuedSendRef, entry.id);
      }
      // The whole draft, not just the prompt — the same clear stacking runs,
      // and for the same reason. The snapshot that just took this slot carries
      // the composer's images, terminal and element contexts, preview
      // annotations and review comments baked into its outgoing text, so
      // leaving them in the composer would send every one of them twice.
      promptRef.current = restored.prompt;
      clearComposerDraftContent(composerDraftTarget);
      setComposerHighlightedItemId(null);
      setComposerDraftPrompt(composerDraftTarget, restored.prompt);
      // Caret at the END, and the box focused. Taking a message back is the
      // start of editing it: a clear leaves the cursor at 0, so without this
      // the user lands in front of their own sentence and types into its
      // opening. Same tail `setPromptFromTraits` runs for the same reason.
      const restoredCursor = collapseExpandedComposerCursor(
        restored.prompt,
        restored.prompt.length,
      );
      setComposerCursor(restoredCursor);
      setComposerTrigger(detectComposerTrigger(restored.prompt, restoredCursor));
      scheduleComposerFocus();
      // Images come back too. The row renders them as chips, so handing back
      // the text alone destroys attachments the user can see — the deletion
      // this button was changed to stop doing.
      if (restored.images.length > 0) {
        addComposerDraftImages(composerDraftTarget, [...restored.images]);
      }
    },
    [
      addComposerDraftImages,
      buildQueuedSendSnapshot,
      clearComposerDraftContent,
      composerDraftTarget,
      composerSendState.hasSendableContent,
      promptRef,
      queuedSendRef,
      removeQueuedSend,
      replaceQueuedSnapshot,
      scheduleComposerFocus,
      setComposerDraftPrompt,
    ],
  );

  /**
   * Freezes what is in the composer as one more queued message and hands the
   * composer back empty for the next one, splitting the box: frozen rows on
   * top, each with its own spinner, a live editor underneath.
   *
   * Repeatable, and deliberately uncapped — the composer gets visibly cramped
   * as rows pile up, and that is a better deterrent than a number telling
   * someone "no".
   */
  const stackDraftQueuedSend = useCallback(() => {
    if (!queuedSendRef || !composerSendState.hasSendableContent) return;
    // `stack` freezes the tail, so the draft has to *be* the tail first. It
    // already is when the user queued this message before pressing +; it is
    // not on the second press, which starts from a composer the first press
    // left unqueued.
    if (
      selectDraftQueuedSend(useQueuedSendStore.getState().entriesByThreadKey, queuedSendRef) ===
      null
    ) {
      armQueuedSend(queuedSendRef, buildQueuedSendSnapshot());
    }
    stackQueuedSend(queuedSendRef);
    // The same clear a send runs (ChatView's onSend path). It has to be the
    // whole draft, not just the prompt: the frozen entry already carries the
    // terminal and element contexts, preview annotations and review comments
    // baked into its outgoing text, so leaving them behind would attach them
    // to the next message as well.
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);
    // Stacking is the opposite of a cancel, and `arm` above has already
    // retired it: the user is asking for more in the queue, so the drain
    // effect is welcome to arm what they type next.
  }, [
    armQueuedSend,
    buildQueuedSendSnapshot,
    clearComposerDraftContent,
    composerDraftTarget,
    composerSendState.hasSendableContent,
    promptRef,
    queuedSendRef,
    stackQueuedSend,
  ]);

  useEffect(() => {
    if (!queuedSendRef || !isSendQueued) return;
    refreshQueuedSend(queuedSendRef, buildQueuedSendSnapshot());
  }, [buildQueuedSendSnapshot, isSendQueued, queuedSendRef, refreshQueuedSend]);

  // Release the moment the turn is no longer running. `phase` covers every way
  // a turn can end — completed, interrupted, or failed — so a queued message
  // is never stranded by a turn that stopped without finishing cleanly.
  useEffect(() => {
    if (!queuedSendRef || phase === "running") return;
    if (isSendBusy || isConnecting) return;
    // An entry claimed ahead of this draft has not reached the server yet.
    // `stackedCount` goes to zero the instant the watcher claims the last
    // frozen entry, and `phase` is still `ready` until a server event comes
    // back — so without this the composer fires its own message alongside the
    // one that just went out, which is the concurrency the gate exists to stop.
    if (queuedDispatchInFlight) return;
    if (
      !canComposerReleaseQueuedDraft({
        draftIsQueued: isSendQueued,
        stackedCount: stackedQueuedSends.length,
      })
    ) {
      return;
    }
    if (!composerSendState.hasSendableContent) {
      // Nothing left to send (the draft was cleared): drop the queue rather
      // than sit armed forever.
      const draftEntry = selectDraftQueuedSend(
        useQueuedSendStore.getState().entriesByThreadKey,
        queuedSendRef,
      );
      if (draftEntry !== null) removeQueuedSend(queuedSendRef, draftEntry.id);
      return;
    }
    // Claim removes the entry in the same tick, so the watcher can never also
    // send this. It carries the session reading this send is about to
    // invalidate, so nothing queued behind it goes out until the server has
    // reported past it.
    if (claimQueuedSend(queuedSendRef, queuedSendSessionUpdatedAt) === null) return;
    // Our own release. Booking it here keeps the drain effect from reading a
    // draft that `submitComposer` has not cleared yet and queueing the message
    // a second time.
    noteQueueReleaseHandled(
      queuedSendRef,
      useQueuedSendStore.getState().releaseCountByThreadKey[scopedThreadKey(queuedSendRef)] ?? 0,
    );
    // The claim marked this thread as dispatching so nothing queued behind it
    // could go out alongside it. That mark is released by the server moving
    // past it, NOT here — a send that worked and a `phase` that has not caught
    // up are indistinguishable, and releasing on the former is what let a
    // three-deep queue go out as three turns in 175 ms.
    //
    // A throw is the one case that must release by hand: `submitComposer` is
    // synchronous and can throw, and a send that never happened will never
    // move the session, so the thread would gate forever and silently strand
    // every message behind this one.
    try {
      submitComposer();
    } catch (error) {
      useQueuedSendStore.getState().finishQueuedDispatch(queuedSendRef);
      throw error;
    }
  }, [
    composerSendState.hasSendableContent,
    isConnecting,
    isSendBusy,
    isSendQueued,
    phase,
    queuedDispatchInFlight,
    queuedSendRef,
    queuedSendSessionUpdatedAt,
    removeQueuedSend,
    stackedQueuedSends.length,
    submitComposer,
  ]);

  /**
   * When the queue empties, whatever is in the composer takes its place in it.
   *
   * Without this a stack built with + strands its own last message: + freezes
   * the message above and hands back an *unqueued* composer, so the bottom one
   * would sit there watching everything above it go out. Reacting to
   * `releaseCountByThreadKey` rather than to "the queue is empty" is what
   * separates a send from a cancel — a cancel empties the queue too, and
   * re-arming after one would make the queue button look broken.
   */
  useEffect(() => {
    if (queuedSendRef === null) return;
    if (handledReleaseCount === null) {
      // Never seen in this tab: adopt this thread's history rather than
      // reading its first render as a release.
      noteQueueReleaseHandled(queuedSendRef, queuedSendReleaseCount);
      return;
    }
    const rearm = shouldRearmDraftAfterQueueDrain({
      releaseCount: queuedSendReleaseCount,
      handledReleaseCount,
      cancelledDraftQueue: draftQueueCancelled,
      draftIsQueued: isSendQueued,
      stackedCount: stackedQueuedSends.length,
      hasSendableContent: composerSendState.hasSendableContent,
    });
    noteQueueReleaseHandled(queuedSendRef, queuedSendReleaseCount);
    if (!rearm) return;
    armQueuedSend(queuedSendRef, buildQueuedSendSnapshot());
  }, [
    armQueuedSend,
    buildQueuedSendSnapshot,
    composerSendState.hasSendableContent,
    draftQueueCancelled,
    handledReleaseCount,
    isSendQueued,
    noteQueueReleaseHandled,
    queuedSendReleaseCount,
    queuedSendRef,
    stackedQueuedSends.length,
  ]);

  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  }, []);

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }
    const { trigger, snapshot } = resolveActiveComposerTrigger();
    // A fully typed interactive built-in ("/mcp", "/rewind", "/resume <id>",
    // "/login", ...) must SUBMIT so the guard runs — the open menu would
    // otherwise steal Enter and select whatever fuzzy match is highlighted
    // (typing /resume matched /clear via its description).
    if (
      key === "Enter" &&
      parseComposerInteractiveBuiltin(snapshot.value) !== null &&
      shouldSubmitComposerOnEnter({ isMobileViewport, shiftKey: event.shiftKey })
    ) {
      submitComposer();
      return true;
    }
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if (
      key === "Enter" &&
      shouldSubmitComposerOnEnter({ isMobileViewport, shiftKey: event.shiftKey })
    ) {
      // With a queue already up, Enter joins it rather than jumps it.
      //
      // The messages above are waiting on the running turn; sending this one
      // straight out delivers it BEFORE them, which is the opposite of what a
      // queue is for — and the two arrive in the same breath, so the agent
      // reads them as one message. Reaching for + on every line to avoid that
      // is not a queue either. Enter is what people press.
      if (
        shouldStackDraftOnEnter({
          hasQueuedSends,
          hasSendableContent: composerSendState.hasSendableContent,
          sendBlocked:
            isSendDisabled ||
            isConnecting ||
            (activeThreadId !== null &&
              (pendingImageCompressionsRef.current.get(activeThreadId) ?? 0) > 0),
        })
      ) {
        stackDraftQueuedSend();
        return true;
      }
      submitComposer();
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------------
  // Prompt stash (⌘S)
  // ------------------------------------------------------------------
  // One global queue. Stashed prompts carry only text + images so they can be
  // restored into any thread or provider — stash, switch, restore is the
  // whole point.
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  useEffect(() => {
    return () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    };
  }, []);

  /** Briefly highlight the badge so the save registers without a flourish. */
  const pulseStashBadge = useCallback(() => {
    stashPulseKeyRef.current += 1;
    setStashPulse({ key: stashPulseKeyRef.current, active: true });
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      stashPulseTimeoutRef.current = null;
      setStashPulse((current) => ({ ...current, active: false }));
    }, 1200);
  }, []);

  const restoreStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      // Remove first so a double activation (click + Enter) can't restore twice.
      const { entry: taken, durable } = takeStashEntry(entry.id);
      if (!taken) return;
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Restored prompt may reappear in the stash",
          description:
            "Browser storage rejected the update, so this entry could still be there after a reload.",
          data: { hideCopyButton: true },
        });
      }
      setIsStashMenuOpen(false);

      const currentPrompt = promptRef.current;
      // An image-only stash must not append blank lines to whatever is
      // already in the composer.
      const nextPrompt =
        entry.prompt.length === 0
          ? currentPrompt
          : currentPrompt.trim().length
            ? `${currentPrompt.replace(/\s+$/, "")}\n\n${entry.prompt}`
            : entry.prompt;
      const promptChanged = nextPrompt !== currentPrompt;
      if (promptChanged) {
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
        setComposerTrigger(null);
      }

      let unrestoredImageNames: string[] = [];
      if (entry.attachments.length > 0) {
        const existingIds = new Set(composerImagesRef.current.map((image) => image.id));
        // The draft store also dedupes by mimeType+sizeBytes+name, so filter
        // on the same key here. Counting a duplicate against capacity would
        // burn a slot the store then refuses to fill, pushing a genuinely
        // unique image into the overflow list for nothing.
        const existingDedupKeys = new Set(
          composerImagesRef.current.map(
            (image) => `${image.mimeType} ${image.sizeBytes} ${image.name}`,
          ),
        );
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - composerImagesRef.current.length,
        );
        const pending = entry.attachments.filter(
          (attachment) =>
            !existingIds.has(attachment.id) &&
            !existingDedupKeys.has(
              `${attachment.mimeType} ${attachment.sizeBytes} ${attachment.name}`,
            ),
        );
        // Anything past the attachment limit cannot be restored. The entry is
        // already out of the queue, so report the overflow by name instead of
        // discarding it silently.
        unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
        const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
        if (restoredImages.length > 0) {
          addComposerDraftImages(composerDraftTarget, restoredImages);
        }
      }

      // Deliberately no model/provider restore: the stash exists to carry a
      // prompt across threads and providers, so whatever the composer has
      // selected right now stays selected.

      // Each cause gets its own sentence so "too large" is never blamed for a
      // file that actually failed to decode, or for one the composer simply
      // had no room to take back.
      const missingImageReasons: string[] = [];
      if (entry.droppedImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.droppedImageNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
        );
      }
      if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.unreadableImageNames.join(", ")} could not be read when this prompt was saved.`,
        );
      }
      if (unrestoredImageNames.length > 0) {
        missingImageReasons.push(
          `${unrestoredImageNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit.`,
        );
      }
      if (missingImageReasons.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some images were not restored",
          description: missingImageReasons.join(" "),
        });
      }

      // Only yank the caret to the end when text was actually inserted;
      // restoring images alone should leave the user where they were typing.
      if (promptChanged) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      }
    },
    [
      addComposerDraftImages,
      composerDraftTarget,
      composerImagesRef,
      promptRef,
      setComposerDraftPrompt,
      takeStashEntry,
    ],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { durable } = takeStashEntry(entry.id);
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description:
            "Browser storage rejected the delete, so this prompt could reappear after a reload.",
          data: { hideCopyButton: true },
        });
      }
    },
    [takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    // Terminal-context placeholders reference live sessions the stash can't
    // round-trip, so they are stripped from the stashed prompt.
    const prompt = promptRef.current.split(INLINE_TERMINAL_CONTEXT_PLACEHOLDER).join("").trim();
    const images = [...composerImagesRef.current];
    if (prompt.length === 0 && images.length === 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    // A repeat ⌘S on the *same* still-unencoded snapshot would stash it
    // twice. Guard on the snapshot itself rather than a bare boolean: once
    // the composer has been cleared the user can type something genuinely
    // new (or switch threads) while encoding continues, and that deserves its
    // own entry.
    const snapshotKey = `${String(composerDraftTarget)} ${prompt} ${images
      .map((image) => image.id)
      .join(",")}`;
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    const entryId = randomUUID();
    try {
      // Persist the text-only entry *first*, then clear. Ordering matters in
      // both directions: writing before clearing means a crash or closed tab
      // mid-encode still leaves the prompt recoverable, while clearing before
      // the async image work means edits typed during encoding are not wiped.
      // Images are appended to the stored entry as they finish encoding.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
      });

      // Clearing the composer is only safe once the write actually landed.
      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "Could not stash this prompt",
          description:
            "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
          data: { hideCopyButton: true },
        });
        return;
      }
      // Written but only into the in-memory fallback (localStorage blocked):
      // the entry is visible and restorable this session, so proceed with the
      // clear, but say it won't survive a reload.
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory only for this session.",
          data: { hideCopyButton: true },
        });
      }

      // Only the prompt and images are cleared — terminal/element contexts,
      // preview annotations, and review comments are not stashable, so
      // destroying them here would be unrecoverable.
      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();

      if (evicted) {
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB. Only the stashed copy shrinks; the live attachment (and
      // anything sent without stashing) keeps the original file.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          // "too large" and "could not be read" are distinct outcomes; the
          // menu and restore toast report them separately.
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        // The second phase can be rejected on its own: the text-only entry
        // fit, but adding image payloads pushed past the quota. Disk would
        // then still hold the phase-one entry with pendingImageCount set,
        // which reads as an orphan after reload — so say so now. Gated on the
        // entry write having been durable: on the in-memory fallback nothing
        // is ever durable, and the session-only warning already covered it.
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images were not saved",
            description:
              "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        // The entry was restored or deleted before its images finished
        // encoding, so they have nowhere to land. Say so rather than letting
        // them evaporate.
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? "" : "s"} finished saving. Re-attach ${kept.length === 1 ? "it" : "them"} if you still need ${kept.length === 1 ? "it" : "them"}.`,
          data: { hideCopyButton: true },
        });
      }
    } finally {
      // Must clear on every path: a throw that left this set would wedge this
      // snapshot's ⌘S until the composer remounts.
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    clearComposerDraftPromptAndImages,
    composerDraftTarget,
    composerImagesRef,
    finalizeStashEntryImages,
    promptRef,
    pulseStashBadge,
    stashEntryToQueue,
  ]);

  const toggleStashMenu = useCallback(() => {
    setIsStashMenuOpen((open) => !open);
  }, []);

  // Close the stash menu whenever the trigger-driven command menu opens so
  // the two popovers never stack in the same layer, and when the user
  // resumes typing (the menu is a transient picker, not a panel).
  useEffect(() => {
    if (composerMenuOpen) {
      setIsStashMenuOpen(false);
    }
  }, [composerMenuOpen]);
  useEffect(() => {
    setIsStashMenuOpen(false);
  }, [prompt]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      });
      if (command !== "composer.stash") return;
      // Always claim the shortcut so the browser save dialog never opens,
      // even when the composer is in a state that can't stash.
      event.preventDefault();
      event.stopPropagation();
      if (
        isCommandPaletteOpen() ||
        isComposerApprovalState ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        activePendingProgress !== null
      ) {
        return;
      }
      void stashCurrentPrompt();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activePendingProgress,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    keybindings,
    pendingUserInputs.length,
    projectSelectionRequired,
    stashCurrentPrompt,
    terminalOpen,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: images
  // ------------------------------------------------------------------
  const addComposerImages = async (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (via the pending counter)
    // before the first await, keeping the total under the limit.
    const pendingCount = pendingImageCompressionsRef.current.get(threadId) ?? 0;
    const { accepted: acceptedFiles, error } = acceptComposerImageFiles({
      files,
      alreadyReserved: composerImagesRef.current.length + pendingCount,
    });
    setThreadError(threadId, error);
    if (acceptedFiles.length === 0) return;

    pendingImageCompressionsRef.current.set(threadId, pendingCount + acceptedFiles.length);
    try {
      const { images: nextImages, error: compressionError } =
        await compressComposerImageFiles(acceptedFiles);
      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      // Only failures are reported here. Success must not pass `null`: by
      // now other work (a failed send, an overlapping paste) may have set a
      // thread error this call knows nothing about, and clearing it would
      // swallow that message.
      if (compressionError !== null) {
        setThreadError(threadId, compressionError);
      }
    } finally {
      const remaining =
        (pendingImageCompressionsRef.current.get(threadId) ?? 0) - acceptedFiles.length;
      if (remaining > 0) {
        pendingImageCompressionsRef.current.set(threadId, remaining);
      } else {
        pendingImageCompressionsRef.current.delete(threadId);
      }
    }
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  /**
   * Files into the composer, from a drop or from the Attach picker — one body
   * so the button cannot drift from the drag it makes discoverable. False when
   * the input yielded neither an image nor a path; only the drop can say what
   * the payload actually was, so it owns that message.
   */
  const addComposerFiles = (files: ReadonlyArray<File>, uriList: string): boolean => {
    // Images attach; anything else contributes its PATH to the prompt. Dragging
    // a document in used to be answered with "Unsupported file type … attach
    // image files only", which refused the one thing the drag was asking for.
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const otherFiles = files.filter((file) => !file.type.startsWith("image/"));
    if (imageFiles.length > 0) {
      void addComposerImages(imageFiles);
    }
    if (otherFiles.length === 0 && (imageFiles.length > 0 || uriList.length === 0)) {
      return imageFiles.length > 0;
    }
    // Wrapped so an unexpected failure is named rather than swallowed: a
    // throw inside a React event handler leaves no UI trace at all.
    try {
      const { paths, unresolved } = resolveDroppedFilePaths({
        files: otherFiles,
        uriList,
        ...(window.desktopBridge?.getPathForFile
          ? { getPathForFile: window.desktopBridge.getPathForFile }
          : {}),
      });
      if (paths.length > 0) {
        const inserted = insertComposerTextAtEnd(composerTextForDroppedPaths(paths), {
          ensureLeadingBoundary: "space",
        });
        // A rejected insert means the composer is mid-approval, connecting, or
        // waiting on plan input. Saying so beats a drop that appears to work
        // and leaves the prompt untouched.
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The composer is busy; try again once it is ready.",
          });
        }
      } else if (unresolved.length > 0) {
        toastManager.add({
          type: "error",
          title: "Could not read a path for that file",
          description:
            unresolved.length === 1
              ? `'${unresolved[0]}' carried no filesystem path. Paste its path instead.`
              : `${unresolved.length} files carried no filesystem path.`,
        });
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not read that file",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return true;
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    // The DataTransfer is neutered the moment this handler returns, so every
    // read of it happens here, synchronously. `text/plain` is consulted too:
    // some sources publish the file URL only there.
    const uriList = [
      event.dataTransfer.getData("text/uri-list"),
      event.dataTransfer.getData("text/plain"),
    ]
      .filter((value) => value.length > 0)
      .join("\n");
    if (!addComposerFiles(files, uriList)) {
      // The drag announced files (the guard above) yet exposed neither a File
      // nor a URL. Naming what it DID carry is the only way to tell that apart
      // from a handler that never ran.
      toastManager.add({
        type: "error",
        title: "Nothing to add from that drop",
        description: `The drag carried no file path. It offered: ${
          Array.from(event.dataTransfer.types).join(", ") || "nothing"
        }.`,
      });
    }
    // Deferred, not synchronous. focusAtEnd makes the editor write its
    // last-synced snapshot back through onChange, and inside this handler that
    // snapshot is still pre-insert — so a synchronous focus erases the text
    // this drop just inserted, in the same tick, leaving no error and no clue.
    // composerMentionDrag.ts:35-40 documents this trap; the mention drop path
    // never focuses synchronously for exactly this reason.
    scheduleComposerFocus();
  };

  // Stable identity: every other prop this memoized footer takes is stable, so
  // an inline arrow here would re-render the whole control row on each
  // keystroke. The ref it closes over never changes.
  const openComposerAttachPicker = useCallback(() => {
    composerAttachInputRef.current?.click();
  }, []);

  const onComposerAttachInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = takeFilesFromInput(event.currentTarget);
    // Cancelling the picker is not an error and gets no toast.
    if (files.length === 0) return;
    // No uri-list: a file input carries File objects and nothing else.
    addComposerFiles(files, "");
    // Deferred for the same reason the drop defers — see onComposerDrop.
    scheduleComposerFocus();
  };

  const insertComposerTextAtEnd = (
    text: string,
    options?: { ensureLeadingBoundary?: ComposerInsertBoundary },
  ): boolean => {
    if (
      text.length === 0 ||
      isConnecting ||
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      projectSelectionRequired
    ) {
      return false;
    }
    // The boundary is resolved here, against promptRef, because that is the
    // string the insert lands on. A caller deciding it from a snapshot reads
    // the editor's last-synced value, which lags a controlled update by a
    // render — the same staleness that once erased a whole dropped path.
    const prompt = promptRef.current;
    const separator = composerInsertSeparator(prompt, options?.ensureLeadingBoundary);
    return applyPromptReplacement(prompt.length, prompt.length, `${separator}${text}`);
  };

  // File-tree drags land as mentions. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: "space" }),
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (!isMobileViewport) {
      return;
    }
    if (mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const activeElement = document.activeElement;
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
        return;
      }
      if (
        composerSurface &&
        activeElement instanceof Node &&
        composerSurface.contains(activeElement)
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isMobileViewport]);

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      insertTextAtEnd: insertComposerTextAtEnd,
      openModelPicker: () => {
        setIsComposerModelPickerOpen(true);
      },
      toggleModelPicker: () => {
        setIsComposerModelPickerOpen((open) => !open);
      },
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread) return;
        const snapshot = composerEditorRef.current?.readSnapshot() ?? {
          value: promptRef.current,
          cursor: composerCursor,
          expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
          terminalContextIds: composerTerminalContexts.map((context) => context.id),
        };
        const insertion = insertInlineTerminalContextPlaceholder(
          snapshot.value,
          snapshot.expandedCursor,
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          {
            id: randomUUID(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...selection,
          },
          insertion.contextIndex,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        elementContexts: composerElementContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        providerAvailable: !noProviderAvailable,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
      }),
    }),
    [
      activeThread,
      composerDraftTarget,
      composerCursor,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      isConnecting,
      isComposerApprovalState,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacement,
      isComposerModelPickerOpen,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      noProviderAvailable,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  // Render
  // ------------------------------------------------------------------
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className="mx-auto w-full min-w-0 max-w-5xl"
      data-chat-composer-form="true"
    >
      {/* The Attach button's picker. No `accept`: a document is as welcome as
          an image here, it just contributes its path instead of attaching. */}
      <input
        ref={composerAttachInputRef}
        type="file"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-chat-composer-attach-input="true"
        onChange={onComposerAttachInputChange}
      />
      <div
        className={cn(
          "group rounded-[22px] p-px transition-colors duration-200",
          composerProviderState.composerFrameClassName,
        )}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        onDragEnterCapture={composerMentionDragHandlers.onDragEnter}
        onDragOverCapture={composerMentionDragHandlers.onDragOver}
        onDragLeaveCapture={onComposerMentionDragLeaveCapture}
        onDropCapture={composerMentionDragHandlers.onDrop}
      >
        <div
          ref={composerSurfaceRef}
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
          className={cn(
            "rounded-[20px] transition-[background-color] duration-200",
            isDragOverComposer ? "bg-accent/45 ring-1 ring-primary/70" : null,
            projectSelectionRequired ? "opacity-75" : null,
            composerProviderState.composerSurfaceClassName,
          )}
          onFocusCapture={(event) => {
            const activeElement = event.target;
            if (
              isComposerCollapsedMobile &&
              activeElement instanceof HTMLElement &&
              activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
            ) {
              return;
            }
            if (composerBlurFrameRef.current !== null) {
              window.cancelAnimationFrame(composerBlurFrameRef.current);
              composerBlurFrameRef.current = null;
            }
            setIsComposerFocused(true);
          }}
          onBlurCapture={() => {
            scheduleComposerCollapseCheck();
          }}
        >
          {!isComposerCollapsedMobile &&
            (activePendingApproval ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null)}

          {isComposerCollapsedMobile && activePendingApproval ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
                <ComposerPendingApprovalActions
                  requestId={activePendingApproval.requestId}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                />
              </div>
            </div>
          ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
              <div className="px-3 pb-3 sm:px-4">
                <div
                  data-chat-composer-mobile-pending-compact="true"
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                    !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                      activePendingProgress?.customAnswer
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                      !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                    )}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandMobileComposer}
                    aria-label="Write custom answer"
                  >
                    {activePendingProgress?.customAnswer || "Write custom answer"}
                  </button>
                  {activePendingProgress?.activeQuestion?.multiSelect ? (
                    <ComposerPrimaryActions
                      compact
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      isQueued={false}
                      canStackQueuedSend={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        noProviderAvailable ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onQueue={toggleQueuedSend}
                      onStackQueuedSend={stackDraftQueuedSend}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {showCollapsedMobilePromptRow ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[14px] focus:outline-none",
                  (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                    ? "text-foreground"
                    : "text-muted-foreground/35",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={expandMobileComposer}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? activePendingProgress.customAnswer ||
                    "Type your own answer, or leave this blank to use the selected option"
                  : prompt.trim() ||
                    (noProviderAvailable ? "Enable a provider in Settings" : "Ask anything...")}
              </button>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/90 text-primary-foreground disabled:opacity-30"
                disabled={collapsedComposerPrimaryActionDisabled}
                aria-label={collapsedComposerPrimaryActionLabel}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  submitComposer();
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 3L8 13M8 3L4 7M8 3L12 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : null}

          <div
            ref={setComposerMenuAnchor}
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
              isComposerCollapsedMobile && "hidden",
            )}
          >
            <ComposerStashBadge
              count={stashQueue.length}
              pulseKey={stashPulse.key}
              pulsing={stashPulse.active}
              menuOpen={isStashMenuOpen}
              onToggleMenu={toggleStashMenu}
            />

            {isStashMenuOpen && !composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerStashMenu
                  entries={stashQueue}
                  onRestore={restoreStashEntry}
                  onDelete={deleteStashEntry}
                  onClose={() => setIsStashMenuOpen(false)}
                />
              </ComposerCommandMenuLayer>
            )}

            {composerMenuOpen && !isComposerApprovalState && (
              <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  groupSlashCommandSections={
                    composerTrigger?.kind === "slash-command" &&
                    composerTrigger.query.trim().length === 0
                  }
                  emptyStateText={composerMenuEmptyState}
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </ComposerCommandMenuLayer>
            )}

            {/* Above the live composer, oldest first: the messages already
                frozen behind the running turn. The draft's own queued entry is
                not here — this composer *is* that entry.

                Deliberately NOT hidden behind an approval prompt or a pending
                input the way the annotation and command layers are. Each row's
                X is the only way to take a message back out of the queue, and
                an approval is exactly when the user wants it: they have just
                watched the agent ask to do something they may not want, and
                the messages stacked behind it are about to fire the moment the
                turn ends. Hiding the way out at that moment is the one-way
                door CLAUDE.md forbids. */}
            {!isComposerCollapsedMobile &&
              queuedSendRef !== null &&
              stackedQueuedSends.length > 0 && (
                <ComposerQueuedSends
                  entries={stackedQueuedSends}
                  threadRef={queuedSendRef}
                  onRestore={restoreQueuedSendToComposer}
                  skills={selectedProviderStatus?.skills ?? []}
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerPreviewAnnotations.length > 0 && (
                <ComposerPreviewAnnotationCards
                  annotations={composerPreviewAnnotations}
                  images={composerImages}
                  onRemove={(annotationId) =>
                    removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId)
                  }
                  onExpandImage={(imageId) => {
                    const preview = buildExpandedImagePreview(composerImages, imageId);
                    if (preview) onExpandImage(preview);
                  }}
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerReviewComments.length > 0 && (
                <ComposerPendingReviewComments
                  comments={composerReviewComments}
                  onRemove={(commentId) =>
                    removeComposerDraftReviewComment(composerDraftTarget, commentId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerElementContexts.length > 0 && (
                <ComposerPendingElementContexts
                  contexts={composerElementContexts}
                  onRemove={(contextId) =>
                    removeComposerDraftElementContext(composerDraftTarget, contextId)
                  }
                  className="mb-3"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerImages.some(
                (image) =>
                  !composerPreviewAnnotations.some((annotation) => annotation.id === image.id),
              ) && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerImages
                    .filter(
                      (image) =>
                        !composerPreviewAnnotations.some(
                          (annotation) => annotation.id === image.id,
                        ),
                    )
                    .map((image) => (
                      <div
                        key={image.id}
                        className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                      >
                        {image.previewUrl ? (
                          <button
                            type="button"
                            className="h-full w-full cursor-zoom-in"
                            aria-label={`Preview ${image.name}`}
                            onClick={() => {
                              const preview = buildExpandedImagePreview(composerImages, image.id);
                              if (!preview) return;
                              onExpandImage(preview);
                            }}
                          >
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                            {image.name}
                          </div>
                        )}
                        {nonPersistedComposerImageIdSet.has(image.id) && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  role="img"
                                  aria-label="Draft attachment may not persist"
                                  className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                >
                                  <CircleAlertIcon className="size-3" />
                                </span>
                              }
                            />
                            <TooltipPopup
                              side="top"
                              className="max-w-64 whitespace-normal leading-tight"
                            >
                              Draft attachment could not be saved locally and may be lost on
                              navigation.
                            </TooltipPopup>
                          </Tooltip>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                          onClick={() => removeComposerImage(image.id)}
                          aria-label={`Remove ${image.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))}
                </div>
              )}

            <div className="relative">
              <ComposerPromptEditor
                editorRef={composerEditorRef}
                value={
                  isComposerApprovalState
                    ? ""
                    : activePendingProgress
                      ? activePendingProgress.customAnswer
                      : prompt
                }
                cursor={composerCursor}
                terminalContexts={
                  !isComposerApprovalState && pendingUserInputs.length === 0
                    ? composerTerminalContexts
                    : []
                }
                skills={selectedProviderStatus?.skills ?? []}
                {...(showMobilePendingAnswerActions ? { className: "max-sm:pb-11" } : {})}
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                    : activePendingProgress
                      ? "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : projectSelectionRequired
                          ? "Choose a project above to start a thread"
                          : noProviderAvailable
                            ? "Enable a provider in Settings to send a message"
                            : phase === "disconnected"
                              ? "Ask for follow-up changes or attach images"
                              : "Ask anything, @tag files/folders, $use skills, or / for commands"
                }
                disabled={isConnecting || isComposerApprovalState || projectSelectionRequired}
              />
              {showMobilePendingAnswerActions ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex justify-end"
                >
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={false}
                    isQueued={false}
                    canStackQueuedSend={false}
                    showPlanFollowUpPrompt={false}
                    promptHasText={false}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={
                      environmentUnavailable !== null ||
                      noProviderAvailable ||
                      projectSelectionRequired
                    }
                    isPreparingWorktree={false}
                    hasSendableContent={false}
                    preserveComposerFocusOnPointerDown
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onQueue={toggleQueuedSend}
                    onStackQueuedSend={stackDraftQueuedSend}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* Native usage band for the in-use Claude account — session, week
              and burn-rate markers, one shared read fanned out to every thread
              (replaces the per-thread statusLine mirror that polled the
              rate-limited usage endpoint once per open conversation). */}
          {isComposerCollapsedMobile || selectedProvider !== "claudeAgent" ? null : (
            <ClaudeUsageBand environmentId={environmentId} />
          )}
          {/* OpenCode has no statusLine hook, so this is its own configured
              usage command rather than a mirror of one */}
          {isComposerCollapsedMobile || selectedProvider !== "opencode" ? null : (
            <OpenCodeUsageMetricsRow
              environmentId={environmentId}
              cwd={gitCwd}
              modelDisplayName={selectedModel}
            />
          )}
          {/* Bottom toolbar */}
          {isComposerCollapsedMobile ? null : activePendingApproval ? (
            <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
              className={cn(
                "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                pendingUserInputs.length > 0 && "pt-2",
                isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                showMobilePendingAnswerActions && "hidden sm:flex",
              )}
            >
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {noProviderAvailable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled
                    data-chat-provider-unavailable="true"
                    className="shrink-0 gap-2 px-2 text-muted-foreground/70 sm:px-3"
                  >
                    <CircleAlertIcon className="size-4" />
                    No provider available
                  </Button>
                ) : (
                  <ProviderModelPicker
                    compact={isComposerFooterCompact}
                    activeInstanceId={selectedInstanceId}
                    model={selectedModelForPickerWithCustomFallback}
                    lockedProvider={lockedProvider}
                    lockedContinuationGroupKey={lockedContinuationGroupKey}
                    instanceEntries={providerInstanceEntries}
                    keybindings={keybindings}
                    modelOptionsByInstance={modelOptionsByInstance}
                    terminalOpen={terminalOpen}
                    open={isComposerModelPickerOpen}
                    {...(composerProviderState.modelPickerIconClassName
                      ? {
                          activeProviderIconClassName:
                            composerProviderState.modelPickerIconClassName,
                        }
                      : {})}
                    onOpenChange={(open) => {
                      setIsComposerModelPickerOpen(open);
                    }}
                    getModelDisabledReason={getComposerModelDisabledReason}
                    onInstanceModelChange={onProviderModelSelect}
                  />
                )}

                {isComposerFooterCompact ? (
                  <CompactComposerControlsMenu
                    activePlan={showPlanSidebarToggle}
                    interactionMode={interactionMode}
                    planSidebarLabel={planSidebarLabel}
                    planSidebarOpen={planSidebarOpen}
                    runtimeMode={runtimeMode}
                    showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                    traitsMenuContent={providerTraitsMenuContent}
                    onToggleInteractionMode={toggleInteractionMode}
                    onTogglePlanSidebar={togglePlanSidebar}
                    onRuntimeModeChange={handleRuntimeModeChange}
                  />
                ) : (
                  <>
                    {providerTraitsPicker ? (
                      <>
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        {providerTraitsPicker}
                      </>
                    ) : null}
                    <ComposerFooterModeControls
                      showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                      interactionMode={interactionMode}
                      runtimeMode={runtimeMode}
                      showPlanToggle={showPlanSidebarToggle}
                      planSidebarLabel={planSidebarLabel}
                      planSidebarOpen={planSidebarOpen}
                      onToggleInteractionMode={toggleInteractionMode}
                      onRuntimeModeChange={handleRuntimeModeChange}
                      onTogglePlanSidebar={togglePlanSidebar}
                      showTerminalToggle={onToggleTerminal !== undefined}
                      terminalOpen={terminalOpen}
                      terminalBusy={terminalBusy}
                      terminalShortcutLabel={shortcutLabelForCommand(
                        keybindings,
                        "terminal.toggle",
                      )}
                      onToggleTerminal={onToggleTerminal ?? (() => {})}
                      onAttachFiles={openComposerAttachPicker}
                    />
                  </>
                )}
              </div>

              {/* Right side: send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                {/* Visible affordance for the ⌘S stash — the shortcut alone is
                    undiscoverable, so this is its click target. Same handler,
                    so it behaves identically: with content it stashes, empty it
                    opens the stash to restore. */}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  data-composer-stash-button="true"
                  className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                  aria-label="Stash prompt"
                  title={`Stash prompt${
                    shortcutLabelForCommand(keybindings, "composer.stash")
                      ? ` · ${shortcutLabelForCommand(keybindings, "composer.stash")}`
                      : ""
                  }`}
                  disabled={
                    isComposerApprovalState ||
                    pendingUserInputs.length > 0 ||
                    projectSelectionRequired ||
                    activePendingProgress !== null
                  }
                  // Keep composer focus so Escape/typing flows stay intact.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void stashCurrentPrompt()}
                >
                  <BookmarkIcon className="size-4" aria-hidden="true" />
                </Button>
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  activeContextWindow={activeContextWindow}
                  activeThreadProviderDisplayName={activeThreadProviderDisplayName}
                  pendingAction={pendingPrimaryAction}
                  isRunning={phase === "running"}
                  isQueued={isSendQueued}
                  canStackQueuedSend={hasQueuedSends}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={isSendBusy}
                  sendDisabledReason={sendDisabledReason}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={
                    environmentUnavailable !== null ||
                    noProviderAvailable ||
                    projectSelectionRequired
                  }
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={composerSendState.hasSendableContent}
                  preserveComposerFocusOnPointerDown={isMobileViewport}
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onQueue={toggleQueuedSend}
                  onStackQueuedSend={stackDraftQueuedSend}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </form>
  );
});
