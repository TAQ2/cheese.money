import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FolderTreeIcon, InboxIcon, Rows3Icon, ShuffleIcon } from "lucide-react";

import { useSidebarV2Enabled, useUpdateClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type SidebarMode = "inbox" | "projects" | "kanban";

/** How long the Inbox chip must be held before the inbox is jumbled. */
const INBOX_HOLD_MS = 3000;
/**
 * When the letters start moving, which is well before the deadline.
 *
 * The letters are the progress bar: a three-second hold with nothing happening
 * reads as a dead button. Releasing before the deadline puts the word straight
 * back, so nothing is done that the user did not hold all the way through.
 */
const INBOX_SCRAMBLE_DELAY_MS = 350;
/** How often a held word redraws. Fast enough to read as noise, not as text. */
const INBOX_SCRAMBLE_FRAME_MS = 55;
/** The burst that lands the change, after the hold has already fired. */
const INBOX_SETTLE_MS = 420;
/** What the letters are replaced with. No digits, so the width still moves. */
const SCRAMBLE_GLYPHS = "!<>-_\\/[]{}—=+*^?#";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The word, with its letters thrown around while `active`.
 *
 * Finite and user-driven: it runs only while the chip is held or for the short
 * burst that lands the change, never in the background. A sidebar that
 * repaints on its own is the thing CLAUDE.md forbids; this repaints while a
 * finger is down. Reduced motion gets the still word.
 */
function useScrambledWord(word: string, active: boolean): string {
  const [scrambled, setScrambled] = useState(word);

  useEffect(() => {
    if (!active || prefersReducedMotion()) {
      setScrambled(word);
      return;
    }
    const timer = window.setInterval(() => {
      setScrambled(
        Array.from(word)
          .map((letter) =>
            Math.random() < 0.5
              ? letter
              : SCRAMBLE_GLYPHS[Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)]!,
          )
          .join(""),
      );
    }, INBOX_SCRAMBLE_FRAME_MS);
    // A hard stop that owns the interval, independent of the flag that started
    // it. The state machine above is meant to be correct, but a sidebar that
    // repaints forever is the difference between a bug and an app the user has
    // to restart — which is exactly what shipped once already. No press can
    // outlive one hold plus its landing burst.
    const deadline = window.setTimeout(
      () => {
        window.clearInterval(timer);
        setScrambled(word);
      },
      INBOX_HOLD_MS + INBOX_SETTLE_MS * 2,
    );
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(deadline);
      setScrambled(word);
    };
  }, [active, word]);

  return active ? scrambled : word;
}

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
export function SidebarModeToggle({
  className,
  onInboxHold,
  inboxShuffled = false,
}: {
  readonly className?: string;
  /**
   * Held the Inbox chip all the way through. Only the inbox sidebar passes
   * this: it is the one view with a list to jumble, and a chip that did
   * nothing on a long press everywhere else would be a lie about the gesture.
   */
  readonly onInboxHold?: (() => void) | undefined;
  readonly inboxShuffled?: boolean;
}) {
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

  // Held, or landing the change. Both move the letters; only the first can be
  // called off by letting go.
  const [holdingInbox, setHoldingInbox] = useState(false);
  const [settlingInbox, setSettlingInbox] = useState(false);
  const holdTimersRef = useRef<{
    scramble: number | null;
    fire: number | null;
    settle: number | null;
  }>({ scramble: null, fire: null, settle: null });
  const heldToTheEndRef = useRef(false);

  /**
   * The press timers only. NOT the settle timer.
   *
   * Lumping them together is what made the letters scramble forever: the
   * settle timer is the one that turns the animation off, it is armed when the
   * hold fires, and the pointer is still down at that moment — so the release
   * that came a moment later cancelled the only thing that could stop it. The
   * word then jumbled until the window was reloaded, and pressing again could
   * not clear it because that path cancelled it too.
   */
  const clearPressTimers = useCallback(() => {
    const timers = holdTimersRef.current;
    if (timers.scramble !== null) window.clearTimeout(timers.scramble);
    if (timers.fire !== null) window.clearTimeout(timers.fire);
    holdTimersRef.current = { ...timers, scramble: null, fire: null };
  }, []);

  /** The burst that lands the change, cancelled only by unmount or a new press. */
  const clearSettleTimer = useCallback(() => {
    const timers = holdTimersRef.current;
    if (timers.settle !== null) window.clearTimeout(timers.settle);
    holdTimersRef.current = { ...timers, settle: null };
  }, []);

  // A press that outlives the component must not fire into nothing.
  useEffect(() => {
    return () => {
      clearPressTimers();
      clearSettleTimer();
    };
  }, [clearPressTimers, clearSettleTimer]);

  const beginInboxHold = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!onInboxHold) return;
      // A press, not any pointer contact. `pointerdown` fires for the right
      // and middle buttons and for every extra finger, so without this a
      // held right-click reorders the inbox behind its own context menu.
      if (event.button !== 0 || !event.isPrimary) return;
      heldToTheEndRef.current = false;
      clearPressTimers();
      // A new press supersedes the last one's landing burst, so the animation
      // never has two owners.
      clearSettleTimer();
      setSettlingInbox(false);
      holdTimersRef.current = {
        ...holdTimersRef.current,
        scramble: window.setTimeout(() => setHoldingInbox(true), INBOX_SCRAMBLE_DELAY_MS),
        fire: window.setTimeout(() => {
          heldToTheEndRef.current = true;
          setHoldingInbox(false);
          setSettlingInbox(true);
          onInboxHold();
          holdTimersRef.current = {
            ...holdTimersRef.current,
            settle: window.setTimeout(() => {
              holdTimersRef.current = { ...holdTimersRef.current, settle: null };
              setSettlingInbox(false);
            }, INBOX_SETTLE_MS),
          };
        }, INBOX_HOLD_MS),
      };
    },
    [clearPressTimers, clearSettleTimer, onInboxHold],
  );

  const endInboxHold = useCallback(() => {
    // Deliberately leaves the settle timer alone: letting go is the end of the
    // press, not of the animation it already started.
    clearPressTimers();
    setHoldingInbox(false);
  }, [clearPressTimers]);

  const MODE_WORD: Record<SidebarMode, string> = {
    inbox: "Inbox",
    projects: "Projects",
    kanban: "Kanban",
  };
  const inboxWord = useScrambledWord(MODE_WORD.inbox, holdingInbox || settlingInbox);

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
            onClick={() => {
              // The hold already did something; the click the same gesture
              // synthesizes must not also switch modes.
              if (mode === "inbox" && heldToTheEndRef.current) {
                heldToTheEndRef.current = false;
                return;
              }
              selectMode(mode);
            }}
            {...(mode === "inbox" && onInboxHold && activeMode === "inbox"
              ? {
                  onPointerDown: beginInboxHold,
                  onPointerUp: endInboxHold,
                  onPointerLeave: endInboxHold,
                  onPointerCancel: endInboxHold,
                }
              : {})}
          />
        }
      >
        {icon}
        {activeMode === mode ? (
          <span className="ml-1 text-[10px] font-medium">
            {mode === "inbox" ? inboxWord : MODE_WORD[mode]}
          </span>
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
      {modeButton(
        "inbox",
        // The way to SEE it, which a jumbled list otherwise lacks: a shuffled
        // inbox says so in its icon and its tooltip, and the tooltip names the
        // way back rather than leaving the user to rediscover the gesture.
        inboxShuffled ? "Inbox view — shuffled. Hold to put it back." : "Inbox view",
        inboxShuffled ? <ShuffleIcon className="size-3.5" /> : <InboxIcon className="size-3.5" />,
      )}
      {modeButton("projects", "Projects view", <FolderTreeIcon className="size-3.5" />)}
      {modeButton("kanban", "Kanban board", <Rows3Icon className="size-3.5" />)}
    </div>
  );
}
