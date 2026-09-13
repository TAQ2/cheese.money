import { useEffect, useRef } from "react";

import { subscribeToSecondTicker } from "../../lib/secondTicker";

/**
 * How long something has been running, counted in the reader's own head.
 *
 * Seconds up to a minute, then minutes and seconds, then hours and minutes —
 * the resolution a person actually wants at each scale. `null` when either end
 * is not a timestamp, so a caller can decide what to show instead.
 */
export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

/**
 * A live "for how long" label.
 *
 * It writes its own text node every second instead of re-rendering, because
 * this sits beside a streaming reply and beside a running orchestrator: a React
 * commit per second, for a clock, is the kind of thing our users see as a
 * dropped frame.
 */
export function WorkingTimer({ startedAt, className }: { startedAt: string; className?: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(startedAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(startedAt);
      }
    };
    updateText();
    return subscribeToSecondTicker(updateText);
  }, [startedAt]);

  return (
    <span ref={textRef} className={className ?? "tabular-nums"}>
      {initialText}
    </span>
  );
}
