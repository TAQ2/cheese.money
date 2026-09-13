import { create } from "zustand";

/**
 * The inbox, deliberately jumbled.
 *
 * Holding the Inbox chip throws the open cards into a random order and holding
 * it again puts them back. It is an Easter egg with a real use: a pile of
 * threads with no obvious first move is a decision, and a shuffle turns that
 * decision into a coin toss you can act on. Nothing about the threads changes
 * — this reorders what is drawn and nothing else.
 *
 * In memory, per tab, and never persisted. A jumbled inbox that survived a
 * reload would stop reading as a prank and start reading as a bug, and the
 * user would have to remember the way out rather than simply reloading into
 * it. Its lifetime is exactly the window it was triggered in.
 */
interface InboxShuffleStoreState {
  /**
   * Thread keys in their jumbled order, or null when the inbox is sane.
   *
   * Null is the whole state machine: the sidebar orders by this when it is a
   * list and leaves its own sort alone when it is not.
   */
  order: ReadonlyArray<string> | null;
  /**
   * Throws these keys into a fresh random order. Repeatable, and different
   * each time.
   *
   * Fewer than two keys cannot be reordered, so the inbox stays sane rather
   * than entering a shuffled state that reordered nothing: the chip would
   * claim to be shuffled, and it would take a second three-second hold to
   * clear a state the user could not see.
   */
  shuffle: (keys: ReadonlyArray<string>, random?: () => number) => void;
  /**
   * Moves these keys to the head of the jumble, last one ending on top.
   *
   * A random order is not a frozen one. A thread that finishes, or that the
   * user marks unread, still has to arrive where attention goes — the top —
   * or the shuffle becomes a place work goes to hide. Each float writes the
   * durable order too, so unshuffling lands on the old order with exactly
   * those threads lifted out of it, which is the rule the inbox already had.
   *
   * A no-op when the inbox is sane: the ordinary float path owns that case.
   */
  floatToTop: (keys: ReadonlyArray<string>) => void;
  /** Puts the inbox back the way it was. */
  restore: () => void;
}

/**
 * Fisher-Yates, with the source of randomness handed in.
 *
 * Injected rather than reached for so a test can pin the permutation: a
 * shuffle asserted against `Math.random` is a test that passes for the wrong
 * reason roughly `1/n!` of the time.
 */
export function shuffleKeys(
  keys: ReadonlyArray<string>,
  random: () => number = Math.random,
): ReadonlyArray<string> {
  const next = [...keys];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = next[index]!;
    next[index] = next[swap]!;
    next[swap] = held;
  }
  return next;
}

export const useInboxShuffleStore = create<InboxShuffleStoreState>((set) => ({
  order: null,
  shuffle: (keys, random) => set({ order: keys.length < 2 ? null : shuffleKeys(keys, random) }),
  floatToTop: (keys) =>
    set((state) => {
      if (state.order === null) return state;
      let next = state.order;
      for (const key of keys) {
        if (!next.includes(key)) continue;
        next = [key, ...next.filter((candidate) => candidate !== key)];
      }
      return next === state.order ? state : { order: next };
    }),
  restore: () => set({ order: null }),
}));
