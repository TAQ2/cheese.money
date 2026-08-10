import {
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type ModelSelection,
} from "@ch3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@ch3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerImageAttachment, ComposerThreadDraftState } from "../composerDraftStore";
import {
  composerDraftSignature,
  type QueuedSendEntry,
  type QueuedSendSnapshot,
} from "../queuedSendStore";
import {
  buildQueuedTurnInput,
  decideQueuedSend,
  selectBackgroundQueuedEntries,
  shouldClearDraftAfterQueuedSend,
} from "./QueuedSendWatcher.logic";

const environmentId = EnvironmentId.make("env-1");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));
const modelSelection = { instanceId: "codex", model: "gpt-5" } as unknown as ModelSelection;

function snapshot(overrides: Partial<QueuedSendSnapshot> = {}): QueuedSendSnapshot {
  return {
    text: "ship it",
    images: [],
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    hasSendableContent: true,
    interactiveBuiltin: null,
    draftSignature: draftSignatureOf({ prompt: "ship it" }),
    ...overrides,
  };
}

function entry(ref: typeof threadA, overrides: Partial<QueuedSendSnapshot> = {}): QueuedSendEntry {
  return { ref, snapshot: snapshot(overrides) };
}

function draft(overrides: Partial<ComposerThreadDraftState> = {}): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    ...overrides,
  };
}

function draftSignatureOf(overrides: Partial<ComposerThreadDraftState> = {}): string {
  return composerDraftSignature(draft(overrides));
}

function image(sizeBytes: number) {
  return { sizeBytes };
}

function draftImage(): ComposerImageAttachment {
  return {
    type: "image",
    id: "img-1",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 10,
    previewUrl: "blob:preview",
    file: new File([], "shot.png"),
  };
}

describe("selectBackgroundQueuedEntries", () => {
  const entries = {
    [scopedThreadKey(threadA)]: entry(threadA, { text: "a" }),
    [scopedThreadKey(threadB)]: entry(threadB, { text: "b" }),
  };

  it("watches an armed thread while a different thread is active", () => {
    const background = selectBackgroundQueuedEntries(entries, scopedThreadKey(threadB));

    expect(background.map(({ threadKey }) => threadKey)).toEqual([scopedThreadKey(threadA)]);
  });

  it("leaves the active thread to its own composer, so it cannot double-send", () => {
    const background = selectBackgroundQueuedEntries(entries, scopedThreadKey(threadA));

    expect(background.map(({ entry: item }) => item.snapshot.text)).toEqual(["b"]);
  });

  it("watches every armed thread when no thread is on screen", () => {
    expect(selectBackgroundQueuedEntries(entries, null)).toHaveLength(2);
  });

  it("watches both armed threads independently", () => {
    expect(selectBackgroundQueuedEntries(entries, scopedThreadKey(threadA))).toHaveLength(1);
    expect(selectBackgroundQueuedEntries({}, null)).toEqual([]);
  });
});

describe("decideQueuedSend", () => {
  const base = {
    hasShell: true,
    phase: "ready" as const,
    text: "ship it",
    images: [],
    hasSendableContent: true,
    interactiveBuiltin: null,
  };

  it("sends once the turn is no longer running", () => {
    expect(decideQueuedSend(base)).toEqual({ kind: "send" });
  });

  it("waits while the turn is still running", () => {
    expect(decideQueuedSend({ ...base, phase: "running" })).toEqual({ kind: "wait" });
  });

  it("waits while the session is reconnecting", () => {
    expect(decideQueuedSend({ ...base, phase: "connecting" })).toEqual({ kind: "wait" });
  });

  it("still sends after a turn that was interrupted or failed", () => {
    // `derivePhase` maps stopped / interrupted / error all to "disconnected".
    expect(decideQueuedSend({ ...base, phase: "disconnected" })).toEqual({ kind: "send" });
  });

  it("stays armed while the thread index is still syncing", () => {
    expect(decideQueuedSend({ ...base, hasShell: false })).toEqual({ kind: "wait" });
  });

  it("drops a draft that was emptied after arming, even though the text is not empty", () => {
    // `buildOutgoingTurnText` substitutes an image-only bootstrap prompt for
    // empty input, so the text alone can never reveal an emptied draft.
    expect(
      decideQueuedSend({
        ...base,
        text: "[User attached one or more images without additional text.]",
        hasSendableContent: false,
      }),
    ).toEqual({ kind: "drop", reason: null });
  });

  it("sends an image-only queue with no text", () => {
    expect(decideQueuedSend({ ...base, text: "", images: [image(1024)] })).toEqual({
      kind: "send",
    });
  });

  it("refuses to post a slash builtin as a message", () => {
    const decision = decideQueuedSend({ ...base, interactiveBuiltin: "clear" });

    expect(decision.kind).toBe("drop");
    expect(decision.kind === "drop" && decision.reason).toContain("/clear");
  });

  it("drops with a reason when the message is longer than the provider accepts", () => {
    const decision = decideQueuedSend({
      ...base,
      text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
    });

    expect(decision.kind).toBe("drop");
    expect(decision.kind === "drop" && decision.reason).toContain("longer than");
  });

  it("drops with a reason when there are too many attachments", () => {
    const decision = decideQueuedSend({
      ...base,
      images: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => image(1)),
    });

    expect(decision.kind).toBe("drop");
    expect(decision.kind === "drop" && decision.reason).toContain("attachments");
  });

  it("drops with a reason when an attachment is too large", () => {
    const decision = decideQueuedSend({
      ...base,
      images: [image(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1)],
    });

    expect(decision.kind).toBe("drop");
    expect(decision.kind === "drop" && decision.reason).toContain("too large");
  });

  it("accepts a payload exactly at the limits", () => {
    expect(
      decideQueuedSend({
        ...base,
        text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
        images: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, () =>
          image(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
        ),
      }),
    ).toEqual({ kind: "send" });
  });
});

describe("buildQueuedTurnInput", () => {
  const messageId = MessageId.make("message-1");
  const createdAt = "2026-08-09T20:00:00.000Z";

  it("carries the composer's modes, not the thread's persisted ones", () => {
    const input = buildQueuedTurnInput({
      entry: entry(threadA, { runtimeMode: "full-access", interactionMode: "plan" }),
      messageId,
      createdAt,
      attachments: [],
    });

    expect(input.interactionMode).toBe("plan");
    expect(input.runtimeMode).toBe("full-access");
  });

  it("sends the frozen text and model selection against the queued thread", () => {
    const input = buildQueuedTurnInput({
      entry: entry(threadA, { text: "frozen text" }),
      messageId,
      createdAt,
      attachments: [],
    });

    expect(input).toMatchObject({
      threadId: threadA.threadId,
      message: { messageId, role: "user", text: "frozen text", attachments: [] },
      modelSelection,
      createdAt,
    });
  });
});

describe("shouldClearDraftAfterQueuedSend", () => {
  const frozen = entry(threadA, { draftSignature: draftSignatureOf({ prompt: "ship it" }) });

  it("clears the draft when it still holds exactly what was sent", () => {
    expect(shouldClearDraftAfterQueuedSend(frozen, draft({ prompt: "ship it" }))).toBe(true);
  });

  it("keeps a draft whose text was edited after the snapshot froze", () => {
    expect(
      shouldClearDraftAfterQueuedSend(frozen, draft({ prompt: "ship it, and the changelog" })),
    ).toBe(false);
  });

  it("keeps an image that finished compressing after the thread went off-screen", () => {
    expect(
      shouldClearDraftAfterQueuedSend(frozen, draft({ prompt: "ship it", images: [draftImage()] })),
    ).toBe(false);
  });

  it("keeps a review comment attached after the snapshot froze", () => {
    // `clearComposerContent` wipes every collection, not just prompt+images.
    expect(
      shouldClearDraftAfterQueuedSend(
        frozen,
        draft({
          prompt: "ship it",
          reviewComments: [
            {
              id: "review-1",
              sectionId: "section-1",
              sectionTitle: "src/app.ts",
              filePath: "src/app.ts",
              startIndex: 1,
              endIndex: 2,
              rangeLabel: "L1-L2",
              text: "look here",
              diff: "- a\n+ b",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("treats a missing draft as already clear", () => {
    expect(shouldClearDraftAfterQueuedSend(frozen, null)).toBe(true);
  });
});
