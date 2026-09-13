import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderMcpServerAction,
  type ProviderMcpServerStatus,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
} from "@ch3tools/contracts";
import {
  connectionStatusTitle,
  type EnvironmentConnectionPresentation,
} from "@ch3tools/client-runtime/connection";
import { effectiveSettled, effectiveSnoozed } from "@ch3tools/client-runtime/state/thread-settled";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ch3tools/client-runtime/environment";
import {
  createModelSelection,
  getOutputStyleSelection,
  withOutputStyleSelection,
} from "@ch3tools/shared/model";
import { CHAT_LIST_ANCHOR_OFFSET } from "@ch3tools/shared/chatList";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@ch3tools/shared/projectScripts";
import { truncate } from "@ch3tools/shared/String";
import { nextTerminalId, resolveTerminalSessionLabel } from "@ch3tools/shared/terminalLabels";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@ch3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../env";
import { writeSelectionToClipboard, writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { readLocalApi } from "../localApi";
import { useImportClaudeSession } from "../lib/useImportClaudeSession";
import { useDiffPanelStore } from "../diffPanelStore";
import {
  collapseExpandedComposerCursor,
  describeInteractiveBuiltin,
  resolveBlockedContextReset,
  resolveInterceptedComposerBuiltin,
  parseComposerResumeSessionId,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import { type TimelineScrollMode } from "./chat/timelineScrollAnchoring";
import { McpMark } from "./mcp/McpMark";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatImageAttachment,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { buildTemporaryWorktreeBranchName } from "@ch3tools/shared/git";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import { RightPanelTabs } from "./RightPanelTabs";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  AlarmClockIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  GitBranchIcon,
  ImageIcon,
  TriangleAlertIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { cn, randomHex } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { McpSignInLink } from "./mcp/McpSignInLink";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { resolveSelectableProvider } from "../providerModels";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { useClientSettings, useEnvironmentSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { resolveNewThreadModes } from "../hooks/useHandleNewThread.logic";
import {
  resolveAppModelSelectionForInstance,
  withNewThreadDefaultModel,
  withoutInheritedOutputStyle,
} from "../modelSelection";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  acceptComposerImageFiles,
  composerImageFileFromAttachment,
  compressComposerImageFiles,
} from "../composerImageAttachments";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  useEffectiveComposerModelState,
  DraftId,
} from "../composerDraftStore";
import {
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { type ElementContextDraft, formatElementContextLabel } from "../lib/elementContext";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { environmentCatalog } from "../connection/catalog";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { isAgentWorkingLeaseActive } from "./kanban/Kanban.logic";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { environmentThreads, threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  useProject,
  useProjects,
  useThread,
  useThreadProposedPlans,
  useThreadRefs,
  useThreadShell,
} from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { FindInThreadBar } from "./chat/FindInThreadBar";
import { findMatchesInThread } from "./chat/findInThread";
import {
  deriveUnsettledTurnId,
  isTimelineSettledAtEnd,
  resolveTimelineDistanceFromEnd,
  shouldSnapTimelineToEndAfterTurnSettle,
  TIMELINE_PROGRAMMATIC_SCROLL_WINDOW_MS,
  TIMELINE_SCROLL_SETTLE_MAX_WAIT_MS,
  TIMELINE_SCROLL_SETTLE_STABLE_FRAMES,
  type AgentModelContext,
} from "./chat/MessagesTimeline.logic";
import {
  composerTextForQuotedSelection,
  quotableSelectionText,
  runQuotedSelectionContextMenu,
} from "./chat/quotedSelection";
import { formatConversationTranscript, isSelectAllShortcut } from "./chat/conversationTranscript";
import { ChatHeader } from "./chat/ChatHeader";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./chat/PanelLayoutControls";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import {
  buildRestylePrompt,
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
  resolveOutputStyleChipState,
  resolveOutputStyleToSeed,
} from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { resolveThreadPr } from "./ThreadStatusIndicators";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { ThreadSyncStatusPill } from "./chat/ThreadSyncStatusPill";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_DURATION_MS,
  DRAFT_HERO_TRANSITION_EASING,
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildLoadingThreadFromShell,
  buildOutgoingTurnText,
  formatOutgoingPrompt,
  buildThreadTurnInterruptInput,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  getStartedThreadModelChangeBlockReason,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  readFileAsDataUrl,
  reconcileMountedTerminalThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldWriteThreadErrorToCurrentServerThread,
  startNewThreadForProject,
  buildTurnStartFailureReportPrompt,
  threadHasStarted,
  waitForStartedServerThread,
} from "./ChatView.logic";
import type { ThreadSyncPhase } from "../threadSync";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
} from "../versionSkew";
import { ServerUpdateAction } from "./ServerUpdateAction";
import { useAssetUrl, useAssetUrls } from "../assets/assetUrls";

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_THREAD_ACTIVITIES: ReadonlyArray<never> = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

/**
 * How long the MCP dialog's "Start session" waits for the session to go live.
 *
 * A session boot is a provider process starting and reporting in; on a cold
 * machine that is seconds, not instants, so the wait has to be generous. It
 * also has to end: a start that failed on the server arrives as nothing at
 * all, and a button that says "Starting…" until the dialog is closed is the
 * lying spinner this app does not ship.
 */
const MCP_SESSION_START_TIMEOUT_MS = 30_000;

const MCP_NO_SESSION_MESSAGE =
  "No active session right now (idle sessions are stopped to save resources).";

/**
 * A draft thread has no session because it has never had one, so the sentence
 * above — which explains that an idle session was stopped — is simply untrue
 * there, and it sits under a dialog with nothing to start.
 */
const MCP_DRAFT_NO_SESSION_MESSAGE =
  "This conversation has not started yet. Send the first message and its MCP servers will be listed here.";

const MCP_SESSION_START_FAILED_MESSAGE =
  "The session did not start. Check that this thread's provider is installed and its project folder still exists, then try again.";
function useDraftHeroLayoutTransition(isDraftHeroState: boolean) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const attachTransitionGroupRef = (element: HTMLDivElement | null) => {
    transitionGroupRef.current = element;
  };
  const attachComposerAnchorRef = (element: HTMLDivElement | null) => {
    composerAnchorRef.current = element;
  };
  const captureComposerRect = () => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  };

  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const mobileComposerTransitionActive =
      typeof document !== "undefined" &&
      document.documentElement.dataset.mobileComposerRouteTransition === "true";

    animationRef.current?.cancel();
    animationRef.current = null;

    const previousComposerRect = previousComposerRectRef.current;
    if (
      stateChanged &&
      !prefersReducedMotion &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: DRAFT_HERO_TRANSITION_DURATION_MS,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current !== animation) {
              return;
            }
            animationRef.current = null;
          });
      }
    }

    previousStateRef.current = isDraftHeroState;
    previousComposerRectRef.current = nextComposerRect;
  }, [isDraftHeroState]);

  return [attachTransitionGroupRef, attachComposerAnchorRef, captureComposerRect] as const;
}
const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("./DiffPanel"));
const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();
const EMPTY_FIND_MATCHES: ReturnType<typeof findMatchesInThread> = [];
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

/**
 * Whether the conversation is what the keyboard is currently addressing.
 *
 * Focus alone does not answer it: clicking a message leaves focus on `body`,
 * because rendered text is not focusable. The selection is the other half of
 * the answer — a caret placed by that click sits inside the transcript even
 * though nothing there is focused.
 */
function transcriptRegionAddressed(region: HTMLElement | null): boolean {
  if (!region) return false;
  if (region.contains(document.activeElement)) return true;
  const selection = window.getSelection();
  return selection !== null && region.contains(selection.anchorNode);
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;

  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;

  return true;
}

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      threadSyncPhase?: ThreadSyncPhase | null;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      threadSyncPhase?: never;
      routeKind: "draft";
      draftId: DraftId;
    };

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const latestUserMessageId =
    input.activeThread?.messages.findLast((message) => message.role === "user")?.id ?? null;

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        latestUserMessageId,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      latestUserMessageId,
      localDispatch,
    ],
  );
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        const active = serverAcknowledgedLocalDispatch ? null : current;
        if (active) {
          return active.preparingWorktree === preparingWorktree
            ? active
            : { ...active, preparingWorktree };
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [input.activeThread, serverAcknowledgedLocalDispatch],
  );

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
  };
}

/** Same terminal ids (order ignored) — avoids reconcile when only server session ordering differs. */
function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Server knows about fewer sessions than the client, but every server id still exists locally.
 * Typical right after `terminal.open`: known-session list lags; reconciling would drop the new id
 * and later re-add it as a separate group (no split layout).
 */
function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) {
    return false;
  }
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) {
      return false;
    }
  }
  return true;
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        panelSurfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [panelSurfaces],
  );
  const drawerTerminalSessions = useMemo(
    () =>
      knownTerminalSessions.filter((session) => !panelTerminalIds.has(session.target.terminalId)),
    [knownTerminalSessions, panelTerminalIds],
  );
  const terminalLabelsById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of drawerTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [drawerTerminalSessions]);
  const terminalLaunchLocationsById = useMemo(() => {
    const next = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    if (!project) {
      return next;
    }

    for (const session of drawerTerminalSessions) {
      const summary = session.state.summary;
      if (!summary) {
        continue;
      }
      const worktreePathForLaunch =
        launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
      next.set(session.target.terminalId, {
        cwd: launchContext?.cwd ?? summary.cwd,
        worktreePath: worktreePathForLaunch,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: worktreePathForLaunch,
        }),
      });
    }

    return next;
  }, [drawerTerminalSessions, launchContext, project]);
  const serverOrderedTerminalIds = useMemo(
    () => drawerTerminalSessions.map((session) => session.target.terminalId),
    [drawerTerminalSessions],
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  useEffect(() => {
    if (terminalIdListsEqual(serverOrderedTerminalIds, terminalUiState.terminalIds)) {
      return;
    }
    if (
      serverTerminalIdsStrictSubsetOfClient(serverOrderedTerminalIds, terminalUiState.terminalIds)
    ) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds, threadRef]);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeSplitTerminal,
    threadId,
    threadRef,
    openTerminal,
  ]);
  const splitTerminalVertical = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminalVertical(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    openTerminal,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeSplitTerminalVertical,
    threadId,
    threadRef,
  ]);

  const createNewTerminal = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeNewTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeNewTerminal,
    threadId,
    threadRef,
    openTerminal,
  ]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId: threadRef.environmentId,
          input: { threadId, terminalId, data: "exit\n" },
        });

      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: {
            threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      storeCloseTerminal,
      threadId,
      threadRef,
      closeTerminalMutation,
      writeTerminal,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !terminalUiState.terminalOpen || !cwd) {
    return null;
  }

  return (
    <div className={visible ? undefined : "hidden"}>
      <ThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        height={terminalUiState.terminalHeight}
        // Known-session order is MRU and changes on focus; persisted store order keeps sidebar labels stable.
        terminalIds={terminalUiState.terminalIds}
        activeTerminalId={terminalUiState.activeTerminalId}
        terminalGroups={terminalUiState.terminalGroups}
        activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onSplitTerminalVertical={splitTerminalVertical}
        onNewTerminal={createNewTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        splitVerticalShortcutLabel={visible ? splitVerticalShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        keybindings={keybindings}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
        terminalLabelsById={terminalLabelsById}
        terminalLaunchLocationsById={terminalLaunchLocationsById}
      />
    </div>
  );
});

interface PersistentThreadTerminalPanelProps {
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  threadRef,
  surface,
  launchContext,
  focusRequestId,
  keybindings,
  onAddTerminalContext,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions.find((session) => session.target.terminalId === surface.activeTerminalId)
      ?.state.summary ?? null;
  const worktreePath =
    launchContext?.worktreePath ?? activeSummary?.worktreePath ?? threadWorktreePath;
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      activeSummary?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : null),
    [activeSummary?.cwd, launchContext?.cwd, project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );
  const terminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      labels.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
    }
    return labels;
  }, [knownTerminalSessions, surface.terminalIds]);
  const terminalLaunchLocationsById = useMemo(() => {
    const locations = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      const terminalWorktreePath =
        launchContext?.worktreePath ?? summary?.worktreePath ?? threadWorktreePath;
      const terminalCwd =
        launchContext?.cwd ??
        summary?.cwd ??
        (project
          ? projectScriptCwd({
              project: { cwd: project.workspaceRoot },
              worktreePath: terminalWorktreePath,
            })
          : null);
      if (!terminalCwd || !project) continue;
      locations.set(terminalId, {
        cwd: terminalCwd,
        worktreePath: terminalWorktreePath,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: terminalWorktreePath,
        }),
      });
    }
    return locations;
  }, [
    knownTerminalSessions,
    launchContext?.cwd,
    launchContext?.worktreePath,
    project,
    surface.terminalIds,
    threadWorktreePath,
  ]);

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={[
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        },
      ]}
      activeTerminalGroupId={surface.id}
      focusRequestId={focusRequestId}
      onSplitTerminal={onSplitTerminal}
      onSplitTerminalVertical={onSplitTerminalVertical}
      onNewTerminal={onNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      splitVerticalShortcutLabel={splitVerticalShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Puts one image a message was sent with back into the rewind dialog.
 *
 * Renders nothing. Editing a message resends it, so the edit has to start from
 * the whole message, and the bytes for an image already sent are on the server:
 * reaching them means an asset URL, and an asset URL is a query that settles a
 * render or two later. Mounting one of these per attachment is what lets the
 * wait happen per image, off the path that opens the dialog.
 *
 * What it fetches goes to `onRestore`, which is the same call a dropped file
 * makes — so a restored image is capped, compressed and removable exactly like
 * one the user just picked.
 *
 * Once per mount, guarded: the URL is refreshed on a timer, and re-adding an
 * image the user has just removed would make the remove button a lie. Mount
 * these keyed on the selected message so switching rows starts a fresh set.
 */
function RewindMessageAttachment(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatImageAttachment;
  readonly onRestore: (files: ReadonlyArray<File>) => void;
}) {
  const { attachment, onRestore } = props;
  const url = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
  });
  const restoredRef = useRef(false);
  // Mounted for as long as this attachment is the selected message's. Switching
  // messages unmounts the whole set (they are keyed on the selection), and the
  // fetch below outlives that: without this, message A's screenshot landed on
  // message B's edit, and the slot it had already claimed was never given back.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on the way in as well as cleared on the way out: StrictMode mounts,
    // cleans up and mounts again in dev, and a flag only ever cleared stays
    // false for the rest of the component's life.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (url === null || restoredRef.current) return;
    restoredRef.current = true;
    void composerImageFileFromAttachment(url, attachment).then((file) => {
      if (mountedRef.current && file !== null) onRestore([file]);
    });
  }, [attachment, onRestore, url]);
  return null;
}

function ChatViewContent(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
  } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const threadSyncPhase = routeKind === "server" ? (props.threadSyncPhase ?? null) : null;
  const threadDetailLoading = threadSyncPhase === "loading";
  const handleNewThread = useNewThreadHandler();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const loadOlderThreadActivities = useAtomCommand(environmentThreads.loadOlderActivities, {
    reportFailure: false,
  });
  const getThreadMcpStatus = useAtomCommand(threadEnvironment.getMcpStatus, {
    reportFailure: false,
  });
  const runThreadMcpServerAction = useAtomCommand(threadEnvironment.mcpServerAction, {
    reportFailure: false,
  });
  const listThreadRewindTargets = useAtomCommand(threadEnvironment.listRewindTargets, {
    reportFailure: false,
  });
  const runThreadRewindFiles = useAtomCommand(threadEnvironment.rewindFiles, {
    reportFailure: false,
  });
  const runThreadRewindToInput = useAtomCommand(threadEnvironment.rewindToInput, {
    reportFailure: false,
  });

  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const startThreadSession = useAtomCommand(threadEnvironment.startSession, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const retryThreadTurn = useAtomCommand(threadEnvironment.retryTurn, { reportFailure: false });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const routeServerThreadShell = useThreadShell(routeKind === "server" ? routeThreadRef : null);
  const serverThread = useThread(routeThreadRef, { waitForShell: draftThread !== null });
  const loadingServerThread = useMemo(
    () =>
      threadDetailLoading && routeServerThreadShell
        ? buildLoadingThreadFromShell(routeServerThreadShell)
        : null,
    [routeServerThreadShell, threadDetailLoading],
  );
  const activeServerThread = serverThread ?? loadingServerThread;
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const setLastOpenedThread = useUiStateStore((store) => store.setLastOpenedThread);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[routeThreadKey],
  );
  const settings = useEnvironmentSettings(environmentId);
  // New-thread defaults live in the primary environment's settings.json (the
  // settings UI never writes to remote environments), so read them from the
  // primary server rather than the thread's environment.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar;
  const navigate = useNavigate();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftElementContexts = useComposerDraftStore(
    (store) => store.setElementContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const transcriptRegionRef = useRef<HTMLDivElement | null>(null);
  // Which thread is on screen *now*, readable from a callback that was built in
  // an earlier render. Comparing against the closed-over `routeThreadKey`
  // instead compares a render's value with itself, which is never not equal.
  const liveRouteThreadKeyRef = useRef(routeThreadKey);
  liveRouteThreadKeyRef.current = routeThreadKey;
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(composerOverlayElement.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setComposerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(composerOverlayElement);
    return () => observer.disconnect();
  }, [composerOverlayElement]);

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = useMemo(() => serverThreadRefs.map(scopedThreadKey), [serverThreadRefs]);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = activeServerThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!activeServerThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [activeServerThread, draftId, localDraftErrorsByDraftId, routeThreadKey]);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
            {
              runtimeMode: primaryServerSettings.defaultRuntimeMode,
              interactionMode: primaryServerSettings.defaultInteractionMode,
            },
          )
        : undefined,
    [
      draftThread,
      fallbackDraftProject?.defaultModelSelection,
      primaryServerSettings.defaultInteractionMode,
      primaryServerSettings.defaultRuntimeMode,
      threadId,
    ],
  );
  // Promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  const isServerThread = activeServerThread !== null;
  const activeThread = activeServerThread ?? localDraftThread;
  const threadError = isServerThread
    ? (localServerError ?? activeServerThread?.session?.lastError ?? null)
    : localDraftError;
  // Only the session's own error carries a classification; a local override
  // (e.g. "select a base branch...") is never auth-shaped.
  const threadErrorClass =
    isServerThread && !localServerError
      ? (activeServerThread?.session?.lastErrorClass ?? null)
      : null;
  // Nothing recorded on the thread yet means it is about to start as a new
  // one, so the configured new-thread defaults are what the composer shows.
  const runtimeMode =
    composerRuntimeMode ?? activeThread?.runtimeMode ?? primaryServerSettings.defaultRuntimeMode;
  const interactionMode =
    composerInteractionMode ??
    activeThread?.interactionMode ??
    primaryServerSettings.defaultInteractionMode;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  /**
   * Something is running under this thread, from either side of the fence.
   *
   * A terminal subprocess is the visible case — an orchestration script the
   * user started. The agent-ownership lease is the invisible one: work the
   * agent launched detached reparents away from every terminal, so the only
   * thing that knows is the lease the server holds while the thread's
   * background tasks are open. Both mean the same thing to a reader, so the
   * terminal control pulses for either.
   */
  const threadHasWorkRunning =
    runningTerminalIds.length > 0 ||
    (activeThread !== undefined &&
      activeThread !== null &&
      isAgentWorkingLeaseActive(activeThread));
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = useMemo(() => {
    if (activeThreadId === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  }, [activeThreadId, activeThreadKnownSessionsRaw]);
  const activeServerOrderedTerminalIds = useMemo(
    () => activeThreadKnownSessions.map((session) => session.target.terminalId),
    [activeThreadKnownSessions],
  );
  const activeKnownTerminalIds = useMemo(
    () => [...new Set([...activeServerOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [activeServerOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const activeTerminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  }, [activeThreadKnownSessions]);
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activeFileSurface =
    activeRightPanelSurface?.kind === "file" ? activeRightPanelSurface : null;
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        rightPanelState.surfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [rightPanelState.surfaces],
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && isPreviewSupportedInRuntime();
  const rightPanelOpen = rightPanelState.isOpen;
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized =
    canMaximizeRightPanel && maximizedRightPanelThreadKey === routeThreadKey;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;

  useEffect(() => {
    if (!activeThreadRef) return;
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(activeThreadRef, Object.keys(activePreviewState.sessions));
  }, [activePreviewState.sessions, activeThreadRef]);

  useEffect(() => {
    if (!activeThreadRef || !activePreviewMiniPlayer) return;
    const miniTabStillExists = Boolean(activePreviewState.sessions[activePreviewMiniPlayer.tabId]);
    const sameTabOpenInPanel =
      previewPanelOpen &&
      activeRightPanelSurface?.kind === "preview" &&
      activeRightPanelSurface.resourceId === activePreviewMiniPlayer.tabId;
    if (!miniTabStillExists || sameTabOpenInPanel) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [
    activePreviewMiniPlayer,
    activePreviewState.sessions,
    activeRightPanelSurface,
    activeThreadRef,
    previewPanelOpen,
  ]);

  const planSidebarOpen = activeRightPanelKind === "plan";

  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeRunningTurnId =
    activeThread?.session?.status === "running" ? activeThread.session.activeTurnId : null;
  const sourcePlanThreadRef = useMemo(() => {
    const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
    if (!activeThread || !sourceThreadId || sourceThreadId === activeThread.id) {
      return null;
    }
    return scopeThreadRef(activeThread.environmentId, sourceThreadId);
  }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread]);
  const sourceThreadProposedPlans = useThreadProposedPlans(sourcePlanThreadRef);
  const threadPlanCatalog = useMemo<ThreadPlanCatalogEntry[]>(() => {
    if (!activeThread) {
      return [];
    }
    const entries: ThreadPlanCatalogEntry[] = [
      { id: activeThread.id, proposedPlans: activeThread.proposedPlans },
    ];
    if (sourcePlanThreadRef) {
      entries.push({
        id: sourcePlanThreadRef.threadId,
        proposedPlans: sourceThreadProposedPlans,
      });
    }
    return entries;
  }, [activeThread, sourcePlanThreadRef, sourceThreadProposedPlans]);
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalUiState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalUiState.terminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useProject(activeProjectRef);
  const handleNewThreadInActiveProject = useCallback(() => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  }, [activeProjectRef, handleNewThread]);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = `file:${relativePath}`;
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeProjectKey],
  );
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProject?.scripts),
    [activeProject?.scripts],
  );

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const label = environmentById.get(p.environmentId)?.label ?? p.environmentId;
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [activeProject, allProjects, projectGroupingSettings, primaryEnvironmentId, environmentById]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        ...resolveNewThreadModes({
          carriedRuntimeMode: null,
          carriedInteractionMode: null,
        }),
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      primaryServerSettings,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  // Where a cold start comes back to. Recorded on the thread actually on
  // screen rather than derived from the visit map, whose values are thread
  // update times and would point at the newest thread rather than the last one
  // opened.
  useEffect(() => {
    if (!serverThread?.id) return;
    setLastOpenedThread(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
    );
  }, [serverThread?.environmentId, serverThread?.id, setLastOpenedThread]);

  useEffect(() => {
    if (!serverThread?.id) return;
    const threadUpdatedAt = Date.parse(serverThread.updatedAt);
    if (Number.isNaN(threadUpdatedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= threadUpdatedAt) return;

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      serverThread.updatedAt,
    );
  }, [
    activeThreadLastVisitedAt,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.updatedAt,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
  });
  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} server`
      : "server";
  const serverUpdateEnvironmentId = activeThread?.environmentId ?? null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    // Reconnecting to a version-skewed server usually means it is restarting
    // on a new build. Fold the reconnect and version banners into one calm
    // line instead of stacking "Failed to connect" on "versions differ".
    const reconnectingThroughVersionSkew = environmentReconnecting && versionMismatch !== null;
    if (activeEnvironmentUnavailableState && unavailableConnection) {
      if (reconnectingThroughVersionSkew) {
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: "default",
          icon: (
            <span
              className="size-1.5 animate-status-pulse rounded-full bg-foreground"
              aria-hidden="true"
            />
          ),
          title: `${unavailableConnection.phase === "connecting" ? "Connecting" : "Reconnecting"} to ${activeEnvironmentUnavailableState.label}`,
          description: "It may be finishing an update. One moment.",
        });
      } else {
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: unavailableConnection.phase === "error" ? "error" : "warning",
          icon: <WifiOffIcon />,
          title: `${activeEnvironmentUnavailableState.label}: ${connectionStatusTitle(unavailableConnection)}`,
          description:
            unavailableConnection.error ??
            "Reconnect this environment before sending messages or running actions.",
          actions: (
            <>
              <Button
                size="xs"
                disabled={environmentReconnecting}
                onClick={() =>
                  void handleReconnectActiveEnvironment(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                {environmentReconnecting ? "Reconnecting..." : "Reconnect"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/connections" })}
              >
                Connections
              </Button>
            </>
          ),
        });
      }
    }
    if (
      serverUpdateEnvironmentId &&
      !reconnectingThroughVersionSkew &&
      showVersionMismatchBanner &&
      versionMismatch &&
      versionMismatchDismissKey
    ) {
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Client and server versions differ",
        description: (
          <>
            Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{" "}
            {versionMismatch.serverVersion}.{" "}
            {serverUpdateGuidance(versionMismatchSelfUpdate, versionMismatchServerLabel)}
          </>
        ),
        // The desktop-managed guidance is already the description; the action
        // slot would only repeat it.
        ...(versionMismatchSelfUpdate === "desktop-managed"
          ? {}
          : {
              actions: (
                <ServerUpdateAction
                  environmentId={serverUpdateEnvironmentId}
                  serverLabel={versionMismatchServerLabel}
                  selfUpdate={versionMismatchSelfUpdate}
                  targetVersion={versionMismatch.clientVersion}
                />
              ),
            }),
        dismissLabel: "Dismiss version mismatch warning",
        onDismiss: () => {
          dismissVersionMismatch(versionMismatchDismissKey);
          setDismissedVersionMismatchKey(versionMismatchDismissKey);
        },
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    navigate,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    serverUpdateEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
  ]);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider,
  );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities]);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const planSidebarLabel = sidebarProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const isWorking = phase === "running" || isSendBusy || isConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages ?? []) {
      for (const attachment of message.attachments ?? []) {
        attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() => {
    if (!serverMessages) return [];
    return serverMessages.map((message) => {
      if (!message.attachments || message.attachments.length === 0) {
        return message;
      }
      return {
        ...message,
        attachments: message.attachments.map((attachment) => {
          const previewUrl = serverAttachmentUrlById.get(attachment.id);
          return previewUrl ? { ...attachment, previewUrl } : attachment;
        }),
      };
    });
  }, [serverAttachmentUrlById, serverMessages]);
  useEffect(() => {
    if (typeof Image === "undefined" || displayServerMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === "user")
        .map((message) => [String(message.id), message] as const),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages]);
  const timelineMessages = useMemo(() => {
    const messages = displayServerMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [attachmentPreviewHandoffByMessageId, displayServerMessages, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  // Read from callbacks that outlive the render they were built in — a menu
  // left open, a keystroke — so a conversation copy is never a stale one.
  const timelineEntriesRef = useRef(timelineEntries);
  timelineEntriesRef.current = timelineEntries;

  // Find in conversation. Null while the bar is closed, which is also what
  // clears every highlight — there is one way out and it is the same one.
  const [findState, setFindState] = useState<{
    readonly query: string;
    readonly activeIndex: number;
    /** Bumped on every press of the shortcut, to refocus an open bar. */
    readonly focusToken: number;
    /**
     * The conversation this search belongs to. Compared on read rather than
     * cleared by the effect below alone: the effect runs AFTER the first
     * render of the next thread, and that render would otherwise hand the old
     * query to the new thread's timeline, which unfolds a turn in it.
     */
    readonly threadKey: string | null;
  } | null>(null);
  const findQuery =
    findState === null || findState.threadKey !== routeThreadKey ? null : findState.query;
  const findMatches = useMemo(
    () =>
      findQuery === null ? EMPTY_FIND_MATCHES : findMatchesInThread(timelineEntries, findQuery),
    [findQuery, timelineEntries],
  );
  // A reply arriving mid-search can change the match list under the reader, so
  // the position is clamped at read time rather than trusted from state.
  const findActiveIndex =
    findMatches.length === 0 ? 0 : Math.min(findState?.activeIndex ?? 0, findMatches.length - 1);
  const activeFindMatch = findMatches[findActiveIndex];
  // Another conversation is another search. The bar closes with it, which is
  // also what drops its highlights.
  useEffect(() => {
    setFindState(null);
  }, [routeThreadKey]);
  const openFindInThread = useCallback(() => {
    setFindState((existing) =>
      existing === null
        ? { query: "", activeIndex: 0, focusToken: 1, threadKey: routeThreadKey }
        : { ...existing, focusToken: existing.focusToken + 1, threadKey: routeThreadKey },
    );
  }, [routeThreadKey]);
  const timelineFind = useMemo(
    () =>
      findQuery === null
        ? undefined
        : {
            query: findQuery,
            activeEntryId: activeFindMatch?.entryId ?? null,
            activeOccurrenceIndex: activeFindMatch?.occurrenceIndex ?? 0,
          },
    [activeFindMatch, findQuery],
  );
  const stepFindMatch = useCallback(
    (direction: 1 | -1) => {
      setFindState((existing) => {
        if (existing === null || findMatches.length === 0) return existing;
        const next = (findActiveIndex + direction + findMatches.length) % findMatches.length;
        return { ...existing, activeIndex: next };
      });
    },
    [findActiveIndex, findMatches.length],
  );
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState =
    isLocalDraftThread && timelineEntries.length === 0 && !isWorking && !draftHeroDockRequested;
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(isDraftHeroState);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const selectedProviderInstanceId =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)
      ?.instanceId ?? null;
  const activeProviderInstanceId =
    selectedProviderInstanceId ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);

  // What the subagent roster needs to name each delegation's model. A Task
  // call that names no model inherits the session's, so the thread's own
  // selection is what those agents are really running on — paired with the
  // driver behind that selection, because model aliases are per-driver.
  const threadModelSelection = activeThread?.modelSelection ?? null;
  const agentModelContext = useMemo<AgentModelContext>(
    () => ({
      inheritedModel: threadModelSelection?.model ?? null,
      driverKind:
        (threadModelSelection
          ? providerStatuses.find((status) => status.instanceId === threadModelSelection.instanceId)
              ?.driver
          : undefined) ?? selectedProvider,
    }),
    [threadModelSelection, providerStatuses, selectedProvider],
  );

  // Response style for the composer's chip. It rides the same per-thread
  // provider options the traits menu writes, resolved for the instance that
  // will actually run the turn, so the chip and the turn never disagree.
  const outputStyleInstanceId =
    activeProviderInstanceId ?? activeProviderStatus?.instanceId ?? null;
  const { modelOptions: outputStyleModelOptions, selectedModel: outputStyleModel } =
    useEffectiveComposerModelState({
      threadRef: composerDraftTarget,
      providers: providerStatuses,
      selectedProvider,
      selectedInstanceId: outputStyleInstanceId,
      threadModelSelection: activeThread?.modelSelection,
      // A started conversation resolves to the model it ran on, exactly as the
      // composer does. Without this the reading here fell to the tier default
      // for any started thread the draft store had no record of, and the
      // style-seeding effect below wrote that default into the draft as if
      // somebody had picked it — which is how a Fable conversation reopened on
      // Sonnet.
      threadHasStarted: threadHasStarted(activeThread),
      projectModelSelection: activeProject?.defaultModelSelection,
      settings,
    });
  const outputStyleOptions = outputStyleInstanceId
    ? outputStyleModelOptions?.[outputStyleInstanceId]
    : undefined;
  // One reading of the style this conversation has pinned, for both the chip
  // and the effect that seeds the default below. `getOutputStyleSelection`
  // answers `undefined` for "nobody picked one"; normalising it once here is
  // what stops the two from disagreeing about what "nothing picked" looks like.
  const pickedOutputStyle = getOutputStyleSelection(outputStyleOptions) ?? null;
  const preferredOutputStyle = settings.defaultOutputStyle;
  const outputStyleChip = useMemo(
    () =>
      resolveOutputStyleChipState({
        availableStyles: activeProviderStatus?.outputStyles,
        activeStyle: activeProviderStatus?.activeOutputStyle,
        pickedStyle: pickedOutputStyle,
        preferredStyle: preferredOutputStyle,
      }),
    [
      activeProviderStatus?.activeOutputStyle,
      activeProviderStatus?.outputStyles,
      pickedOutputStyle,
      preferredOutputStyle,
    ],
  );
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  // Start every conversation on the response style Settings → General has
  // configured (Caveman, unless the user set it to None).
  //
  // Written as a real selection rather than left implicit, because the chip's
  // label and the turn's `outputStyle` setting read from the same place — a
  // default that lived only in the label would show Caveman while the run used
  // whatever the CLI had configured.
  //
  // Guarded on "no selection at all", so it fires once per conversation and
  // never argues with somebody who chose otherwise. Picking None is itself a
  // selection, so moving away sticks for that thread.
  useEffect(() => {
    if (!outputStyleInstanceId || !outputStyleModel) return;
    const initial = resolveOutputStyleToSeed({
      pickedStyle: pickedOutputStyle,
      availableStyles: activeProviderStatus?.outputStyles,
      preferredStyle: preferredOutputStyle,
    });
    if (!initial) return;
    setProviderModelOptions(
      composerDraftTarget,
      selectedProvider,
      withOutputStyleSelection(outputStyleOptions, initial),
      {
        instanceId: outputStyleInstanceId,
        model: outputStyleModel,
        // Not sticky: this is the default every conversation returns to, not a
        // preference carried forward. Without this, moving away once would
        // make that the starting style for every later thread.
        persistSticky: false,
      },
    );
  }, [
    activeProviderStatus?.outputStyles,
    composerDraftTarget,
    outputStyleInstanceId,
    outputStyleModel,
    outputStyleOptions,
    pickedOutputStyle,
    preferredOutputStyle,
    selectedProvider,
    setProviderModelOptions,
  ]);

  const onOutputStyleChange = useCallback(
    (outputStyle: string) => {
      if (!outputStyleInstanceId) return;
      setProviderModelOptions(
        composerDraftTarget,
        selectedProvider,
        withOutputStyleSelection(outputStyleOptions, outputStyle),
        {
          instanceId: outputStyleInstanceId,
          model: outputStyleModel,
          // Per-conversation, like the default it replaces. Sticky would mean
          // one switch away from Caveman silently became the starting style for
          // every thread after it.
          persistSticky: false,
        },
      );
    },
    [
      composerDraftTarget,
      outputStyleInstanceId,
      outputStyleModel,
      outputStyleOptions,
      selectedProvider,
      setProviderModelOptions,
    ],
  );

  /**
   * Redo the newest reply under the style now selected, as a NEW turn further
   * down the conversation. Nothing is rewound and nothing already said is
   * edited — the thread simply continues with a rewrite request.
   *
   * The style rides this turn's own `modelSelection`, so the server pushes it
   * into the running session before the prompt is queued. That is what makes
   * the rewrite come back in the new style rather than one turn late.
   *
   * The composer draft is deliberately untouched: this sends its own message,
   * so anything half-typed stays exactly where it was.
   */
  const onRedoLastReplyInStyle = useCallback(() => {
    const outputStyle = outputStyleChip?.selectedStyle;
    if (!activeThread || !outputStyle || !outputStyleInstanceId) return;
    const modelSelection = {
      ...activeThread.modelSelection,
      instanceId: outputStyleInstanceId,
      ...(outputStyleModel ? { model: outputStyleModel } : {}),
      options: withOutputStyleSelection(outputStyleOptions, outputStyle) ?? [],
    };
    void startThreadTurn({
      environmentId,
      input: {
        threadId: activeThread.id,
        message: {
          messageId: newMessageId(),
          role: "user" as const,
          text: buildRestylePrompt(outputStyle),
          attachments: [],
        },
        modelSelection,
        titleSeed: activeThread.title,
        runtimeMode,
        interactionMode,
        createdAt: new Date().toISOString(),
      },
    });
  }, [
    activeThread,
    environmentId,
    interactionMode,
    outputStyleChip?.selectedStyle,
    outputStyleInstanceId,
    outputStyleModel,
    outputStyleOptions,
    runtimeMode,
    startThreadTurn,
  ]);

  // The read-aloud control only exists when the server this thread runs on
  // actually has a speech engine installed.
  const speechAvailable = activeEnvironment?.serverConfig?.environment.capabilities.speech === true;

  // Offered only when there IS a newest reply to redo and the thread is idle.
  // A completed latest turn is the signal: mid-turn there is no finished reply
  // to rewrite, and sending during one would queue a rewrite of something the
  // model has not said yet.
  const canRedoLastReplyInStyle = Boolean(
    activeThread &&
    outputStyleChip?.selectedStyle &&
    outputStyleInstanceId &&
    activeThread.latestTurn?.completedAt &&
    !isWorking,
  );

  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(threadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  // The strip used to be purely git (branch picker plus the workspace chip),
  // so a project outside version control had nothing to put in it. The
  // response-style chip has no git dimension at all, so the strip now also
  // opens for a non-git project — otherwise the only way to change the style
  // is to be lucky enough to have the project under git.
  const showComposerContextStrip =
    activeProject !== null && (isGitRepo || outputStyleChip !== null);
  const initialDiffPanelGitScope =
    gitStatusQuery.data?.hasWorkingTreeChanges === true ? "unstaged" : "branch";
  const diffPanelGitStatusResolutionKey = gitStatusQuery.data ? "resolved" : "pending";
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
      },
    }),
    [terminalUiState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  }, [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "stopped")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        shouldWriteThreadErrorToCurrentServerThread({
          activeServerThread,
          routeThreadRef,
          targetThreadId,
        })
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [activeServerThread, draftId, routeThreadKey, routeThreadRef],
  );

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      composerRef.current?.addTerminalContext(selection);
    },
    [composerRef],
  );
  const quoteTranscriptFragment = useCallback(
    (fragment: string, quotedFromThreadKey: string) => {
      // The menu is modal but not instantaneous, and the composer handle is
      // shared across threads: a quote taken from one conversation must not
      // land in whichever one is open by the time the menu closes.
      if (quotedFromThreadKey !== liveRouteThreadKeyRef.current) return;
      const composer = composerRef.current;
      if (!composer) return;
      const text = composerTextForQuotedSelection(fragment);
      // Guards the toast below, not the insert: an empty string is a rejected
      // insert, and reporting "the composer is busy" for it would be a lie.
      if (text.length === 0) return;
      if (!composer.insertTextAtEnd(text, { ensureLeadingBoundary: "line" })) {
        // A rejected insert means the composer is mid-approval, connecting, or
        // waiting on plan input. Saying so beats a menu entry that appears to
        // work and leaves the prompt untouched.
        toastManager.add({
          type: "error",
          title: "Unable to quote into the chat",
          description: "The composer is busy; try again once it is ready.",
        });
      }
      // No focus call here: the insert already schedules one for the next frame
      // (`applyPromptReplacement`), and a second would only re-focus what is
      // about to be focused.
    },
    [composerRef, routeThreadKey],
  );
  const copyEntireConversation = useCallback(async () => {
    const transcript = formatConversationTranscript(timelineEntriesRef.current);
    if (transcript.length === 0) {
      toastManager.add({
        type: "error",
        title: "Nothing to copy yet",
        description: "This conversation has no messages.",
      });
      return;
    }
    await writeTextToClipboard(transcript, "conversation");
    toastManager.add({
      type: "success",
      title: "Conversation copied",
      // The count is the point: it is what tells the reader this went past the
      // messages they could see.
      description: `${timelineEntriesRef.current.length} entries copied to the clipboard.`,
    });
  }, [timelineEntriesRef]);
  const onTranscriptContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // Images and links carry platform menu entries of their own — Copy Image,
      // Copy Link — that this menu does not replace, so they keep theirs.
      if (event.target instanceof Element && event.target.closest("a, img, video, canvas")) {
        return;
      }
      const selection = window.getSelection();
      // The transcript's own copy pipeline: the markdown ⌘C would have put on
      // the clipboard, links and code fences intact. Captured once, here, while
      // the selection is certain to still exist.
      const payload = selection ? chatMarkdownClipboardPayload(selection) : null;
      const fragment = quotableSelectionText(
        selection,
        transcriptRegionRef.current,
        () => payload?.text ?? null,
      );
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      const quotedFromThreadKey = routeThreadKey;
      void runQuotedSelectionContextMenu({
        // Null is a real state here, not a bail-out: with nothing selected the
        // menu still offers the whole conversation.
        fragment,
        position: { x: event.clientX, y: event.clientY },
        showContextMenu: (items, position) => api.contextMenu.show(items, position),
        quote: (text) => quoteTranscriptFragment(text, quotedFromThreadKey),
        // Copies what was selected at right-click time, in both flavours the
        // keyboard copy produces — not whatever the DOM selection has become by
        // the time the menu closes.
        copy: (text) =>
          writeSelectionToClipboard({ text, ...(payload?.html ? { html: payload.html } : {}) }),
        copyConversation: copyEntireConversation,
        reportFailure: (operation, cause) => {
          toastManager.add({
            type: "error",
            title:
              operation === "copy"
                ? "Could not copy the selection"
                : operation === "quote"
                  ? "Could not quote that"
                  : operation === "copy-conversation"
                    ? "Could not copy the conversation"
                    : "Could not open the selection menu",
            description: cause instanceof Error ? cause.message : String(cause),
          });
        },
      });
    },
    [copyEntireConversation, quoteTranscriptFragment, routeThreadKey],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (nextOpen && terminalUiState.terminalIds.length === 0) {
      if (!activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
      storeEnsureTerminal(activeThreadRef, terminalId, { open: true });
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
      return;
    }
    setTerminalOpen(nextOpen);
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    openTerminal,
    panelTerminalIds,
    setTerminalOpen,
    storeEnsureTerminal,
    terminalUiState.terminalIds.length,
    terminalUiState.terminalOpen,
  ]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (!activeThreadRef || hasReachedSplitLimit || !activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId(activeKnownTerminalIds);
      if (direction === "vertical") {
        storeSplitTerminalVertical(activeThreadRef, terminalId);
      } else {
        storeSplitTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeKnownTerminalIds,
      activeThreadId,
      activeThreadRef,
      openTerminal,
      activeThreadWorktreePath,
      environmentId,
      gitCwd,
      hasReachedSplitLimit,
      storeSplitTerminal,
      storeSplitTerminalVertical,
    ],
  );
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) {
      return;
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
    if (!cwdForOpen) {
      return;
    }
    const terminalId = nextTerminalId(activeKnownTerminalIds);
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeKnownTerminalIds,
    activeThreadId,
    activeThreadRef,
    openTerminal,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    storeNewTerminal,
  ]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !activeThreadRef) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: "exit\n" },
        });
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();
      storeCloseTerminal(activeThreadRef, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId(activeKnownTerminalIds)
        : baseTerminalId;
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }

      const openResult = await openTerminal({ environmentId, input: openTerminalInput });
      if (openResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
        return;
      }

      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure" && !isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminal,
      activeKnownTerminalIds,
      runningTerminalIds,
      terminalUiState.activeTerminalId,
      writeTerminal,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ReadonlyArray<ProjectScript>;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }): Promise<AtomCommandResult<void, unknown>> => {
      const updateResult = mapAtomCommandResult(
        await updateProject({
          environmentId,
          input: {
            projectId: input.projectId,
            scripts: input.nextScripts,
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        );
      }
      return updateResult;
    },
    [environmentId, updateProject, upsertKeybinding],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript = buildProjectScript(nextId, input);
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
      }

      const updatedScript = buildProjectScript(existingScript.id, input);
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      const result = await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return result;
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const dismissPlanSidebarForCurrentTurn = useCallback(() => {
    planSidebarDismissedForTurnRef.current =
      activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId]);
  const togglePlanSidebar = useCallback(() => {
    if (!activeThreadRef) return;
    if (planSidebarOpen) {
      dismissPlanSidebarForCurrentTurn();
    } else {
      planSidebarDismissedForTurnRef.current = null;
    }
    useRightPanelStore.getState().toggle(activeThreadRef, "plan");
  }, [activeThreadRef, dismissPlanSidebarForCurrentTurn, planSidebarOpen]);
  const closePlanSidebar = useCallback(() => {
    if (!activeThreadRef) return;
    setMaximizedRightPanelThreadKey(null);
    useRightPanelStore.getState().close(activeThreadRef);
    dismissPlanSidebarForCurrentTurn();
  }, [activeThreadRef, dismissPlanSidebarForCurrentTurn]);
  const createBrowserSurface = useCallback(() => {
    if (!activeThreadRef) return;
    void addBrowserSurface({ threadRef: activeThreadRef, openPreview });
  }, [activeThreadRef, openPreview]);
  const addDiffSurface = useCallback(() => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    if (planSidebarOpen) {
      dismissPlanSidebarForCurrentTurn();
    }
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  }, [
    activeThreadRef,
    dismissPlanSidebarForCurrentTurn,
    isGitRepo,
    isServerThread,
    onDiffPanelOpen,
    planSidebarOpen,
  ]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeProject, activeThreadRef]);
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadRef || !activeProject) return;
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
    },
    [activeProject, activeThreadRef],
  );
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      useRightPanelStore.getState().close(activeThreadRef);
      return;
    }
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [activePreviewState.activeTabId, activeThreadRef, createBrowserSurface, previewPanelOpen]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadRef) {
      setMaximizedRightPanelThreadKey(null);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  }, [activeThreadRef]);
  const addTerminalSurface = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) return;
    const cwd = gitCwd ?? activeProject.workspaceRoot;
    const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
    useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    gitCwd,
    openTerminal,
    panelTerminalIds,
  ]);
  const splitPanelTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !activeThreadRef ||
        !activeThreadId ||
        !activeProject ||
        activeRightPanelSurface?.kind !== "terminal" ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
      const cwd = gitCwd ?? activeProject.workspaceRoot;
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId, direction);
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeKnownTerminalIds,
      activeProject,
      activeRightPanelSurface,
      activeThreadId,
      activeThreadRef,
      activeThreadWorktreePath,
      gitCwd,
      openTerminal,
      panelTerminalIds,
    ],
  );
  const splitPanelTerminalVertical = useCallback(() => {
    splitPanelTerminal("vertical");
  }, [splitPanelTerminal]);
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(activeThreadRef, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef, closeTerminalMutation, storeCloseTerminal],
  );
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      if (surface.kind === "plan") {
        planSidebarDismissedForTurnRef.current = null;
      } else if (planSidebarOpen) {
        dismissPlanSidebarForCurrentTurn();
      }
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
    },
    [activeThreadRef, diffOpen, dismissPlanSidebarForCurrentTurn, onDiffPanelOpen, planSidebarOpen],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      if (planSidebarOpen) {
        closePlanSidebar();
      } else {
        closePreviewPanel();
      }
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePlanSidebar, closePreviewPanel, planSidebarOpen, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey]);
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      if (surfaces.some((surface) => surface.kind === "plan")) {
        dismissPlanSidebarForCurrentTurn();
      }

      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activeThreadRef,
      activePreviewState.sessions,
      closePreview,
      closeTerminalMutation,
      dismissPlanSidebarForCurrentTurn,
      storeCloseTerminal,
    ],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces([surface]);
      useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeOtherSurfaces(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeSurfacesToRight(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    cleanupRightPanelSurfaces(rightPanelState.surfaces);
    useRightPanelStore.getState().closeAllSurfaces(activeThreadRef);
  }, [activeThreadRef, cleanupRightPanelSurfaces, rightPanelState.surfaces]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      branch?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (!serverThread) {
        return AsyncResult.success(undefined);
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
        currentBranch: serverThread.branch,
        ...(input.branch ? { nextBranch: input.branch } : {}),
      });
      if (metadataUpdate) {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: input.interactionMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
      }
      return result;
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  // LegendList keeps its own "am I at the end" heuristic and pins the list on
  // every layout while it holds. Rendering it from the mode makes this one
  // decision instead of two: the list stops pinning the moment the reader
  // scrolls away, and resumes when they come back to the edge.
  const [followTimelineEnd, setFollowTimelineEnd] = useState(true);
  const setTimelineScrollMode = useCallback((mode: TimelineScrollMode) => {
    timelineScrollModeRef.current = mode;
    setFollowTimelineEnd(mode === "following-end");
  }, []);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  // The reader's distance from the end as of the last scroll or timeline
  // change, and which turn is still unsettled — together they answer "was the
  // reader watching the turn that just folded" without measuring after the
  // fold has already moved them.
  const timelineDistanceFromEndRef = useRef<number | null>(null);
  const unsettledTurnIdRef = useRef<TurnId | null>(null);
  // Until when a scroll event is this view's own doing — a scroll-to-end after
  // a send, a settle, the pill — rather than a jump for the timeline's
  // reading-anchor guard to undo.
  const programmaticTimelineScrollUntilRef = useRef(0);
  const expectProgrammaticTimelineScroll = useCallback(() => {
    programmaticTimelineScrollUntilRef.current =
      Date.now() + TIMELINE_PROGRAMMATIC_SCROLL_WINDOW_MS;
  }, []);
  const isProgrammaticTimelineScrollExpected = useCallback(
    () => Date.now() < programmaticTimelineScrollUntilRef.current,
    [],
  );
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1;
    setTimelineScrollMode("free-scrolling");
    liveFollowUserScrollGenerationRef.current = null;
  }, []);
  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || state.data.length === 0) {
        return false;
      }

      const lastRowIndex = state.data.length - 1;
      const lastRowTop = state.positionAtIndex(lastRowIndex);
      const lastRowHeight = state.sizeAtIndex(lastRowIndex);
      if (
        typeof lastRowTop !== "number" ||
        typeof lastRowHeight !== "number" ||
        !Number.isFinite(lastRowTop) ||
        !Number.isFinite(lastRowHeight)
      ) {
        return false;
      }

      const realContentBottom = lastRowTop + Math.max(1, lastRowHeight);
      const visibleScrollLength = Math.max(
        0,
        (state.scrollLength ?? 0) - composerOverlayHeight - CHAT_LIST_ANCHOR_OFFSET,
      );
      return realContentBottom > visibleScrollLength;
    },
    [composerOverlayHeight],
  );

  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  //
  // One jump is not enough: the list is virtualised and jumps to where it
  // estimates the end to be, and every unmeasured row that renders taller
  // than its estimate moves the real end further down after the jump has
  // landed — which is how the pill "pushed you down" on a long thread and
  // stopped short. So the jump is re-issued every frame until the measured
  // distance to the end has held at zero for a few frames, or the budget
  // runs out. A reader scrolling meanwhile bumps the generation and ends it.
  const settleTimelineAtEndFrameRef = useRef<number | null>(null);
  const cancelTimelineSettle = useCallback(() => {
    if (settleTimelineAtEndFrameRef.current !== null) {
      cancelAnimationFrame(settleTimelineAtEndFrameRef.current);
      settleTimelineAtEndFrameRef.current = null;
    }
  }, []);
  useEffect(() => cancelTimelineSettle, [cancelTimelineSettle]);
  const scrollToEnd = useCallback(() => {
    isAtEndRef.current = true;
    setTimelineScrollMode("following-end");
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    cancelTimelineSettle();
    const generation = anchorUserScrollGenerationRef.current;
    const startedAt = Date.now();
    let stableFrames = 0;
    const step = () => {
      settleTimelineAtEndFrameRef.current = null;
      const list = legendListRef.current;
      if (!list || anchorUserScrollGenerationRef.current !== generation) {
        return;
      }
      if (isTimelineSettledAtEnd(list.getState())) {
        stableFrames += 1;
        if (stableFrames >= TIMELINE_SCROLL_SETTLE_STABLE_FRAMES) {
          return;
        }
      } else {
        stableFrames = 0;
        expectProgrammaticTimelineScroll();
        void list.scrollToEnd?.({ animated: false });
      }
      if (Date.now() - startedAt < TIMELINE_SCROLL_SETTLE_MAX_WAIT_MS) {
        settleTimelineAtEndFrameRef.current = requestAnimationFrame(step);
      }
    };
    step();
  }, [cancelTimelineSettle, expectProgrammaticTimelineScroll]);
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    timelineDistanceFromEndRef.current = resolveTimelineDistanceFromEnd(
      legendListRef.current?.getState(),
    );
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      setTimelineScrollMode("following-end");
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      setTimelineScrollMode("free-scrolling");
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  // Older activities exist beyond the loaded window: nearing the top pages
  // the next window in. Prepended rows hold the reader in place through the
  // list's maintainVisibleContentPosition, so follow-end state is untouched.
  const pagingEnvironmentId = activeThread?.environmentId ?? null;
  const pagingThreadId = activeThread?.id ?? null;
  const onTimelineStartReached = useCallback(() => {
    if (pagingEnvironmentId === null || pagingThreadId === null) {
      return;
    }
    void loadOlderThreadActivities({
      environmentId: pagingEnvironmentId,
      input: { threadId: pagingThreadId },
    });
  }, [loadOlderThreadActivities, pagingEnvironmentId, pagingThreadId]);

  useEffect(() => {
    if (!activeThread?.id) {
      return;
    }

    // The settle edge: the turn that was streaming has folded its work rows
    // away. A reader who was near the end but not following — a click had
    // paused follow, or they sat a few hundred pixels up watching the stream —
    // was looking at rows that no longer exist, and with every visible row
    // deleted the list has no anchor to compensate with, so the view lands
    // screenfuls back. Their reading position before the fold decides it: the
    // distance sampled on the previous pass, not the one measured after the
    // collapse already moved them.
    const unsettledTurnId = deriveUnsettledTurnId(activeLatestTurn, activeRunningTurnId);
    const previousUnsettledTurnId = unsettledTurnIdRef.current;
    unsettledTurnIdRef.current = unsettledTurnId;
    const turnJustSettled = previousUnsettledTurnId !== null && unsettledTurnId === null;
    const distanceBeforeThisChange = timelineDistanceFromEndRef.current;
    timelineDistanceFromEndRef.current = resolveTimelineDistanceFromEnd(
      legendListRef.current?.getState(),
    );

    const following =
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current;
    if (!following) {
      if (
        !turnJustSettled ||
        !shouldSnapTimelineToEndAfterTurnSettle({
          distanceFromEnd: distanceBeforeThisChange,
          scrollLength: legendListRef.current?.getState().scrollLength,
        })
      ) {
        return;
      }
      // Re-engages live-follow; the frames below re-pin once the folded
      // layout has actually landed.
      scrollToEnd();
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          return;
        }

        if (timelineScrollModeRef.current !== "following-end") {
          return;
        }
        if (!timelineRealContentOverflowsViewport(list)) {
          return;
        }

        expectProgrammaticTimelineScroll();
        void list.scrollToEnd?.({ animated: false });
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    activeThread?.id,
    activeLatestTurn,
    activeRunningTurnId,
    timelineEntries,
    timelineRealContentOverflowsViewport,
    scrollToEnd,
    expectProgrammaticTimelineScroll,
  ]);

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    setTimelineScrollMode("following-end");
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      if (activeThreadRef) {
        useRightPanelStore.getState().open(activeThreadRef, "plan");
      }
    }
    planSidebarDismissedForTurnRef.current = null;
    // activeThreadRef resets transitively with the active thread.
  }, [activeThread?.id]);

  // Auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  useEffect(() => {
    if (!autoOpenPlanSidebar) return;
    if (!activePlan) return;
    if (planSidebarOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && activePlan.turnId !== latestTurnId) return;
    const turnKey = activePlan.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
    if (planSidebarDismissedForTurnRef.current === turnKey) return;
    if (activeThreadRef) {
      useRightPanelStore.getState().open(activeThreadRef, "plan");
    }
  }, [
    activePlan,
    activeLatestTurn?.turnId,
    activeThreadRef,
    autoOpenPlanSidebar,
    planSidebarOpen,
    sidebarProposedPlan?.turnId,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        primaryServerSettings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  // Settled state of the open thread, resolved exactly like the sidebar
  // partition (same shell, same capability gate, same PR auto-settle input)
  // so the banner and the sidebar row never disagree.
  const activeThreadShell = useThreadShell(isServerThread ? activeThreadRef : null);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const activeThreadPr = resolveThreadPr({
    threadBranch: activeThread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
  });
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const nowMinute = useNowMinute();
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: new Date().toISOString() });
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    void snoozeWakeTick;
    if (!activeThreadSnoozed) return;
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick]);
  const activeThreadSettled = useMemo(() => {
    if (activeThreadShell === null || !supportsSettlement) return false;
    return effectiveSettled(activeThreadShell, {
      now: `${nowMinute}:00.000Z`,
      autoSettleAfterDays,
      changeRequestState: activeThreadPr?.state ?? null,
    });
  }, [
    activeThreadPr?.state,
    activeThreadShell,
    autoSettleAfterDays,
    nowMinute,
    supportsSettlement,
  ]);
  const unsettleThreadMutation = useAtomCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  // Keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    try {
      const result = await unsettleThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsettleThreadMutation]);
  const unsnoozeThreadMutation = useAtomCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = useCallback(async () => {
    if (!activeThreadRef) return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    try {
      const result = await unsnoozeThreadMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, reason: "user" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
    }
  }, [activeThreadRef, unsnoozeThreadMutation]);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Native /mcp view. The status is read over the provider CLI's local
  // control channel — no model request, no token cost. Before this existed,
  // a typed /mcp went to the model as literal prompt text: a paid turn that
  // could only talk about the command.
  const [mcpStatusDialog, setMcpStatusDialog] = useState<
    | { readonly kind: "loading" }
    | {
        readonly kind: "loaded";
        readonly target: { environmentId: EnvironmentId; threadId: ThreadId };
        readonly servers: ReadonlyArray<ProviderMcpServerStatus>;
        /** `${serverName}:${action}` while an action is in flight. */
        readonly busy: string | null;
        /** Outcome line from the latest action (success or failure). */
        readonly notice: string | null;
        /**
         * The sign-in URL the CLI printed, when the latest action started one.
         * Shown with a copy control so a long consent URL (Google Calendar's
         * carries twelve scopes, ~1.2 KB) always reaches the browser even when
         * the OS "open link" call truncates it. Null when no sign-in is pending.
         */
        readonly signInUrl: string | null;
      }
    | {
        readonly kind: "error";
        readonly message: string;
        readonly reason: "no-session" | "unsupported" | "failed";
        readonly target: { environmentId: EnvironmentId; threadId: ThreadId };
      }
    | null
  >(null);
  const openMcpStatusDialog = useCallback(
    async (target: { environmentId: EnvironmentId; threadId: ThreadId }) => {
      setMcpStatusDialog({ kind: "loading" });
      const result = await getThreadMcpStatus({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result) as Partial<{
          reason: string;
          detail: string;
        }> | null;
        // The most common failure is benign: CH3 stops idle provider
        // sessions, and the status control needs a live one. The "Start
        // session" button below (no-session reason only) offers the way out.
        const reason: "no-session" | "unsupported" | "failed" =
          error?.reason === "no-session"
            ? "no-session"
            : error?.reason === "unsupported"
              ? "unsupported"
              : "failed";
        const message =
          reason === "no-session"
            ? isServerThread
              ? MCP_NO_SESSION_MESSAGE
              : MCP_DRAFT_NO_SESSION_MESSAGE
            : reason === "unsupported"
              ? "This thread's provider does not report MCP server status."
              : error?.detail && error.detail.length > 0
                ? error.detail
                : "Could not read MCP status.";
        setMcpStatusDialog({ kind: "error", message, reason, target });
        return;
      }
      setMcpStatusDialog({
        kind: "loaded",
        target,
        servers: result.value.servers,
        busy: null,
        notice: null,
        signInUrl: null,
      });
    },
    [getThreadMcpStatus, isServerThread],
  );
  // Set while the "Start session" button's dispatched command is in flight
  // and while waiting for the session to actually go live (see the effect
  // below) — not just for the command to be acknowledged.
  const [startingMcpSession, setStartingMcpSession] = useState(false);
  const handleStartMcpSession = useCallback(async () => {
    if (mcpStatusDialog?.kind !== "error" || mcpStatusDialog.reason !== "no-session") {
      return;
    }
    const target = mcpStatusDialog.target;
    setStartingMcpSession(true);
    // Clear a previous attempt's failure before this one runs. Without it the
    // dialog reads "The session did not start." underneath a button that says
    // "Starting…" — the retry contradicting itself.
    setMcpStatusDialog((current) =>
      current?.kind === "error" &&
      current.reason === "no-session" &&
      current.target.threadId === target.threadId
        ? { ...current, message: MCP_NO_SESSION_MESSAGE }
        : current,
    );
    const result = await startThreadSession({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Failure") {
      setStartingMcpSession(false);
      // `reportFailure: false` means nothing else says this failed. Without
      // this the button snaps back to "Start session" and the dialog still
      // reads "No active session", which is a control that reports nothing
      // at all for a command the server refused.
      setMcpStatusDialog((current) =>
        current?.kind === "error" &&
        current.reason === "no-session" &&
        current.target.threadId === target.threadId
          ? { ...current, message: MCP_SESSION_START_FAILED_MESSAGE }
          : current,
      );
    }
    // On success, the effect below watches the thread's projected session
    // status and refreshes the dialog once it's actually live — this app has
    // no imperative "wait for session" primitive, liveness is reactive.
  }, [mcpStatusDialog, startThreadSession]);
  useEffect(() => {
    if (!startingMcpSession || mcpStatusDialog?.kind !== "error") {
      return;
    }
    if (activeThread?.id !== mcpStatusDialog.target.threadId) {
      return;
    }
    const status = activeThread.session?.status;
    if (status === undefined || status === "starting" || status === "stopped") {
      return;
    }
    setStartingMcpSession(false);
    void openMcpStatusDialog(mcpStatusDialog.target);
  }, [startingMcpSession, mcpStatusDialog, activeThread, openMcpStatusDialog]);
  // A start that never lands must not leave the button saying "Starting…"
  // forever. `ensureSessionForThread` can fail on the server — a provider
  // binary that is gone, a project folder that moved — and that failure
  // reaches the client as the *absence* of a `thread.session-set`, which the
  // effect above cannot tell apart from a slow boot. So the wait is bounded,
  // and the way out is the same button: the reason stays `no-session`, so it
  // comes back enabled and reads "Start session" for a second try.
  //
  // Pinned to the thread the wait was armed for: the dialog can be reopened on
  // another thread without closing, and a timer from the first must not stamp
  // its failure onto the second.
  const startingMcpSessionFor =
    startingMcpSession && mcpStatusDialog?.kind === "error"
      ? mcpStatusDialog.target.threadId
      : null;
  useEffect(() => {
    if (startingMcpSessionFor === null) {
      return;
    }
    const timer = setTimeout(() => {
      setStartingMcpSession(false);
      setMcpStatusDialog((current) =>
        current?.kind === "error" &&
        current.reason === "no-session" &&
        current.target.threadId === startingMcpSessionFor
          ? { ...current, message: MCP_SESSION_START_FAILED_MESSAGE }
          : current,
      );
    }, MCP_SESSION_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [startingMcpSessionFor]);
  // One server's tool list expanded at a time (the "View tools" toggle).
  const [mcpToolsExpandedFor, setMcpToolsExpandedFor] = useState<string | null>(null);
  const runMcpDialogAction = useCallback(
    async (serverName: string, action: ProviderMcpServerAction) => {
      const dialog = mcpStatusDialog;
      if (dialog?.kind !== "loaded" || dialog.busy !== null) {
        return;
      }
      setMcpStatusDialog({
        ...dialog,
        busy: `${serverName}:${action}`,
        notice: null,
        signInUrl: null,
      });
      const result = await runThreadMcpServerAction({
        environmentId: dialog.target.environmentId,
        input: { threadId: dialog.target.threadId, serverName, action },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result) as Partial<{ detail: string }> | null;
        setMcpStatusDialog({
          ...dialog,
          busy: null,
          signInUrl: null,
          notice:
            error?.detail && error.detail.length > 0
              ? error.detail
              : `Could not ${action} "${serverName}".`,
        });
        return;
      }
      const authUrl = result.value.authUrl ?? null;
      if (authUrl) {
        // Best effort: hand the URL to the OS to open. This is NOT the reliable
        // path — macOS truncates a URL past ~1 KB here, which silently mangled
        // Google Calendar's twelve-scope consent link into an invalid_scope
        // error. The copy control rendered below is the reliable path; the URL
        // is shown regardless of whether this open succeeds.
        const localApi = readLocalApi();
        if (localApi) {
          void localApi.shell.openExternal(authUrl);
        } else {
          window.open(authUrl, "_blank", "noopener");
        }
      }
      setMcpStatusDialog({
        ...dialog,
        servers: result.value.servers,
        busy: null,
        signInUrl: authUrl,
        notice: authUrl
          ? `Sign-in opened for "${serverName}". If no browser tab appeared, copy the link below and open it yourself, then Re-check.`
          : action === "reconnect"
            ? `Reconnected "${serverName}".`
            : action === "authenticate"
              ? `Authentication finished for "${serverName}".`
              : action === "clear-auth"
                ? `Cleared authentication for "${serverName}". Authenticate to sign in again.`
                : `Server "${serverName}" ${action}d.`,
      });
    },
    [mcpStatusDialog, runThreadMcpServerAction],
  );

  // Set right after onSend is defined below; the rewind flow resubmits
  // through it and is declared earlier in this component.
  const onSendRef = useRef<
    | ((
        event?: { preventDefault: () => void },
        options?: { readonly modelOverride?: string },
      ) => void)
    | null
  >(null);
  // /rewind — rewind to an earlier input: drop that message and everything
  // after it, reposition the provider conversation at the point just before
  // it (prior history intact), and load the input into the composer for
  // editing. Works on chat-only turns: no file checkpoint required.
  const [rewindDialog, setRewindDialog] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "error"; readonly message: string }
    | {
        readonly kind: "loaded";
        readonly target: { environmentId: EnvironmentId; threadId: ThreadId };
        readonly targets: ReadonlyArray<{
          readonly id: string;
          readonly preview: string;
          readonly text: string;
          /**
           * The images the message was sent with. Editing it resends it, so
           * they are put back in the dialog as removable attachments.
           */
          readonly attachments: ReadonlyArray<ChatImageAttachment>;
          /** Count of later user messages — positional anchor for the server. */
          readonly userMessagesAfter: number;
          readonly transcriptId: string | null;
        }>;
        readonly selectedId: string | null;
        readonly draftText: string;
        /**
         * Images to send with the edited prompt.
         *
         * Held here rather than written straight to the composer draft,
         * because a dialog somebody dismisses must leave no attachments
         * behind. They move to the draft when the rewind commits.
         */
        readonly images: ReadonlyArray<ComposerImageAttachment>;
        readonly busy: boolean;
        readonly notice: string | null;
        /** The composer already held unsent text that confirming will replace. */
        readonly replacesComposerDraft: boolean;
      }
    | null
  >(null);
  // One-shot per opening: the list is scrolled to the selected row when the
  // dialog appears, and never again, so it cannot fight the user's own
  // scrolling afterwards.
  const rewindSelectionScrolledRef = useRef(false);
  /**
   * Attachment slots already spoken for: images attached, plus any still being
   * compressed.
   *
   * A ref rather than a read of `rewindDialog`, because the cap has to be
   * counted at the moment the files arrive and the state that holds them is a
   * render behind — two pastes in the same frame would each see the other's
   * slots free. Reading it back out of `setRewindDialog` was the earlier
   * answer and is not one: React only runs that updater eagerly when nothing
   * else is queued on the hook, so an image arriving beside another update was
   * dropped without a word roughly one time in three.
   */
  const rewindReservedImagesRef = useRef(0);
  const openRewindDialog = useCallback(
    async (
      target: { environmentId: EnvironmentId; threadId: ThreadId },
      // Set when the dialog was opened from one specific message — the pencil
      // on a user message — rather than from `/rewind`, which starts on the
      // newest input because that is the one you usually meant.
      options?: { readonly preselectMessageId?: string },
    ) => {
      setRewindDialog({ kind: "loading" });
      // File-restore points, best-effort: the conversation rewind and the
      // prompt editing work with or without them.
      const transcriptResult = await listThreadRewindTargets({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      const transcriptTargets =
        transcriptResult._tag === "Failure" ? [] : [...transcriptResult.value.targets];
      const usedTranscriptIds = new Set<string>();
      const firstLineOf = (text: string) => {
        const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
        return firstLine.length > 120 ? `${firstLine.slice(0, 119)}\u2026` : firstLine;
      };
      const userMessages = timelineEntries.flatMap((entry) =>
        entry.kind === "message" &&
        entry.message.role === "user" &&
        (entry.message.text ?? "").trim().length > 0
          ? [entry.message]
          : [],
      );
      const targets = userMessages
        .map((message, index) => {
          const text = (message.text ?? "").trim();
          const preview = firstLineOf(text);
          return {
            id: message.id as string,
            preview,
            text,
            // What was sent, not just what was typed. Editing resends the
            // message, so its images come back with it.
            attachments: (message.attachments ?? []).filter(
              (entry): entry is ChatImageAttachment => entry.type === "image",
            ),
            userMessagesAfter: userMessages.length - 1 - index,
          };
        })
        .toReversed()
        .map((entry) => {
          // Both lists run newest-first; consume each transcript point once.
          const transcriptMatch = transcriptTargets.find(
            (candidate) =>
              !usedTranscriptIds.has(candidate.id) && candidate.preview === entry.preview,
          );
          if (transcriptMatch) {
            usedTranscriptIds.add(transcriptMatch.id);
          }
          return { ...entry, transcriptId: transcriptMatch?.id ?? null };
        });
      const preselected =
        options?.preselectMessageId === undefined
          ? undefined
          : targets.find((candidate) => candidate.id === options.preselectMessageId);
      // A message with no rewind target of its own (it was never a plain text
      // input) falls back to the newest, which is what /rewind opens on.
      const selected = preselected ?? targets[0];
      // Confirming overwrites the composer and sends. Saying so up front is
      // the difference between a shortcut and losing a half-written prompt.
      const composerDraft = (promptRef.current ?? "").trim();
      rewindSelectionScrolledRef.current = false;
      rewindReservedImagesRef.current = 0;
      setRewindDialog({
        kind: "loaded",
        target,
        targets,
        selectedId: selected?.id ?? null,
        draftText: selected?.text ?? "",
        images: [],
        busy: false,
        notice: null,
        replacesComposerDraft: composerDraft.length > 0 && composerDraft !== selected?.text.trim(),
      });
    },
    [listThreadRewindTargets, timelineEntries],
  );
  /**
   * Object URLs are only reclaimed by revoking them, and every exit from this
   * dialog has to do it: removing one image, dismissing the dialog, and the
   * send path once the draft has taken ownership.
   */
  const revokeRewindImages = useCallback((images: ReadonlyArray<ComposerImageAttachment>) => {
    for (const image of images) {
      if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    }
  }, []);
  const addRewindImages = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      const reserved = rewindReservedImagesRef.current;
      const { accepted, error: refused } = acceptComposerImageFiles({
        files,
        alreadyReserved: reserved,
      });
      if (refused !== null) {
        setRewindDialog((dialog) =>
          dialog?.kind === "loaded" ? { ...dialog, notice: refused } : dialog,
        );
      }
      if (accepted.length === 0) return;
      rewindReservedImagesRef.current = reserved + accepted.length;
      const { images, error } = await compressComposerImageFiles(accepted);
      // Compression can turn a file away; give back the slots it did not use.
      rewindReservedImagesRef.current -= accepted.length - images.length;
      setRewindDialog((dialog) => {
        if (dialog?.kind !== "loaded") {
          // Dismissed while compressing. Nothing will ever own these.
          revokeRewindImages(images);
          return dialog;
        }
        return {
          ...dialog,
          images: [...dialog.images, ...images],
          ...(error === null ? {} : { notice: error }),
        };
      });
    },
    [revokeRewindImages],
  );
  /**
   * Takes the image, its object URL and its reserved slot, in that order.
   *
   * The removal happens here rather than inside the `setRewindDialog` updater,
   * and the caller passes the image rather than its id, because an updater must
   * be pure: React double-invokes it under StrictMode, which ran the revoke and
   * the decrement twice and left the slot count below zero — so the next paste
   * was measured against a cap that had grown.
   */
  const removeRewindImage = useCallback(
    (image: ComposerImageAttachment) => {
      revokeRewindImages([image]);
      rewindReservedImagesRef.current -= 1;
      setRewindDialog((dialog) =>
        dialog?.kind !== "loaded"
          ? dialog
          : { ...dialog, images: dialog.images.filter((entry) => entry.id !== image.id) },
      );
    },
    [revokeRewindImages],
  );
  const closeRewindDialog = useCallback(() => {
    rewindReservedImagesRef.current = 0;
    setRewindDialog((dialog) => {
      if (dialog?.kind === "loaded") revokeRewindImages(dialog.images);
      return null;
    });
  }, [revokeRewindImages]);
  const runRewindToInput = useCallback(async () => {
    const dialog = rewindDialog;
    if (dialog?.kind !== "loaded" || dialog.busy || dialog.selectedId === null) {
      return;
    }
    const selected = dialog.targets.find((candidate) => candidate.id === dialog.selectedId);
    if (!selected) {
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setRewindDialog({ ...dialog, notice: "Interrupt the current turn first, then rewind." });
      return;
    }
    setRewindDialog({ ...dialog, busy: true, notice: null });
    // Handed to the draft now, not at the end: the composer copies the draft
    // into the ref `onSend` reads inside an effect, so the write needs a React
    // commit to reach it, and the rewind round-trip below is what gives it
    // one. Ownership of the object URLs moves with them — the draft revokes
    // them on send — so the failure path below hands them back.
    if (dialog.images.length > 0) {
      addComposerDraftImages(composerDraftTarget, [...dialog.images]);
    }
    // Files FIRST, while the session is still alive. Repositioning the
    // provider conversation stops that session, and the file restore needs
    // it — run the other way round it fails every time with
    // "session closed", which is why every rewind so far reported that the
    // files were left alone.
    let fileNote = "";
    if (
      selected.transcriptId !== null &&
      activeThread?.session != null &&
      activeThread.session.status !== "stopped"
    ) {
      const restored = await runThreadRewindFiles({
        environmentId: dialog.target.environmentId,
        input: {
          threadId: dialog.target.threadId,
          userMessageId: selected.transcriptId,
          dryRun: false,
        },
      });
      fileNote =
        restored._tag === "Failure"
          ? " Files were left as they are."
          : restored.value.canRewind
            ? ` Restored ${restored.value.filesChanged?.length ?? 0} file${
                (restored.value.filesChanged?.length ?? 0) === 1 ? "" : "s"
              }.`
            : " Files were left as they are.";
    }
    const rewound = await runThreadRewindToInput({
      environmentId: dialog.target.environmentId,
      input: {
        threadId: dialog.target.threadId,
        fromMessageId: selected.id,
        userMessagesAfter: selected.userMessagesAfter,
      },
    });
    if (rewound._tag === "Failure") {
      const error = squashAtomCommandFailure(rewound) as Partial<{ detail: string }> | null;
      // The thread did not move, so the images must not stay in the composer
      // of a conversation the user has not rewound. They go back to the dialog
      // they came from, still attached, ready for a second attempt.
      // Removed one by one rather than with a blanket clear: the composer may
      // hold the user's own unsent prompt and their own attachments, and none
      // of that is this rewind's to throw away.
      for (const image of dialog.images) {
        removeComposerDraftImage(composerDraftTarget, image.id);
      }
      // The draft revokes a preview URL as it drops the image, so the
      // thumbnails handed back here would be dead links. The file survived, so
      // each one gets a fresh URL and the dialog is usable for a second try.
      const restoredImages = dialog.images.map((image) => ({
        ...image,
        previewUrl: URL.createObjectURL(image.file),
      }));
      setRewindDialog({
        ...dialog,
        images: restoredImages,
        busy: false,
        notice:
          error?.detail && error.detail.length > 0 ? error.detail : "Could not rewind the thread.",
      });
      return;
    }
    setRewindDialog(null);
    // promptRef is what onSend reads; the store drives the rendered editor.
    // Both carry the edited text, then the turn is sent for you — a rewind
    // that stops at "prompt is sitting in the box" is not a rewind.
    promptRef.current = dialog.draftText;
    setComposerDraftPrompt(composerDraftTarget, dialog.draftText);
    composerRef.current?.resetCursorState({
      prompt: dialog.draftText,
      cursor: dialog.draftText.length,
    });
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Rewound to input",
        description: `${rewound.value.detail}${fileNote} Resending the edited prompt.`,
      }),
    );
    // Next frame: the truncation and the draft write land first, so onSend
    // reads a settled composer. The ref is re-asserted because the composer
    // syncs it from the draft store on its own schedule.
    globalThis.requestAnimationFrame(() => {
      promptRef.current = dialog.draftText;
      onSendRef.current?.();
    });
  }, [
    activeThread?.session,
    composerDraftTarget,
    composerRef,
    isConnecting,
    isSendBusy,
    phase,
    promptRef,
    rewindDialog,
    runThreadRewindFiles,
    runThreadRewindToInput,
    setComposerDraftPrompt,
    addComposerDraftImages,
    removeComposerDraftImage,
    composerDraftTarget,
  ]);

  // /resume <session-id> — shared import flow (also reachable from the
  // new-thread palette by pasting a bare session id).
  const runImportClaudeSession = useImportClaudeSession();
  const importClaudeSession = useCallback(
    (sessionId: string) =>
      runImportClaudeSession(sessionId, {
        environmentId,
        ...(activeThread?.runtimeMode ? { runtimeMode: activeThread.runtimeMode } : {}),
      }),
    [activeThread?.runtimeMode, environmentId, runImportClaudeSession],
  );
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return Boolean(
      draft &&
      (draft.prompt.trim().length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0 ||
        draft.elementContexts.length > 0 ||
        draft.previewAnnotations.length > 0 ||
        draft.reviewComments.length > 0),
    );
  });
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = useCallback(async () => {
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  }, [
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRef,
    updateThreadMetadata,
  ]);
  // The stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: system banners, then the branch-mismatch notice,
  // and the informational parked-thread banner last — it must never cover another.
  const parkedThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadSnoozed && !activeThreadSettled) {
      return null;
    }
    const isSnoozed = activeThreadSnoozed;
    return {
      id: `thread-${isSnoozed ? "snoozed" : "settled"}:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: isSnoozed ? <AlarmClockIcon /> : <CheckCircle2Icon />,
      title: `This thread is ${isSnoozed ? "snoozed" : "settled"}`,
      description: isSnoozed
        ? "Sending a message wakes it and moves it back to Active in the sidebar."
        : "Sending a message moves it back to Active in the sidebar.",
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={isSnoozed ? isUnsnoozing : isUnsettling}
          onClick={() =>
            void (isSnoozed ? handleUnsnoozeActiveThread() : handleUnsettleActiveThread())
          }
        >
          {isSnoozed
            ? isUnsnoozing
              ? "Waking..."
              : "Wake now"
            : isUnsettling
              ? "Un-settling..."
              : "Un-settle"}
        </Button>
      ),
    };
  }, [
    activeThread?.id,
    activeThreadSettled,
    activeThreadSnoozed,
    handleUnsnoozeActiveThread,
    handleUnsettleActiveThread,
    isUnsnoozing,
    isUnsettling,
  ]);
  const handleRestoreThreadBranch = useCallback(() => {
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  }, [gitStatusQuery.data?.hasWorkingTreeChanges, handleSwitchCheckoutToThread]);
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const parkedThreadItems = parkedThreadBannerItem === null ? [] : [parkedThreadBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [...systemComposerBannerItems, ...parkedThreadItems];
    }
    return [
      ...systemComposerBannerItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        className: "dark:shadow-none",
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
          </Button>
        ),
        dismissLabel: "Dismiss branch change notice",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      ...parkedThreadItems,
    ];
  }, [
    activeBranchMismatchKey,
    handleRestoreThreadBranch,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    parkedThreadBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
  ]);

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalUiLaunchContext(null);
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        return null;
      }
      return current;
    });
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath]);

  useEffect(() => {
    if (terminalUiState.terminalOpen) {
      return;
    }
    setTerminalUiLaunchContext((current) =>
      current?.threadId === activeThreadId ? null : current,
    );
  }, [activeThreadId, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalUiState.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalUiState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = {
        terminalFocus: terminalFocusOwner !== null,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      // Select-all, addressed to the conversation. The browser's own answer
      // reaches the sidebar and the composer and still misses every message
      // scrolled out of the virtualised list, so what it was being used for —
      // getting the conversation out of CH3 — is done directly instead.
      //
      // Only when the conversation is what is being addressed: an editable
      // element, the terminal, or a selection sitting somewhere else all keep
      // the platform's select-all untouched.
      if (
        !shortcutContext.terminalFocus &&
        isSelectAllShortcut(event) &&
        !eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) &&
        transcriptRegionAddressed(transcriptRegionRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copyEntireConversation();
        return;
      }

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanel();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal("vertical");
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal("vertical");
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          closePanelTerminal(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (!terminalUiState.terminalOpen) return;
        closeTerminal(terminalUiState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          addTerminalSurface();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "chat.findInThread") {
        event.preventDefault();
        event.stopPropagation();
        openFindInThread();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    activeRightPanelSurface,
    addTerminalSurface,
    terminalUiState.terminalOpen,
    terminalUiState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    closePanelTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitPanelTerminal,
    keybindings,
    onToggleDiff,
    openFindInThread,
    toggleRightPanel,
    toggleTerminalVisibility,
    composerRef,
  ]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const localApi = readLocalApi();
      if (!localApi || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const result = await revertThreadCheckpoint({
        environmentId,
        input: {
          threadId: activeThread.id,
          turnCount,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      setThreadError,
    ],
  );

  const onSend = async (
    e?: { preventDefault: () => void },
    options?: {
      /**
       * Send on this model instead of the one the composer is showing.
       *
       * The confirmed answer to the required-model question below. It travels
       * as an argument rather than through the draft store because a write
       * there only reaches this function on the next render, and this send is
       * happening now — the composer is updated too, so the screen and the run
       * agree, but the run does not wait for it.
       */
      readonly modelOverride?: string;
    },
  ) => {
    e?.preventDefault();
    if (
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      threadDetailLoading ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    )
      return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) return;
    const {
      images: composerImages,
      terminalContexts: composerTerminalContexts,
      elementContexts: composerElementContexts,
      previewAnnotations: composerPreviewAnnotations,
      reviewComments: composerReviewComments,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModelAsShown,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelectionAsShown,
    } = sendCtx;
    const ctxSelectedModel = options?.modelOverride ?? ctxSelectedModelAsShown;
    const ctxSelectedModelSelection =
      options?.modelOverride === undefined
        ? ctxSelectedModelSelectionAsShown
        : createModelSelection(
            ctxSelectedModelSelectionAsShown.instanceId,
            options.modelOverride,
            ctxSelectedModelSelectionAsShown.options,
          );
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerElementContexts.length +
        composerPreviewAnnotations.length +
        composerReviewComments.length,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    // Interactive Claude Code built-ins never reach the model as text: the
    // runtime can't execute them from a prompt, so sending them would burn a
    // paid model turn on a message that just describes the command. The
    // runtime's own advertised list wins where it has one — /clear is the
    // proof, and intercepting it broke a real workflow.
    // A turn that is still running is standing on the very context /clear
    // throws away. Sent mid-turn it reached Claude as steering input and came
    // back as `conversation_reset` with the assistant still streaming, so the
    // turn finished against a conversation that no longer existed. Ordinary
    // messages still go mid-turn — steering is the point — but not this one.
    const blockedContextReset = resolveBlockedContextReset({
      trimmedPrompt: trimmed,
      isTurnInFlight: phase === "running" || phase === "connecting",
      hasAttachments:
        composerImages.length > 0 ||
        sendableComposerTerminalContexts.length > 0 ||
        composerElementContexts.length > 0 ||
        composerPreviewAnnotations.length > 0 ||
        composerReviewComments.length > 0,
    });
    if (blockedContextReset !== null) {
      // The draft is deliberately left alone: the way out is to wait for the
      // turn or stop it, and both end with the user pressing Enter on the
      // message already in front of them.
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: `/${blockedContextReset} while the agent is working`,
          description:
            "It would clear the context this turn is using. Let the turn finish, or stop it first.",
        }),
      );
      return;
    }
    const interactiveBuiltin = resolveInterceptedComposerBuiltin({
      trimmedPrompt: trimmed,
      hasAttachments:
        composerImages.length > 0 ||
        sendableComposerTerminalContexts.length > 0 ||
        composerElementContexts.length > 0 ||
        composerPreviewAnnotations.length > 0 ||
        composerReviewComments.length > 0,
      providerCommandNames: (activeProviderStatus?.slashCommands ?? []).map(
        (command) => command.name,
      ),
    });
    if (interactiveBuiltin) {
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      if (interactiveBuiltin === "mcp") {
        void openMcpStatusDialog({
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
        });
        return;
      }
      if (interactiveBuiltin === "rewind") {
        void openRewindDialog({
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
        });
        return;
      }
      if (interactiveBuiltin === "clear") {
        // Only reached when the runtime does NOT advertise its own /clear.
        // Stopping the session is CH3's fresh context: the thread, its
        // history and its sidebar position all survive, and the next message
        // starts the provider over.
        void (async () => {
          const result = await stopThreadSession({
            environmentId: activeThread.environmentId,
            input: { threadId: activeThread.id },
          });
          toastManager.add(
            stackedThreadToast(
              result._tag === "Failure"
                ? {
                    type: "error",
                    title: "Could not clear the context",
                    description: "The provider session could not be stopped.",
                  }
                : {
                    type: "success",
                    title: "Context cleared",
                    description: "The next message starts a fresh provider session in this thread.",
                  },
            ),
          );
        })();
        return;
      }
      if (interactiveBuiltin === "resume") {
        const sessionId = parseComposerResumeSessionId(trimmed);
        if (sessionId) {
          void importClaudeSession(sessionId);
          return;
        }
      }
      const notice = describeInteractiveBuiltin(interactiveBuiltin);
      if (notice) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: notice.title,
            description: notice.description,
          }),
        );
      }
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    sendInFlightRef.current = true;
    if (isDraftHeroState && activeThreadKey) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(() => {
        flushSync(() => {
          captureDraftHeroComposerRect();
          setDockedDraftHeroThreadKey(activeThreadKey);
        });
        resolveDockStarted?.();
      });
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerElementContextsSnapshot = [...composerElementContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = buildOutgoingTurnText({
      prompt: promptForSend,
      terminalContexts: composerTerminalContextsSnapshot,
      elementContexts: composerElementContextsSnapshot,
      previewAnnotations: composerPreviewAnnotationsSnapshot,
      reviewComments: composerReviewCommentsSnapshot,
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
    });
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    // Sending returns to the live edge and stays there.
    //
    // This used to park the sent message at the top of the viewport and reserve
    // space below it for the reply. Read from the bottom of a conversation —
    // where you are when you send — that is a jump backwards of about a
    // screenful every single time, and a long reply with tool rows then grows
    // past the fold, so the reader scrolls down to catch up with work they were
    // already watching.
    isAtEndRef.current = true;
    setTimelineScrollMode("following-end");
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        turnId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = trimmed;
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerElementContextsSnapshot.length > 0) {
        titleSeed = formatElementContextLabel(composerElementContextsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;
    // Auto-title from first message
    if (isFirstMessage && isServerThread) {
      const titleResult = await updateThreadMetadata({
        environmentId,
        input: {
          threadId: threadIdForSend,
          title,
        },
      });
      if (titleResult._tag === "Failure") {
        failure = titleResult;
      }
    }

    if (failure === null && isServerThread) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(() => turnAttachmentsPromise);
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      beginLocalDispatch({ preparingWorktree: false });
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachmentsResult.value,
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          ...(bootstrap ? { bootstrap } : {}),
          createdAt: messageCreatedAt,
        },
      });
      if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        // The model this turn actually ran on, written as the thread's own
        // selection.
        //
        // Without it the conversation forgets what it is running: the draft
        // record the launcher (or the picker) wrote is keyed to the draft, and
        // once that draft is promoted the composer reads the thread's record
        // instead — which nothing had written, so it fell back to the tier
        // default. The chip then said Sonnet 5 over a turn running on Opus, and
        // the *next* message really did go to Sonnet. `KanbanNewThreadDialog`
        // hit exactly this and wrote the selection in for its own thread; this
        // is the same repair in the one send path, so every conversation gets
        // it rather than the one screen that noticed.
        setComposerDraftModelSelection(
          scopeThreadRef(environmentId, threadIdForSend),
          ctxSelectedModelSelection,
          { replaceOptions: true },
        );
      }
    }

    if (failure !== null) {
      if (
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0 &&
        composerElementContextsRef.current.length === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.previewAnnotations
          .length ?? 0) === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.reviewComments
          .length ?? 0) === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        composerElementContextsRef.current = composerElementContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        setComposerDraftElementContexts(composerDraftTarget, composerElementContextsSnapshot);
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
      }
    }
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      resetLocalDispatch();
    }
  };

  onSendRef.current = onSend;

  const onInterrupt = async () => {
    if (!activeThread) return;
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadApproval, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          answers,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
      }
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadUserInput, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      if (
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Same rule as the other send path: stay at the live edge.
      isAtEndRef.current = true;
      setTimelineScrollMode("following-end");
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);

      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        },
      ]);

      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: ctxSelectedModelSelection,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: nextInteractionMode,
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode,
            interactionMode: nextInteractionMode,
            ...(nextInteractionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread.id,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) {
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default" && autoOpenPlanSidebar) {
          planSidebarDismissedForTurnRef.current = null;
          if (activeThreadRef) {
            useRightPanelStore.getState().open(activeThreadRef, "plan");
          }
        }
        sendInFlightRef.current = false;
        return;
      }

      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send plan follow-up.",
        );
      }
      sendInFlightRef.current = false;
      resetLocalDispatch();
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      localCheckoutBranchMismatch,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      startThreadTurn,
      autoOpenPlanSidebar,
      environmentId,
      composerRef,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    // Implementing a plan opens a *new* conversation, so the same rule applies
    // as anywhere else a thread is created: the model does not come along. The
    // plan was written on whatever it was written on; implementing is a
    // separate conversation, and it opens on the tier default until somebody
    // reaches past it from its own picker.
    const nextThreadModelSelection: ModelSelection = withoutInheritedOutputStyle(
      withNewThreadDefaultModel(ctxSelectedModelSelection),
    );

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: nextThreadModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      // Signal that the plan sidebar should open on the new thread when enabled.
      planSidebarOpenOnNextThreadRef.current = autoOpenPlanSidebar;
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    startThreadTurn,
    autoOpenPlanSidebar,
    environmentId,
    composerRef,
  ]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!activeThread) {
        return null;
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeThread, providerStatuses],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        scheduleComposerFocus();
        return;
      }
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  // The composer no longer picks a workspace — the response-style chip took
  // that slot, and the env mode a new thread starts in comes from Settings.
  // Everything else about worktrees (existing worktree threads, the branch
  // selector's own worktree hops, start-from-origin) is untouched.

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread || !activeThreadRef) return;
      useDiffPanelStore.getState().selectTurn(activeThreadRef, turnId, filePath);
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    },
    [activeThreadRef, isServerThread, onDiffPanelOpen],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);

  // Editing a message IS a rewind: the thread is truncated back to that input,
  // the files that turn touched are restored where a checkpoint allows it, and
  // the edited text is resent. So the pencil opens the same dialog `/rewind`
  // opens, already sitting on the message that was clicked — no second code
  // path, and none of the ways this is subtle get re-derived.
  const openRewindDialogRef = useRef(openRewindDialog);
  openRewindDialogRef.current = openRewindDialog;
  const rewindTargetRef = useRef<{ environmentId: EnvironmentId; threadId: ThreadId } | null>(null);
  rewindTargetRef.current = activeThread
    ? { environmentId: activeThread.environmentId, threadId: activeThread.id }
    : null;
  const onEditUserMessage = useCallback((messageId: MessageId) => {
    const target = rewindTargetRef.current;
    if (!target) return;
    void openRewindDialogRef.current(target, { preselectMessageId: messageId });
  }, []);

  // The message already exists on the thread (it was persisted before the
  // turn failed to start) — this re-dispatches the turn for it, unlike edit
  // it never rewinds or touches text.
  // Only the message still waiting at the end of the thread can be retried —
  // the same rule the decider enforces, so the button is never offered on a
  // turn the server would refuse. Anything after it means the attempt is
  // spent: an assistant reply means the turn ran, a newer user message means
  // the person retyped.
  const retriableMessageId = useMemo(() => {
    const last = activeThread?.messages.at(-1);
    return last !== undefined && last.role === "user" ? last.id : null;
  }, [activeThread?.messages]);

  const onRetryTurnStart = useCallback(
    (messageId: MessageId) => {
      const target = rewindTargetRef.current;
      if (!target) return;
      void retryThreadTurn({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, messageId },
      });
    },
    [retryThreadTurn],
  );

  // Escape hatch beside Retry: opens a separate thread (reusing the same
  // "New thread" path as everywhere else, so an untouched pending draft is
  // reused rather than spawning a pile of empty ones) pre-filled to report
  // the failure, rather than retrying the same thread again. `handleNewThread`
  // does not hand back which draft it landed on, so the draft id is read from
  // the router right after navigation settles.
  const onReportTurnStartFailure = useCallback(
    (report: { detail: string; createdAt: string; messageId: MessageId | null }) => {
      if (!activeProjectRef) return;
      const reportedThreadId = rewindTargetRef.current?.threadId ?? null;
      void (async () => {
        await handleNewThread(activeProjectRef);
        const draftId = /^\/draft\/([^/]+)$/.exec(router.state.location.pathname)?.[1];
        if (!draftId) return;
        const target = DraftId.make(draftId);
        const existingPrompt =
          useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
        const reportPrompt = buildTurnStartFailureReportPrompt({
          threadId: reportedThreadId,
          messageId: report.messageId,
          detail: report.detail,
          createdAt: report.createdAt,
        });
        setComposerDraftPrompt(
          target,
          existingPrompt ? `${existingPrompt}\n\n${reportPrompt}` : reportPrompt,
        );
      })();
    },
    [activeProjectRef, handleNewThread, router, setComposerDraftPrompt],
  );

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const panelToggleControls = (
    <PanelLayoutControls
      terminalAvailable={activeProject !== null}
      terminalOpen={terminalUiState.terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      rightPanelAvailable={activeProject !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      onToggleTerminal={toggleTerminalVisibility}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const panelLayoutControls = (
    <div className="workspace-titlebar-controls z-50 gap-1 [-webkit-app-region:no-drag]">
      {rightPanelOpen && !shouldUsePlanSidebarSheet ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  );
  const rightPanelContent = activeThreadRef ? (
    activeRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={activeRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "terminal" ? (
      <PersistentThreadTerminalPanel
        threadRef={activeThreadRef}
        surface={activeRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onSplitTerminal={splitPanelTerminal}
        onSplitTerminalVertical={splitPanelTerminalVertical}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminal}
        splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
        splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : activeRightPanelSurface?.kind === "diff" ? (
      <Suspense fallback={null}>
        <DiffPanel
          key={`${activeThreadKey}:${diffPanelGitStatusResolutionKey}`}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          initialGitScope={initialDiffPanelGitScope}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "plan" ? (
      <PlanSidebar
        activePlan={activePlan}
        activeProposedPlan={sidebarProposedPlan}
        label={planSidebarLabel}
        environmentId={environmentId}
        threadRef={activeThreadRef}
        markdownCwd={gitCwd ?? undefined}
        workspaceRoot={activeWorkspaceRoot}
        timestampFormat={timestampFormat}
        mode="embedded"
      />
    ) : (activeRightPanelSurface?.kind === "files" || activeRightPanelSurface?.kind === "file") &&
      activeProject &&
      activeWorkspaceRoot ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeProject.environmentId}:${activeWorkspaceRoot}`}
          environmentId={activeProject.environmentId}
          cwd={activeWorkspaceRoot}
          projectName={activeProject.title}
          threadRef={activeThreadRef}
          composerDraftTarget={composerDraftTarget}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={
            activeRightPanelSurface.kind === "file" ? activeRightPanelSurface.relativePath : null
          }
          revealLine={activeFileSurface?.revealLine ?? null}
          revealRequestId={activeFileSurface?.revealRequestId ?? 0}
          onOpenFile={openFileSurface}
          onPendingChange={handleFilePendingChange}
        />
      </Suspense>
    ) : null
  ) : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      {rightPanelOpen && !shouldUsePlanSidebarSheet ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {/* Top bar */}
        <header
          data-chat-header
          className={cn(
            "bg-background transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
            isElectron
              ? cn(
                  "workspace-topbar drag-region relative px-3 sm:px-5",
                  reserveTitleBarControlInset &&
                    !inlineRightPanelOwnsTitleBar &&
                    "wco:pr-[var(--workspace-native-controls-inset)]",
                )
              : "workspace-topbar pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {!rightPanelOpen ? panelLayoutControls : null}
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            {...(routeKind === "draft" && draftId ? { draftId } : {})}
            activeThreadTitle={activeThread.title}
            activeProjectName={activeProject?.title}
            activeProjectCwd={activeProject?.workspaceRoot ?? null}
            openInCwd={gitCwd}
            activeProjectScripts={activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            rightPanelOpen={rightPanelOpen}
            gitCwd={gitCwd}
            onNewThreadInProject={handleNewThreadInActiveProject}
            onRunProjectScript={runProjectScript}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
          />
        </header>

        <ThreadErrorBanner
          error={threadError}
          errorClass={threadErrorClass}
          onDismiss={() => setThreadError(activeThread.id, null)}
        />
        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Provider status overlays the timeline without changing its content height. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
              />
            </div>
            {/* Messages Wrapper — also the region a selection must sit inside to be quotable */}
            <div
              ref={transcriptRegionRef}
              onContextMenu={onTranscriptContextMenu}
              className="relative flex min-h-0 flex-1 flex-col"
            >
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <MessagesTimeline
                key={activeThread.id}
                speechAvailable={speechAvailable}
                isWorking={isWorking}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnStartedAt={activeWorkStartedAt}
                listRef={legendListRef}
                timelineEntries={timelineEntries}
                threadActivities={activeThread.activities ?? EMPTY_THREAD_ACTIVITIES}
                agentModelContext={agentModelContext}
                latestTurn={activeLatestTurn}
                runningTurnId={activeRunningTurnId}
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                onOpenTurnDiff={onOpenTurnDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                onEditUserMessage={onEditUserMessage}
                onRetryTurnStart={onRetryTurnStart}
                retriableMessageId={retriableMessageId}
                onReportTurnStartFailure={onReportTurnStartFailure}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
                contentInsetEndAdjustment={composerOverlayHeight}
                onIsAtEndChange={onIsAtEndChange}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                followEnd={followTimelineEnd}
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                topFadeEnabled={!hasTimelineTopBanner}
                onStartReached={
                  activeThread.hasMoreActivities === true ? onTimelineStartReached : undefined
                }
                isProgrammaticScrollExpected={isProgrammaticTimelineScrollExpected}
                find={timelineFind}
              />

              {findState !== null && findQuery !== null && (
                <FindInThreadBar
                  query={findState.query}
                  matchCount={findMatches.length}
                  activePosition={findMatches.length === 0 ? 0 : findActiveIndex + 1}
                  focusToken={findState.focusToken}
                  onQueryChange={(query) =>
                    setFindState((existing) =>
                      existing === null ? existing : { ...existing, query, activeIndex: 0 },
                    )
                  }
                  onStep={stepFindMatch}
                  onClose={() => {
                    setFindState(null);
                    // Closing the bar otherwise leaves focus on `body`, where
                    // typing and the arrow keys go nowhere. The composer is
                    // where the reader was before the search and where the
                    // next keystroke belongs.
                    focusComposer();
                  }}
                />
              )}

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && (
                <div
                  className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                  style={{ bottom: composerOverlayHeight + 4 }}
                >
                  <button
                    type="button"
                    aria-label="Scroll to end"
                    title="Scroll to end"
                    onClick={scrollToEnd}
                    className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                  </button>
                </div>
              )}
            </div>

            {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
            <div
              ref={setComposerOverlayElement}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div
                ref={attachDraftHeroTransitionGroupRef}
                className="chat-composer-horizontal-inset w-full"
              >
                <div className="pointer-events-auto relative z-10">
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div
                        className="pb-8"
                        style={
                          forceExpandedMobileComposer
                            ? {
                                viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
                              }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                      <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                    </div>
                  ) : (
                    <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                  )}
                  {threadSyncPhase && !activeEnvironmentUnavailable ? (
                    <ThreadSyncStatusPill phase={threadSyncPhase} />
                  ) : null}
                  <div
                    className="relative"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <div
                      className={cn(
                        "chat-composer-glass-shell relative mx-auto w-full max-w-5xl",
                        showComposerContextStrip && "chat-composer-glass-shell-with-context",
                      )}
                    >
                      <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
                        <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                          <ChatComposer
                            onToggleTerminal={toggleTerminalVisibility}
                            onOpenMcpStatus={
                              activeThread
                                ? () =>
                                    void openMcpStatusDialog({
                                      environmentId: activeThread.environmentId,
                                      threadId: activeThread.id,
                                    })
                                : undefined
                            }
                            onOpenRewind={
                              activeThread
                                ? () =>
                                    void openRewindDialog({
                                      environmentId: activeThread.environmentId,
                                      threadId: activeThread.id,
                                    })
                                : undefined
                            }
                            composerRef={composerRef}
                            composerDraftTarget={composerDraftTarget}
                            environmentId={environmentId}
                            routeKind={routeKind}
                            routeThreadRef={routeThreadRef}
                            draftId={draftId}
                            activeThreadId={activeThreadId}
                            activeThreadEnvironmentId={activeThread?.environmentId}
                            activeThread={activeThread}
                            isServerThread={isServerThread}
                            isLocalDraftThread={isLocalDraftThread}
                            forceExpandedOnMobile={forceExpandedMobileComposer && isDraftHeroState}
                            projectSelectionRequired={isLocalDraftThread && activeProject === null}
                            phase={phase}
                            isConnecting={isConnecting}
                            isSendBusy={isSendBusy}
                            sendDisabledReason={threadDetailLoading ? "Messages loading" : null}
                            isPreparingWorktree={isPreparingWorktree}
                            environmentUnavailable={activeEnvironmentUnavailableState}
                            activePendingApproval={activePendingApproval}
                            pendingApprovals={pendingApprovals}
                            pendingUserInputs={pendingUserInputs}
                            activePendingProgress={activePendingProgress}
                            activePendingResolvedAnswers={activePendingResolvedAnswers}
                            activePendingIsResponding={activePendingIsResponding}
                            activePendingDraftAnswers={activePendingDraftAnswers}
                            activePendingQuestionIndex={activePendingQuestionIndex}
                            respondingRequestIds={respondingRequestIds}
                            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                            activeProposedPlan={activeProposedPlan}
                            activePlan={activePlan as { turnId?: TurnId } | null}
                            sidebarProposedPlan={sidebarProposedPlan as { turnId?: TurnId } | null}
                            planSidebarLabel={planSidebarLabel}
                            planSidebarOpen={planSidebarOpen}
                            runtimeMode={runtimeMode}
                            interactionMode={interactionMode}
                            lockedProvider={lockedProvider}
                            providerStatuses={providerStatuses as ServerProvider[]}
                            activeProjectDefaultModelSelection={
                              activeProject?.defaultModelSelection
                            }
                            activeThreadModelSelection={activeThread?.modelSelection}
                            activeThreadHasStarted={threadHasStarted(activeThread)}
                            activeThreadActivities={activeThread?.activities}
                            resolvedTheme={resolvedTheme}
                            settings={settings}
                            keybindings={keybindings}
                            terminalOpen={Boolean(terminalUiState.terminalOpen)}
                            terminalBusy={threadHasWorkRunning}
                            gitCwd={gitCwd}
                            promptRef={promptRef}
                            composerImagesRef={composerImagesRef}
                            composerTerminalContextsRef={composerTerminalContextsRef}
                            composerElementContextsRef={composerElementContextsRef}
                            onSend={onSend}
                            onInterrupt={onInterrupt}
                            onImplementPlanInNewThread={onImplementPlanInNewThread}
                            onRespondToApproval={onRespondToApproval}
                            onSelectActivePendingUserInputOption={
                              onSelectActivePendingUserInputOption
                            }
                            onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                            onPreviousActivePendingUserInputQuestion={
                              onPreviousActivePendingUserInputQuestion
                            }
                            onChangeActivePendingUserInputCustomAnswer={
                              onChangeActivePendingUserInputCustomAnswer
                            }
                            onProviderModelSelect={onProviderModelSelect}
                            getModelDisabledReason={getModelDisabledReason}
                            toggleInteractionMode={toggleInteractionMode}
                            handleRuntimeModeChange={handleRuntimeModeChange}
                            handleInteractionModeChange={handleInteractionModeChange}
                            togglePlanSidebar={togglePlanSidebar}
                            focusComposer={focusComposer}
                            scheduleComposerFocus={scheduleComposerFocus}
                            setThreadError={setThreadError}
                            onExpandImage={onExpandTimelineImage}
                          />
                        </div>
                      </div>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                outputStyleChip={outputStyleChip}
                                {...(outputStyleInstanceId ? { onOutputStyleChange } : {})}
                                {...(canRedoLastReplyInStyle
                                  ? { onRedoLastReply: onRedoLastReplyInStyle }
                                  : {})}
                                showBranchSelector={isGitRepo}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                {...(canOverrideServerThreadEnvMode
                                  ? { effectiveEnvModeOverride: envMode }
                                  : {})}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocus}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                  : {})}
                                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                availableEnvironments={logicalProjectEnvironments}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {activeThreadRef && activePreviewMiniPlayer ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${activePreviewMiniPlayer.tabId}`}
                threadRef={activeThreadRef}
                tabId={activePreviewMiniPlayer.tabId}
                bottomInset={isDraftHeroState ? 0 : composerOverlayHeight}
              />
            ) : null}

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{" "}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ""}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    onClick={() => {
                      setBranchRestoreConfirmOpen(false);
                      void handleSwitchCheckoutToThread();
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
            <AlertDialog
              open={mcpStatusDialog !== null}
              onOpenChange={(open) => {
                if (!open) {
                  setMcpStatusDialog(null);
                  // Closing mid-start must not leave a stale "Starting..."
                  // stuck on a later, unrelated no-session error.
                  setStartingMcpSession(false);
                }
              }}
            >
              <AlertDialogPopup data-testid="mcp-status-dialog">
                <AlertDialogHeader>
                  <AlertDialogTitle>MCP servers</AlertDialogTitle>
                  <AlertDialogDescription>
                    {mcpStatusDialog?.kind === "loading"
                      ? "Reading server status from the session..."
                      : mcpStatusDialog?.kind === "error"
                        ? mcpStatusDialog.message
                        : mcpStatusDialog?.servers.length === 0
                          ? "No MCP servers are configured for this session."
                          : "Status reported by the live session."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {mcpStatusDialog?.kind === "loaded" && mcpStatusDialog.servers.length > 0 ? (
                  <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm">
                    {mcpStatusDialog.servers.map((server) => {
                      const anyBusy = mcpStatusDialog.busy !== null;
                      const isDisabled = server.status === "disabled";
                      const needsAuth =
                        server.status === "needs-auth" || server.status === "failed";
                      // Remote (http/sse) servers hold credentials the CLI can
                      // refresh or forget; stdio servers have none to manage.
                      const hasManagedAuth = server.url !== undefined || needsAuth;
                      const toolsExpanded = mcpToolsExpandedFor === server.name;
                      const meta = [server.transport, server.url, server.scope]
                        .filter(Boolean)
                        .join(" \u00b7 ");
                      return (
                        <li
                          key={server.name}
                          className="space-y-1 rounded-md bg-muted/50 px-3 py-1.5"
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0">
                              <span className="inline-flex items-center gap-1.5 font-medium">
                                <McpMark name={server.name} className="size-3.5 shrink-0" />
                                {server.name}
                              </span>
                              {server.serverVersion ? (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {server.serverVersion}
                                </span>
                              ) : null}
                              {meta ? (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {meta}
                                </span>
                              ) : null}
                              {server.error ? (
                                <span className="block truncate text-xs text-destructive-foreground">
                                  {server.error}
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {server.status}
                              {server.toolCount !== undefined
                                ? ` \u00b7 ${server.toolCount} tools`
                                : ""}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {server.tools !== undefined && server.tools.length > 0 ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setMcpToolsExpandedFor(toolsExpanded ? null : server.name)
                                }
                              >
                                {toolsExpanded ? "Hide tools" : "View tools"}
                              </Button>
                            ) : null}
                            {hasManagedAuth ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={anyBusy}
                                onClick={() => void runMcpDialogAction(server.name, "authenticate")}
                              >
                                {mcpStatusDialog.busy === `${server.name}:authenticate`
                                  ? "Starting sign-in..."
                                  : needsAuth
                                    ? "Authenticate"
                                    : "Re-authenticate"}
                              </Button>
                            ) : null}
                            {hasManagedAuth ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={anyBusy}
                                onClick={() => void runMcpDialogAction(server.name, "clear-auth")}
                              >
                                {mcpStatusDialog.busy === `${server.name}:clear-auth`
                                  ? "Clearing..."
                                  : "Clear auth"}
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={anyBusy || isDisabled}
                              onClick={() => void runMcpDialogAction(server.name, "reconnect")}
                            >
                              {mcpStatusDialog.busy === `${server.name}:reconnect`
                                ? "Reconnecting..."
                                : "Reconnect"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={anyBusy}
                              onClick={() =>
                                void runMcpDialogAction(
                                  server.name,
                                  isDisabled ? "enable" : "disable",
                                )
                              }
                            >
                              {mcpStatusDialog.busy === `${server.name}:enable` ||
                              mcpStatusDialog.busy === `${server.name}:disable`
                                ? "Working..."
                                : isDisabled
                                  ? "Enable"
                                  : "Disable"}
                            </Button>
                          </div>
                          {toolsExpanded && server.tools !== undefined ? (
                            <ul className="max-h-40 space-y-0.5 overflow-y-auto border-t border-border/50 pt-1 text-xs">
                              {server.tools.map((tool) => (
                                <li key={tool.name} className="flex items-baseline gap-2">
                                  <span className="shrink-0 font-mono">{tool.name}</span>
                                  {tool.readOnly ? (
                                    <span className="shrink-0 text-muted-foreground/70">
                                      read-only
                                    </span>
                                  ) : null}
                                  {tool.destructive ? (
                                    <span className="shrink-0 text-destructive-foreground/80">
                                      destructive
                                    </span>
                                  ) : null}
                                  {tool.description ? (
                                    <span className="min-w-0 truncate text-muted-foreground">
                                      {tool.description}
                                    </span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {mcpStatusDialog?.kind === "loaded" && mcpStatusDialog.notice ? (
                  <p className="text-xs text-muted-foreground">{mcpStatusDialog.notice}</p>
                ) : null}
                {mcpStatusDialog?.kind === "loaded" && mcpStatusDialog.signInUrl ? (
                  <McpSignInLink url={mcpStatusDialog.signInUrl} />
                ) : null}
                <AlertDialogFooter>
                  {mcpStatusDialog?.kind === "loaded" ? (
                    <Button
                      variant="ghost"
                      disabled={mcpStatusDialog.busy !== null}
                      onClick={() => void openMcpStatusDialog(mcpStatusDialog.target)}
                    >
                      Refresh
                    </Button>
                  ) : null}
                  {mcpStatusDialog?.kind === "error" &&
                  mcpStatusDialog.reason === "no-session" &&
                  isServerThread ? (
                    <Button
                      variant="ghost"
                      disabled={startingMcpSession}
                      onClick={() => void handleStartMcpSession()}
                    >
                      {startingMcpSession ? "Starting..." : "Start session"}
                    </Button>
                  ) : null}
                  <AlertDialogClose render={<Button variant="outline" />}>Close</AlertDialogClose>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
            <AlertDialog
              open={rewindDialog !== null}
              onOpenChange={(open) => {
                if (!open) closeRewindDialog();
              }}
            >
              <AlertDialogPopup data-testid="rewind-dialog">
                <AlertDialogHeader>
                  <AlertDialogTitle>Rewind to input</AlertDialogTitle>
                  <AlertDialogDescription>
                    {rewindDialog?.kind === "loading"
                      ? "Reading this thread's inputs..."
                      : rewindDialog?.kind === "error"
                        ? rewindDialog.message
                        : rewindDialog?.targets.length === 0
                          ? "No inputs to rewind to yet."
                          : "Pick an earlier input, edit it, and resume from there. Later messages are discarded; everything before is kept."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {rewindDialog?.kind === "loaded" && rewindDialog.targets.length > 0 ? (
                  <div className="space-y-2">
                    {/* Renders nothing: this is the selected message's own
                        images being fetched back so the edit resends what was
                        sent. Keyed on the selection as well, so picking another
                        message starts again with that message's images. */}
                    {rewindDialog.targets
                      .find((candidate) => candidate.id === rewindDialog.selectedId)
                      ?.attachments.map((attachment) => (
                        <RewindMessageAttachment
                          key={`${rewindDialog.selectedId ?? ""}:${attachment.id}`}
                          environmentId={rewindDialog.target.environmentId}
                          attachment={attachment}
                          onRestore={addRewindImages}
                        />
                      ))}
                    <ul className="max-h-44 space-y-1 overflow-y-auto text-sm">
                      {rewindDialog.targets.map((target) => (
                        <li key={target.id}>
                          <label className="flex cursor-pointer items-baseline gap-2 rounded-md bg-muted/50 px-3 py-1.5">
                            <input
                              type="radio"
                              name="rewind-target"
                              className="translate-y-px"
                              ref={(node) => {
                                // The pencil can select a row far down a long
                                // list; without this the dialog opens at the
                                // top and looks like nothing is selected.
                                if (
                                  node === null ||
                                  rewindSelectionScrolledRef.current ||
                                  rewindDialog.selectedId !== target.id
                                ) {
                                  return;
                                }
                                rewindSelectionScrolledRef.current = true;
                                node.scrollIntoView({ block: "nearest" });
                              }}
                              checked={rewindDialog.selectedId === target.id}
                              disabled={rewindDialog.busy}
                              onChange={() => {
                                // The images belong to the message, so picking
                                // another one drops the first message's and
                                // lets its own be put back.
                                revokeRewindImages(rewindDialog.images);
                                rewindReservedImagesRef.current = 0;
                                setRewindDialog({
                                  ...rewindDialog,
                                  selectedId: target.id,
                                  draftText: target.text,
                                  images: [],
                                  notice: null,
                                });
                              }}
                            />
                            <span className="min-w-0 flex-1 truncate">{target.preview}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <textarea
                      className="min-h-24 w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-ring"
                      value={rewindDialog.draftText}
                      disabled={rewindDialog.busy || rewindDialog.selectedId === null}
                      onChange={(event) =>
                        setRewindDialog({ ...rewindDialog, draftText: event.target.value })
                      }
                      // Paste, exactly as the composer takes it. A screenshot
                      // on the clipboard is the commonest way an image reaches
                      // a prompt, and this dialog sends the turn itself — the
                      // composer never gets a chance to accept one afterwards.
                      onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files).filter((file) =>
                          file.type.startsWith("image/"),
                        );
                        if (files.length === 0) return;
                        event.preventDefault();
                        void addRewindImages(files);
                      }}
                      placeholder="Edit the input you are rewinding to..."
                    />
                    {rewindDialog.images.length > 0 ? (
                      <ul className="flex flex-wrap gap-2">
                        {rewindDialog.images.map((image) => (
                          <li key={image.id} className="relative">
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="size-14 rounded-md border border-border object-cover"
                            />
                            <button
                              type="button"
                              aria-label={`Remove ${image.name}`}
                              disabled={rewindDialog.busy}
                              onClick={() => removeRewindImage(image)}
                              className="absolute -right-1.5 -top-1.5 inline-flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-background text-xs text-muted-foreground hover:text-foreground"
                            >
                              <XIcon className="size-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                      <ImageIcon className="size-3.5" />
                      Attach images
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="sr-only"
                        disabled={rewindDialog.busy || rewindDialog.selectedId === null}
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          // Cleared so picking the same file twice in a row
                          // still fires a change event.
                          event.target.value = "";
                          void addRewindImages(files);
                        }}
                      />
                    </label>
                    {rewindDialog.notice ? (
                      <p className="text-xs text-destructive-foreground">{rewindDialog.notice}</p>
                    ) : null}
                    {rewindDialog.replacesComposerDraft ? (
                      <p className="text-xs text-muted-foreground">
                        This replaces the unsent text in your composer.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <AlertDialogFooter>
                  {rewindDialog?.kind === "loaded" && rewindDialog.targets.length > 0 ? (
                    <Button
                      variant="destructive"
                      disabled={
                        rewindDialog.busy ||
                        rewindDialog.selectedId === null ||
                        rewindDialog.draftText.trim().length === 0
                      }
                      onClick={() => void runRewindToInput()}
                    >
                      {rewindDialog.busy ? "Rewinding..." : "Rewind & edit prompt"}
                    </Button>
                  ) : null}
                  <AlertDialogClose render={<Button variant="outline" />}>Close</AlertDialogClose>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                cwd={activeProject?.workspaceRoot ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}

        {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
          <PersistentThreadTerminalDrawer
            key={mountedThreadKey}
            threadRef={mountedThreadRef}
            threadId={mountedThreadRef.threadId}
            visible={mountedThreadKey === activeThreadKey && terminalUiState.terminalOpen}
            launchContext={
              mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
            }
            focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            keybindings={keybindings}
            onAddTerminalContext={addTerminalContextToDraft}
          />
        ))}
      </div>

      {!shouldUsePlanSidebarSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelTabs
          mode="inline"
          maximized={rightPanelMaximized}
          surfaces={rightPanelState.surfaces}
          activeSurfaceId={activeRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onCopyFilePath={copyRightPanelFilePath}
          onAddBrowser={createBrowserSurface}
          onAddTerminal={addTerminalSurface}
          onAddDiff={addDiffSurface}
          onAddFiles={addFilesSurface}
          browserAvailable={isPreviewSupportedInRuntime()}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {shouldUsePlanSidebarSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelSheet open onClose={planSidebarOpen ? closePlanSidebar : closePreviewPanel}>
          <RightPanelTabs
            mode="sheet"
            layoutControls={panelToggleControls}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activeRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            terminalLabelsById={activeTerminalLabelsById}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={activeProject !== null}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? "image"}:${expandedImage.index}`}
          preview={expandedImage}
          onClose={closeExpandedImage}
        />
      )}
    </div>
  );
}

export default function ChatView(props: ChatViewProps) {
  return (
    <DiffWorkerPoolProvider>
      <ChatViewContent {...props} />
    </DiffWorkerPoolProvider>
  );
}
