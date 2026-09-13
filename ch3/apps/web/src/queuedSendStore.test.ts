import { EnvironmentId, ThreadId, type ModelSelection } from "@ch3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@ch3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  claimQueuedSend,
  selectDraftQueueCancelled,
  selectHandledReleaseCount,
  selectDraftQueuedSend,
  selectQueuedDispatchInFlight,
  selectQueuedSends,
  useQueuedSendStore,
  type QueuedSendSnapshot,
} from "./queuedSendStore";

const environmentId = EnvironmentId.make("env-1");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));

const modelSelection = { instanceId: "codex", model: "gpt-5" } as unknown as ModelSelection;

/**
 * The `session.updatedAt` a claim is taken against, and the one the server
 * replaces it with. Real values from the drain that motivated the gate: the
 * turn ended at `.123`, and the `starting` the first send provoked was stamped
 * `.261` — but three messages had already gone out by `.436`, every one of them
 * still reading `.123`.
 */
const SESSION_AT_CLAIM = "2026-09-04T20:16:22.123Z";
const SESSION_AFTER_SEND = "2026-09-04T20:16:22.261Z";

function snapshot(text: string): QueuedSendSnapshot {
  return {
    text,
    prompt: text,
    images: [],
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    hasSendableContent: true,
    interactiveBuiltin: null,
    draftSignature: text,
  };
}

const store = () => useQueuedSendStore.getState();
const queueFor = (ref: typeof threadA) => selectQueuedSends(store().entriesByThreadKey, ref);
const textsFor = (ref: typeof threadA) => queueFor(ref).map((entry) => entry.snapshot.text);

/** Arms `text` and immediately stacks it, the way the composer's `+` does. */
function stackMessage(ref: typeof threadA, text: string) {
  store().arm(ref, snapshot(text));
  store().stack(ref);
}

describe("queuedSendStore", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("arms and removes per thread ref", () => {
    store().arm(threadA, snapshot("hello"));
    expect(Object.keys(store().entriesByThreadKey)).toHaveLength(1);

    store().remove(threadB, queueFor(threadA)[0]!.id);
    expect(Object.keys(store().entriesByThreadKey)).toHaveLength(1);

    store().remove(threadA, queueFor(threadA)[0]!.id);
    expect(store().entriesByThreadKey).toEqual({});
  });

  it("keeps two armed threads independent", () => {
    store().arm(threadA, snapshot("a"));
    store().arm(threadB, snapshot("b"));

    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)?.snapshot.text).toBe("a");
    expect(claimQueuedSend(threadB, SESSION_AT_CLAIM)?.snapshot.text).toBe("b");
  });

  it("refreshes the live draft entry so what is queued is what is on screen", () => {
    store().arm(threadA, snapshot("first"));
    store().refresh(threadA, snapshot("edited"));

    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)?.snapshot.text).toBe("edited");
  });

  it("ignores a refresh for a thread with nothing queued", () => {
    store().refresh(threadA, snapshot("ghost"));

    expect(store().entriesByThreadKey).toEqual({});
  });

  it("claims exactly once, so two release paths cannot double-send", () => {
    store().arm(threadA, snapshot("only once"));

    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)?.snapshot.text).toBe("only once");
    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)).toBeNull();
  });

  it("returns null when claiming a thread that was never armed", () => {
    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)).toBeNull();
  });

  describe("stacking", () => {
    it("appends each armed message behind the ones already queued", () => {
      stackMessage(threadA, "first");
      stackMessage(threadA, "second");
      store().arm(threadA, snapshot("third"));

      expect(textsFor(threadA)).toEqual(["first", "second", "third"]);
    });

    it("gives every entry its own id, so a repeated message is still two rows", () => {
      stackMessage(threadA, "again");
      store().arm(threadA, snapshot("again"));

      const ids = queueFor(threadA).map((entry) => entry.id);
      expect(new Set(ids).size).toBe(2);
    });

    it("refreshes only the tail, leaving stacked entries frozen", () => {
      stackMessage(threadA, "first");
      store().arm(threadA, snapshot("second"));

      store().refresh(threadA, snapshot("second, edited"));

      // The whole point: without this, every keystroke would rewrite every
      // queued message into the one being typed.
      expect(textsFor(threadA)).toEqual(["first", "second, edited"]);
    });

    it("stops refreshing an entry once it has been stacked", () => {
      store().arm(threadA, snapshot("first"));
      store().stack(threadA);

      store().refresh(threadA, snapshot("what the composer holds now"));

      expect(textsFor(threadA)).toEqual(["first"]);
    });

    it("only the tail is ever the live draft", () => {
      stackMessage(threadA, "first");
      store().arm(threadA, snapshot("second"));

      expect(queueFor(threadA).map((entry) => entry.tracksDraft)).toEqual([false, true]);
      expect(selectDraftQueuedSend(store().entriesByThreadKey, threadA)?.snapshot.text).toBe(
        "second",
      );
    });

    it("reports no live draft entry once the tail is stacked", () => {
      stackMessage(threadA, "first");

      expect(selectDraftQueuedSend(store().entriesByThreadKey, threadA)).toBeNull();
    });
  });

  describe("editing a queued message", () => {
    it("edits the targeted entry and leaves its siblings untouched", () => {
      stackMessage(threadA, "first");
      stackMessage(threadA, "second");
      stackMessage(threadA, "third");
      const [first, second, third] = queueFor(threadA);

      store().updateQueuedText(threadA, second!.id, "second, rewritten");

      const entries = queueFor(threadA);
      expect(entries.map((entry) => entry.snapshot.text)).toEqual([
        "first",
        "second, rewritten",
        "third",
      ]);
      // Identity, not just equality: an untouched row must not re-render or
      // lose its editor selection because a sibling was typed into.
      expect(entries[0]).toBe(first);
      expect(entries[2]).toBe(third);
    });

    it("keeps everything but the message of the entry it edits", () => {
      stackMessage(threadA, "first");
      const before = queueFor(threadA)[0]!;

      store().updateQueuedText(threadA, before.id, "first, rewritten");

      const after = queueFor(threadA)[0]!;
      expect(after.id).toBe(before.id);
      // `prompt` moves with `text`, deliberately: what the row now says is the
      // message, so it is also what comes back if the row is taken out of the
      // queue and handed to the composer.
      expect(after.snapshot.text).toBe("first, rewritten");
      expect(after.snapshot.prompt).toBe("first, rewritten");
      expect({
        ...after.snapshot,
        text: before.snapshot.text,
        prompt: before.snapshot.prompt,
      }).toEqual(before.snapshot);
    });

    it("ignores an edit aimed at an entry that is already gone", () => {
      stackMessage(threadA, "first");
      const before = store().entriesByThreadKey;

      store().updateQueuedText(threadA, "no-such-entry", "ghost");

      expect(store().entriesByThreadKey).toBe(before);
    });
  });

  describe("removing one of several", () => {
    it("preserves the order of the rest", () => {
      stackMessage(threadA, "first");
      stackMessage(threadA, "second");
      stackMessage(threadA, "third");

      store().remove(threadA, queueFor(threadA)[1]!.id);

      expect(textsFor(threadA)).toEqual(["first", "third"]);
    });

    it("drops the thread's key rather than leaving an empty queue behind", () => {
      stackMessage(threadA, "first");

      store().remove(threadA, queueFor(threadA)[0]!.id);

      expect(scopedThreadKey(threadA) in store().entriesByThreadKey).toBe(false);
    });
  });

  describe("releasing", () => {
    it("claims the head and leaves the rest queued, in order", () => {
      stackMessage(threadA, "first");
      stackMessage(threadA, "second");
      store().arm(threadA, snapshot("third"));

      expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)?.snapshot.text).toBe("first");
      expect(textsFor(threadA)).toEqual(["second", "third"]);
    });

    it("drops the thread's key when the last entry is claimed", () => {
      stackMessage(threadA, "only");

      claimQueuedSend(threadA, SESSION_AT_CLAIM);

      expect(scopedThreadKey(threadA) in store().entriesByThreadKey).toBe(false);
      expect(store().entriesByThreadKey).toEqual({});
    });

    it("counts a claim but not a cancel, so the composer can tell them apart", () => {
      const key = scopedThreadKey(threadA);
      stackMessage(threadA, "first");
      stackMessage(threadA, "second");

      store().remove(threadA, queueFor(threadA)[0]!.id);
      expect(store().releaseCountByThreadKey[key] ?? 0).toBe(0);

      claimQueuedSend(threadA, SESSION_AT_CLAIM);
      expect(store().releaseCountByThreadKey[key]).toBe(1);
    });
  });

  describe("selectQueuedSends", () => {
    it("hands an unarmed thread one shared empty queue, not a fresh array", () => {
      expect(selectQueuedSends(store().entriesByThreadKey, threadA)).toBe(
        selectQueuedSends(store().entriesByThreadKey, threadB),
      );
      expect(selectQueuedSends(store().entriesByThreadKey, null)).toEqual([]);
    });
  });
});

describe("the dispatch gate", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("marks the thread while a claimed entry is on its way to the server", () => {
    // Claiming does not make the thread look busy: `phase` only leaves `ready`
    // once a server event has come back, and the next entry's watcher mounts
    // in the same synchronous pass. Without this every stacked message went
    // out at once.
    stackMessage(threadA, "first");
    stackMessage(threadA, "second");
    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AT_CLAIM),
    ).toBe(false);

    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)?.snapshot.text).toBe("first");
    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AT_CLAIM),
    ).toBe(true);
    expect(textsFor(threadA)).toEqual(["second"]);
  });

  it("holds the gate while the session still reads as it did at the claim", () => {
    // The bug this exists for: the RPC ack beats the session projection, so a
    // gate released on the ack reopens while `phase` is still the stale
    // `ready` from before the send. Three queued messages went out as three
    // turns in 175 ms that way. An ack is not evidence; a moved session is.
    stackMessage(threadA, "first");
    stackMessage(threadA, "second");
    claimQueuedSend(threadA, SESSION_AT_CLAIM);

    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AT_CLAIM),
    ).toBe(true);
  });

  it("lets the next entry go once the server reports past the claim", () => {
    stackMessage(threadA, "first");
    stackMessage(threadA, "second");
    claimQueuedSend(threadA, SESSION_AT_CLAIM);

    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AFTER_SEND),
    ).toBe(false);
    expect(claimQueuedSend(threadA, SESSION_AFTER_SEND)?.snapshot.text).toBe("second");
  });

  it("lets the next entry go when the send failed and the session never moved", () => {
    // A send that never reached the server never moves the session, so nothing
    // would ever expire the mark. Without the hand-release the rest of the
    // queue is stranded for good.
    stackMessage(threadA, "first");
    stackMessage(threadA, "second");
    claimQueuedSend(threadA, SESSION_AT_CLAIM);
    store().finishQueuedDispatch(threadA);

    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AT_CLAIM),
    ).toBe(false);
    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)?.snapshot.text).toBe("second");
  });

  it("gates a thread that has no session projection yet", () => {
    // `null` is not "nothing to wait for". A thread that has never reported a
    // session cannot have reported the turn just started on it either.
    stackMessage(threadA, "first");
    stackMessage(threadA, "second");
    claimQueuedSend(threadA, null);

    expect(selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, null)).toBe(true);
    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AFTER_SEND),
    ).toBe(false);
  });

  it("does not drain a three-deep queue into one turn while the session is stale", () => {
    // The reported bug, reproduced: `/pr-description`, `/refresh` and `/clea`
    // left as three `turn-start-requested` commands 43 ms and 132 ms apart,
    // and the server folded all three into the turn already starting. Every
    // one of them was released against the same pre-send session reading.
    stackMessage(threadA, "/pr-description");
    stackMessage(threadA, "/refresh");
    stackMessage(threadA, "/clea");

    const sent: string[] = [];
    // The drain loop the watcher runs: claim the head whenever the gate looks
    // open. The session never moves, because the projection has not landed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AT_CLAIM)) {
        continue;
      }
      const claimed = claimQueuedSend(threadA, SESSION_AT_CLAIM);
      if (claimed !== null) sent.push(claimed.snapshot.text);
    }

    expect(sent).toEqual(["/pr-description"]);
    expect(textsFor(threadA)).toEqual(["/refresh", "/clea"]);
  });

  it("gates one thread without gating another", () => {
    stackMessage(threadA, "a1");
    stackMessage(threadB, "b1");
    claimQueuedSend(threadA, SESSION_AT_CLAIM);
    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AT_CLAIM),
    ).toBe(true);
    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadB, SESSION_AT_CLAIM),
    ).toBe(false);
  });

  it("finishing a thread that was never dispatching changes nothing", () => {
    const before = store().dispatchingByThreadKey;
    store().finishQueuedDispatch(threadA);
    expect(store().dispatchingByThreadKey).toBe(before);
  });
});

describe("editing a queued row's text", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("stops being sendable when it is emptied", () => {
    // It used to keep the composer's original verdict, so a row edited down to
    // nothing still said "yes": an empty user message was recorded on the
    // thread and the provider then refused the turn.
    stackMessage(threadA, "first");
    const [entry] = queueFor(threadA);
    expect(entry).toBeDefined();
    store().updateQueuedText(threadA, entry!.id, "   ");
    expect(queueFor(threadA)[0]?.snapshot.hasSendableContent).toBe(false);
  });

  it("stays sendable with no text when it carries an image", () => {
    const withImage: QueuedSendSnapshot = {
      ...snapshot("look at this"),
      images: [{ id: "i1" } as unknown as QueuedSendSnapshot["images"][number]],
    };
    store().arm(threadA, withImage);
    store().stack(threadA);
    const [entry] = queueFor(threadA);
    store().updateQueuedText(threadA, entry!.id, "");
    expect(queueFor(threadA)[0]?.snapshot.hasSendableContent).toBe(true);
  });

  it("becomes sendable again when text is typed back in", () => {
    stackMessage(threadA, "first");
    const [entry] = queueFor(threadA);
    store().updateQueuedText(threadA, entry!.id, "");
    store().updateQueuedText(threadA, entry!.id, "second thoughts");
    expect(queueFor(threadA)[0]?.snapshot.hasSendableContent).toBe(true);
  });
});

describe("a cancelled draft queue", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      cancelledDraftByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("is remembered per thread, so leaving and returning cannot undo it", () => {
    // It used to live in a composer ref that reset on a thread switch and died
    // on unmount: cancel a message, leave the thread, and an entry ahead of it
    // put the message back and sent it.
    store().noteDraftQueueCancelled(threadA);
    expect(selectDraftQueueCancelled(store().cancelledDraftByThreadKey, threadA)).toBe(true);
    expect(selectDraftQueueCancelled(store().cancelledDraftByThreadKey, threadB)).toBe(false);
  });

  it("is retired when the user arms that thread again", () => {
    store().noteDraftQueueCancelled(threadA);
    store().arm(threadA, snapshot("changed my mind"));
    expect(selectDraftQueueCancelled(store().cancelledDraftByThreadKey, threadA)).toBe(false);
  });

  it("survives an unrelated thread arming", () => {
    store().noteDraftQueueCancelled(threadA);
    store().arm(threadB, snapshot("other thread"));
    expect(selectDraftQueueCancelled(store().cancelledDraftByThreadKey, threadA)).toBe(true);
  });
});

describe("the composer's own release, while an entry ahead is in flight", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      cancelledDraftByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("is exactly the state the gate has to catch", () => {
    // On the ACTIVE thread the watcher still dispatches a frozen head — it
    // skips only a head that tracks the draft (selectBackgroundQueuedEntries).
    // So: one frozen entry ahead, the composer's own draft queued behind it.
    stackMessage(threadA, "frozen ahead");
    store().arm(threadA, snapshot("my draft"));

    const stackedBefore = queueFor(threadA).filter((e) => !e.tracksDraft).length;
    expect(stackedBefore).toBe(1);

    // The watcher claims the frozen head.
    expect(claimQueuedSend(threadA, SESSION_AT_CLAIM)?.snapshot.text).toBe("frozen ahead");

    // Now the composer sees nothing stacked ahead of it, and `phase` is still
    // `ready` because no server event has come back yet — so every condition
    // it used to check is satisfied and it would send alongside the message
    // that just went out. The dispatch gate is the only thing left saying no.
    const stackedAfter = queueFor(threadA).filter((e) => !e.tracksDraft).length;
    expect(stackedAfter).toBe(0);
    expect(
      selectQueuedDispatchInFlight(store().dispatchingByThreadKey, threadA, SESSION_AT_CLAIM),
    ).toBe(true);
  });
});

describe("the release count the composer has handled", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      cancelledDraftByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("reads as unseen for a thread this tab has never had a queue on", () => {
    // Unseen is not zero: a thread with releases behind it must have them
    // adopted, or the composer's first render reads them all as new.
    expect(selectHandledReleaseCount(store().handledReleaseByThreadKey, threadA)).toBe(null);
  });

  it("survives the composer leaving the thread, so a stack's last message is not stranded", () => {
    // The bug this exists for: + freezes the message above and hands back an
    // UNQUEUED composer, which the next release re-arms. Leave the thread and
    // the release lands with nothing mounted. Held in a ref, the count was
    // adopted on the way back and the release was never seen — the bottom
    // message sat in the composer forever, never queued.
    stackMessage(threadA, "run the tests");
    store().noteQueueReleaseHandled(threadA, 0);

    // The composer unmounts. The watcher sends the frozen entry.
    claimQueuedSend(threadA, SESSION_AT_CLAIM);
    const released = store().releaseCountByThreadKey[scopedThreadKey(threadA)] ?? 0;
    expect(released).toBe(1);

    // Back on the thread: the release is still visibly unhandled.
    expect(selectHandledReleaseCount(store().handledReleaseByThreadKey, threadA)).toBe(0);
    expect(
      released > (selectHandledReleaseCount(store().handledReleaseByThreadKey, threadA) ?? 0),
    ).toBe(true);
  });

  it("keeps one thread's history out of another's", () => {
    store().noteQueueReleaseHandled(threadA, 3);
    expect(selectHandledReleaseCount(store().handledReleaseByThreadKey, threadA)).toBe(3);
    expect(selectHandledReleaseCount(store().handledReleaseByThreadKey, threadB)).toBe(null);
  });
});

describe("editing a queued row that carries an effort marker", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      cancelledDraftByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("is not sendable once only the marker is left", () => {
    // `text` is the built outgoing prompt, so a message queued on ultrathink
    // reads `Ultrathink:\n…`. Emptying the row leaves the marker, which is
    // not empty by any string test and is not a message either.
    store().arm(threadA, snapshot("Ultrathink:\nship it"));
    const id = queueFor(threadA)[0]!.id;
    store().updateQueuedText(threadA, id, "Ultrathink:");
    expect(queueFor(threadA)[0]!.snapshot.hasSendableContent).toBe(false);
  });

  it("stays sendable while there is still a prompt under the marker", () => {
    store().arm(threadA, snapshot("Ultrathink:\nship it"));
    const id = queueFor(threadA)[0]!.id;
    store().updateQueuedText(threadA, id, "Ultrathink:\nship it now");
    expect(queueFor(threadA)[0]!.snapshot.hasSendableContent).toBe(true);
  });
});

describe("taking a queued message back into the composer", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      cancelledDraftByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("swaps the composer's draft into the vacated slot, keeping the order", () => {
    // The X used to delete the message outright. It is the one control on a
    // row people reach for when they want to EDIT what they wrote, so it
    // hands the message back instead — and the draft already in the composer
    // takes the slot, so the click costs nothing either way.
    stackMessage(threadA, "first");
    stackMessage(threadA, "second");
    stackMessage(threadA, "third");
    const second = queueFor(threadA)[1]!;

    store().replaceSnapshot(threadA, second.id, snapshot("what was in the composer"));

    expect(textsFor(threadA)).toEqual(["first", "what was in the composer", "third"]);
  });

  it("leaves the queue alone when the entry is already gone", () => {
    stackMessage(threadA, "first");
    const before = store().entriesByThreadKey;

    store().replaceSnapshot(threadA, "no-such-entry", snapshot("ghost"));

    expect(store().entriesByThreadKey).toBe(before);
  });

  it("hands back a message that no longer tracks the draft", () => {
    // The swapped-in entry is frozen: the composer is holding the message it
    // just took back, and a row that still tracked the draft would be rewritten
    // by the next keystroke.
    stackMessage(threadA, "first");
    const first = queueFor(threadA)[0]!;

    store().replaceSnapshot(threadA, first.id, snapshot("swapped in"));

    expect(queueFor(threadA)[0]!.tracksDraft).toBe(false);
  });
});

describe("what an edited row hands back", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({
      entriesByThreadKey: {},
      releaseCountByThreadKey: {},
      dispatchingByThreadKey: {},
      cancelledDraftByThreadKey: {},
      handledReleaseByThreadKey: {},
    });
  });

  it("keeps the effort marker out of the prompt", () => {
    // `prompt` is what goes back in the composer when the row is taken out of
    // the queue. `text` is the built outgoing message, so copying it wholesale
    // hands `Ultrathink:` back as literal text — the thing `prompt` exists to
    // avoid — and the composer would then put the marker on a second time.
    store().arm(threadA, snapshot("Ultrathink:\nship it"));
    const id = queueFor(threadA)[0]!.id;

    store().updateQueuedText(threadA, id, "Ultrathink:\nship it now");

    expect(queueFor(threadA)[0]!.snapshot.text).toBe("Ultrathink:\nship it now");
    expect(queueFor(threadA)[0]!.snapshot.prompt).toBe("ship it now");
  });
});
