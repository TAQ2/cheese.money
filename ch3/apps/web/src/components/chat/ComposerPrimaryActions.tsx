import { memo, type PointerEventHandler } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ClockIcon, PlusIcon } from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { StageBackdropButtonArt, useStageIdentificationVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  /** The message *in the composer right now* is waiting for this turn to finish. */
  isQueued: boolean;
  /**
   * This thread has something queued, so there is a queue to stack behind.
   * True while a frozen message waits even though the composer itself is not
   * queued — that is exactly the state a second + press starts from.
   */
  canStackQueuedSend: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  /** Toggles the queued send on and off. */
  onQueue: () => void;
  /** Freezes the composer's message behind the queue and hands it back empty. */
  onStackQueuedSend: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  isQueued,
  canStackQueuedSend,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onPreviousPendingQuestion,
  onInterrupt,
  onQueue,
  onStackQueuedSend,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const isSendDisabled = sendDisabledReason !== null;
  const stageBackdropVariant = useStageIdentificationVariant(
    environmentIdentificationMode === "artwork",
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning) {
    // Three choices while the agent works, because they are genuinely
    // different intents:
    //   Queue — hold this until the agent finishes everything, then send it
    //           as a fresh turn. Nothing reaches the model meanwhile, so the
    //           current work is not influenced.
    //   Send  — push it into the running turn now, steering the work in
    //           flight. This is what typing at the CLI while it works does.
    //   Stop  — interrupt.
    // The + under Queue is a fourth: hold *another* message behind the one
    // already waiting, so a queue can be two or three deep.
    const canSend = hasSendableContent && !isSendDisabled && !isConnecting;
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        <div className="flex flex-col items-center gap-0.5">
          <button
            type="button"
            className={cn(
              "flex size-8 items-center justify-center rounded-full border transition-all duration-150 disabled:pointer-events-none disabled:opacity-30",
              isQueued
                ? "border-primary bg-primary/15 text-primary"
                : "border-border/70 text-muted-foreground enabled:cursor-pointer enabled:hover:scale-105 enabled:hover:text-foreground",
            )}
            {...pointerFocusProps}
            onClick={onQueue}
            disabled={!isQueued && !canSend}
            aria-pressed={isQueued}
            aria-label={
              isQueued
                ? "Queued — sends when the agent finishes. Click to cancel."
                : "Queue until the agent finishes"
            }
            title={
              isQueued
                ? "Queued — sends when the agent finishes. Click to cancel."
                : "Queue until the agent finishes"
            }
          >
            {isQueued ? (
              <Spinner className="size-3.5" aria-hidden="true" />
            ) : (
              <ClockIcon className="size-3.5" aria-hidden="true" />
            )}
          </button>
          {/* Only once something is queued: with an empty queue there is
              nothing to stack behind, and Queue is the button for that. */}
          {canStackQueuedSend ? (
            <button
              type="button"
              data-composer-stack-queued-send="true"
              // Smaller than the Queue button above it and sitting a little
              // lower: it is the secondary of the pair, and at the same weight
              // the two read as one control split in half.
              className="mt-0.5 flex size-4 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-all duration-150 enabled:cursor-pointer enabled:hover:scale-105 enabled:hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              {...pointerFocusProps}
              onClick={onStackQueuedSend}
              disabled={!canSend}
              aria-label="Queue this behind the messages already waiting"
              title="Queue this behind the messages already waiting"
            >
              <PlusIcon className="size-2.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <button
          type="submit"
          className="flex size-8 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-xs shadow-primary/24 transition-all duration-150 enabled:cursor-pointer enabled:hover:scale-105 enabled:hover:bg-primary disabled:pointer-events-none disabled:opacity-30"
          {...pointerFocusProps}
          disabled={!canSend || isSendBusy}
          aria-label="Send now, steering the running turn"
          title="Send now, steering the running turn"
        >
          {isSendBusy ? (
            <Spinner className="size-3.5" aria-hidden="true" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none sm:h-8 sm:w-8"
          {...pointerFocusProps}
          onClick={onInterrupt}
          aria-label="Stop generation"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <rect x="2" y="2" width="8" height="8" rx="1.5" />
          </svg>
        </button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8",
        stageBackdropVariant
          ? "bg-transparent enabled:shadow-black/24 enabled:hover:brightness-110"
          : "bg-primary/90 enabled:shadow-primary/24 hover:bg-primary",
      )}
      {...pointerFocusProps}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isEnvironmentUnavailable ||
        !hasSendableContent
      }
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : sendDisabledReason
            ? sendDisabledReason
            : isConnecting
              ? "Connecting"
              : isPreparingWorktree
                ? "Preparing worktree"
                : isSendBusy
                  ? "Sending"
                  : "Send message"
      }
    >
      {stageBackdropVariant ? (
        <span className="absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
});
