import { beforeEach, describe, expect, it } from "vite-plus/test";

import { orderThreadsByManualOrder } from "./components/Sidebar.logic";
import { shuffleKeys, useInboxShuffleStore } from "./inboxShuffleStore";

/** A pinned stream, so a permutation can be asserted rather than described. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const KEYS = ["a", "b", "c", "d", "e", "f"];
const store = () => useInboxShuffleStore.getState();

describe("shuffleKeys", () => {
  it("keeps every key, exactly once", () => {
    // The inbox must not gain or lose a card on the way through: an ordering
    // that drops a key hides a thread, which is a far worse outcome than an
    // ordering the user finds surprising.
    const shuffled = shuffleKeys(KEYS, seededRandom(7));

    expect([...shuffled].sort()).toEqual([...KEYS].sort());
    expect(shuffled).toHaveLength(KEYS.length);
  });

  it("actually moves them", () => {
    // Guards the identity shuffle — a Fisher-Yates with an off-by-one in its
    // bound returns the input untouched and every other test still passes.
    expect(shuffleKeys(KEYS, seededRandom(7))).not.toEqual(KEYS);
  });

  it("gives a different order on a different draw", () => {
    // "Shuffle again and get a different random order" is the whole feature.
    expect(shuffleKeys(KEYS, seededRandom(7))).not.toEqual(shuffleKeys(KEYS, seededRandom(99)));
  });

  it("handles the inbox with nothing in it, and with one card", () => {
    expect(shuffleKeys([], seededRandom(1))).toEqual([]);
    expect(shuffleKeys(["only"], seededRandom(1))).toEqual(["only"]);
  });
});

describe("the inbox shuffle store", () => {
  beforeEach(() => {
    useInboxShuffleStore.setState({ order: null });
  });

  it("starts sane, and null is what says so", () => {
    expect(store().order).toBe(null);
  });

  it("jumbles, then puts it back", () => {
    store().shuffle(KEYS, seededRandom(7));
    expect(store().order).not.toBe(null);
    expect([...store().order!].sort()).toEqual([...KEYS].sort());

    store().restore();
    expect(store().order).toBe(null);
  });

  it("stays sane when there is nothing to reorder", () => {
    // A shuffle of nothing is not a shuffle. An empty array is not null, so
    // without this the chip claims to be shuffled while the list is
    // untouched, and clearing that state costs a second three-second hold.
    store().shuffle([], seededRandom(7));
    expect(store().order).toBe(null);

    store().shuffle(["only-one"], seededRandom(7));
    expect(store().order).toBe(null);
  });
});

describe("the order the sidebar draws while jumbled", () => {
  const thread = (key: string) => ({ key });
  const getKey = (item: { key: string }) => item.key;

  it("draws the open cards in the jumbled order", () => {
    const shuffled = shuffleKeys(KEYS, seededRandom(7));

    const drawn = orderThreadsByManualOrder({
      threads: KEYS.map(thread),
      manualOrder: [...shuffled],
      getKey,
    });

    expect(drawn.map(getKey)).toEqual([...shuffled]);
  });

  it("puts a thread created since the shuffle on top, not in the middle of it", () => {
    // The same rule the manual order follows, and for the same reason: a
    // thread the jumble has never heard of has to arrive where new threads
    // always arrive. Hiding it somewhere inside a random order would make it
    // unfindable by definition.
    const shuffled = shuffleKeys(KEYS, seededRandom(7));

    const drawn = orderThreadsByManualOrder({
      threads: [thread("brand-new"), ...KEYS.map(thread)],
      manualOrder: [...shuffled],
      getKey,
    });

    expect(drawn.map(getKey)).toEqual(["brand-new", ...shuffled]);
  });
});

describe("floating a thread while the inbox is jumbled", () => {
  beforeEach(() => {
    useInboxShuffleStore.setState({ order: null });
  });

  it("moves the thread to the top of the jumble", () => {
    // A random order is not a frozen one: a thread that finishes still has to
    // arrive where attention goes, or the shuffle becomes a place work hides.
    useInboxShuffleStore.setState({ order: ["c", "a", "d", "b"] });

    store().floatToTop(["d"]);

    expect(store().order).toEqual(["d", "c", "a", "b"]);
  });

  it("ends with the last key on top, like the inbox's own float", () => {
    useInboxShuffleStore.setState({ order: ["c", "a", "d", "b"] });

    store().floatToTop(["a", "b"]);

    expect(store().order).toEqual(["b", "a", "c", "d"]);
  });

  it("ignores a key the jumble has never heard of", () => {
    useInboxShuffleStore.setState({ order: ["c", "a"] });
    const before = store().order;

    store().floatToTop(["not-in-the-inbox"]);

    expect(store().order).toBe(before);
  });

  it("does nothing at all when the inbox is sane", () => {
    // The ordinary float path owns that case; two writers on one order is how
    // the list starts fighting itself.
    store().floatToTop(["a"]);

    expect(store().order).toBe(null);
  });
});
