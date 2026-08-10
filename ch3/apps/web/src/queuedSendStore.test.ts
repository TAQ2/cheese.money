import { EnvironmentId, ThreadId, type ModelSelection } from "@ch3tools/contracts";
import { scopeThreadRef } from "@ch3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { claimQueuedSend, useQueuedSendStore, type QueuedSendSnapshot } from "./queuedSendStore";

const environmentId = EnvironmentId.make("env-1");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));

const modelSelection = { instanceId: "codex", model: "gpt-5" } as unknown as ModelSelection;

function snapshot(text: string): QueuedSendSnapshot {
  return {
    text,
    images: [],
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    hasSendableContent: true,
    interactiveBuiltin: null,
    draftSignature: text,
  };
}

describe("queuedSendStore", () => {
  beforeEach(() => {
    useQueuedSendStore.setState({ entriesByThreadKey: {} });
  });

  it("arms and disarms per thread ref", () => {
    useQueuedSendStore.getState().arm(threadA, snapshot("hello"));
    expect(Object.keys(useQueuedSendStore.getState().entriesByThreadKey)).toHaveLength(1);

    useQueuedSendStore.getState().disarm(threadB);
    expect(Object.keys(useQueuedSendStore.getState().entriesByThreadKey)).toHaveLength(1);

    useQueuedSendStore.getState().disarm(threadA);
    expect(useQueuedSendStore.getState().entriesByThreadKey).toEqual({});
  });

  it("keeps two armed threads independent", () => {
    useQueuedSendStore.getState().arm(threadA, snapshot("a"));
    useQueuedSendStore.getState().arm(threadB, snapshot("b"));

    const claimedA = claimQueuedSend(threadA);
    expect(claimedA?.snapshot.text).toBe("a");
    expect(claimQueuedSend(threadB)?.snapshot.text).toBe("b");
  });

  it("refreshes an armed thread so the live draft is what gets frozen", () => {
    useQueuedSendStore.getState().arm(threadA, snapshot("first"));
    useQueuedSendStore.getState().refresh(threadA, snapshot("edited"));

    expect(claimQueuedSend(threadA)?.snapshot.text).toBe("edited");
  });

  it("ignores a refresh for a thread that is not armed", () => {
    useQueuedSendStore.getState().refresh(threadA, snapshot("ghost"));

    expect(useQueuedSendStore.getState().entriesByThreadKey).toEqual({});
  });

  it("claims exactly once, so two release paths cannot double-send", () => {
    useQueuedSendStore.getState().arm(threadA, snapshot("only once"));

    expect(claimQueuedSend(threadA)?.snapshot.text).toBe("only once");
    expect(claimQueuedSend(threadA)).toBeNull();
  });

  it("returns null when claiming a thread that was never armed", () => {
    expect(claimQueuedSend(threadA)).toBeNull();
  });
});
