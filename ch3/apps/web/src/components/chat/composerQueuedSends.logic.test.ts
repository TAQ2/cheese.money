import { describe, expect, it } from "vite-plus/test";

import {
  canComposerReleaseQueuedDraft,
  shouldRearmDraftAfterQueueDrain,
  shouldStackDraftOnEnter,
} from "./composerQueuedSends.logic";

describe("canComposerReleaseQueuedDraft", () => {
  it("releases the draft when it is the only thing queued — the flow before +", () => {
    expect(canComposerReleaseQueuedDraft({ draftIsQueued: true, stackedCount: 0 })).toBe(true);
  });

  it("waits while frozen messages are still ahead of it", () => {
    // Releasing here would send the newest message first and reorder the work
    // the user queued in order.
    expect(canComposerReleaseQueuedDraft({ draftIsQueued: true, stackedCount: 2 })).toBe(false);
  });

  it("releases nothing when the composer's own message is not queued", () => {
    expect(canComposerReleaseQueuedDraft({ draftIsQueued: false, stackedCount: 0 })).toBe(false);
    expect(canComposerReleaseQueuedDraft({ draftIsQueued: false, stackedCount: 1 })).toBe(false);
  });
});

describe("shouldRearmDraftAfterQueueDrain", () => {
  const drained = {
    releaseCount: 1,
    handledReleaseCount: 0,
    cancelledDraftQueue: false,
    draftIsQueued: false,
    stackedCount: 0,
    hasSendableContent: true,
  };

  it("puts the message left in the composer into the emptied queue", () => {
    // The last message of a stack built with + is unqueued by construction:
    // without this it would sit there watching everything above it go out.
    expect(shouldRearmDraftAfterQueueDrain(drained)).toBe(true);
  });

  it("ignores a release it has already reacted to", () => {
    expect(shouldRearmDraftAfterQueueDrain({ ...drained, handledReleaseCount: 1 })).toBe(false);
  });

  it("does nothing when no message has been released", () => {
    // A cancel empties the queue exactly the way a send does. Only a claim
    // moves the count, which is what keeps the queue button from looking
    // broken.
    expect(
      shouldRearmDraftAfterQueueDrain({ ...drained, releaseCount: 0, handledReleaseCount: 0 }),
    ).toBe(false);
  });

  it("respects a draft queue the user switched off by hand", () => {
    expect(shouldRearmDraftAfterQueueDrain({ ...drained, cancelledDraftQueue: true })).toBe(false);
  });

  it("leaves an already-queued draft alone rather than queueing it twice", () => {
    expect(shouldRearmDraftAfterQueueDrain({ ...drained, draftIsQueued: true })).toBe(false);
  });

  it("waits until the queue is actually empty", () => {
    expect(shouldRearmDraftAfterQueueDrain({ ...drained, stackedCount: 1 })).toBe(false);
  });

  it("queues nothing when the composer is empty", () => {
    expect(shouldRearmDraftAfterQueueDrain({ ...drained, hasSendableContent: false })).toBe(false);
  });

  it("does not re-queue the message the composer itself just released", () => {
    // The composer books its own release before `submitComposer` clears the
    // draft, so the draft still reads as sendable at this point. Reacting to
    // it would send the same message twice.
    expect(
      shouldRearmDraftAfterQueueDrain({
        ...drained,
        releaseCount: 1,
        handledReleaseCount: 1,
        hasSendableContent: true,
      }),
    ).toBe(false);
  });
});

describe("shouldStackDraftOnEnter", () => {
  it("joins the queue rather than jumping it", () => {
    // Reported from live use: with a message already queued behind a running
    // turn, Enter sent the next one straight out. It arrived BEFORE the
    // queued one and in the same breath, so the agent read the two as a
    // single message.
    expect(
      shouldStackDraftOnEnter({
        hasQueuedSends: true,
        hasSendableContent: true,
        sendBlocked: false,
      }),
    ).toBe(true);
  });

  it("sends normally when nothing is queued", () => {
    expect(
      shouldStackDraftOnEnter({
        hasQueuedSends: false,
        hasSendableContent: true,
        sendBlocked: false,
      }),
    ).toBe(false);
  });

  it("leaves an empty draft to the submit path, which has its own answer", () => {
    expect(
      shouldStackDraftOnEnter({
        hasQueuedSends: true,
        hasSendableContent: false,
        sendBlocked: false,
      }),
    ).toBe(false);
  });
});

describe("shouldStackDraftOnEnter, when a send is already blocked", () => {
  it("does not stack while the socket is reconnecting or an image is compressing", () => {
    // Enter performs what the + button performs, so it answers to the same
    // gates. Without this Enter froze a snapshot while + sat visibly greyed
    // out beside it, and a snapshot taken mid-compression carries the image
    // array from before the compression finished.
    expect(
      shouldStackDraftOnEnter({
        hasQueuedSends: true,
        hasSendableContent: true,
        sendBlocked: true,
      }),
    ).toBe(false);
  });
});
