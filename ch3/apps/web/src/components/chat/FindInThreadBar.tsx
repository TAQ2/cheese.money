import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * The conversation's find bar — query, position, and the two steps.
 *
 * It owns no search state: the query, the match list and which match is active
 * all live with the conversation, because revealing a match means unfolding and
 * scrolling the timeline, which is not this component's business.
 */
export const FindInThreadBar = memo(function FindInThreadBar(props: {
  readonly query: string;
  readonly matchCount: number;
  /** Position of the active match, 1-based. Zero when nothing matches. */
  readonly activePosition: number;
  /**
   * Changes every time the shortcut is pressed. Pressing it again with the bar
   * already open selects what is in the field, the way a browser's find does,
   * so a second search replaces the first by typing.
   */
  readonly focusToken: number;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { focusToken } = props;
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusToken]);

  // Escape closes the bar from anywhere in the conversation, not only from the
  // field. A reader who clicked into the transcript to select a line is still
  // looking at highlights, and the key that clears them has to be the same one.
  const { onClose } = props;
  useEffect(() => {
    // `globalThis.` because React's `KeyboardEvent` is the one imported here.
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [onClose]);

  const hasQuery = props.query.trim().length > 0;
  const noMatches = hasQuery && props.matchCount === 0;

  // Escape is not handled here: the capture-phase listener above already has
  // it, for the whole conversation rather than just this field. Two handlers
  // for one key is the second path that later disagrees with the first.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      props.onStep(event.shiftKey ? -1 : 1);
    }
  };

  return (
    <div
      className="absolute end-3 top-2 z-30 flex items-center gap-1 rounded-lg border border-border/70 bg-card/95 px-1.5 py-1 shadow-md backdrop-blur-sm sm:end-5"
      role="search"
    >
      <Input
        ref={inputRef}
        size="sm"
        nativeInput
        aria-label="Find in conversation"
        placeholder="Find in conversation"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        className={noMatches ? "w-52 text-destructive" : "w-52"}
      />
      {/* Announced, because stepping matches moves the view but not the focus:
          without this a screen reader reports nothing at all on Enter. */}
      <span
        aria-live="polite"
        aria-atomic="true"
        className="min-w-16 shrink-0 select-none px-1 text-center text-muted-foreground text-xs tabular-nums"
      >
        {hasQuery ? `${props.activePosition} of ${props.matchCount}` : ""}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={props.matchCount === 0}
        onClick={() => props.onStep(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={props.matchCount === 0}
        onClick={() => props.onStep(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close find bar"
        onClick={props.onClose}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
});
