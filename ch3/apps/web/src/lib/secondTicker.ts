/**
 * One shared 1 Hz ticker for every per-second UI clock (working timers,
 * progress toasts). Subscribers write DOM text or update toasts directly on
 * the tick; the interval exists only while someone is subscribed, so an idle
 * app runs no timer at all.
 */

type SecondTickListener = () => void;

const listeners = new Set<SecondTickListener>();
let intervalId: ReturnType<typeof setInterval> | null = null;

export function subscribeToSecondTicker(listener: SecondTickListener): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      for (const tick of listeners) {
        tick();
      }
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}
