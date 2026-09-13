import { EnvironmentId, ThreadId } from "@ch3tools/contracts";
import { scopeThreadRef } from "@ch3tools/client-runtime/environment";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerQueuedSendAttachments, ComposerQueuedSends } from "./ComposerQueuedSends";
import type { QueuedSendEntry } from "../../queuedSendStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

function entry(id: string, text: string): QueuedSendEntry {
  return {
    id,
    ref: threadRef,
    tracksDraft: false,
    snapshot: {
      text,
      prompt: text,
      images: [],
      modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
      runtimeMode: "approval-required",
      interactionMode: "default",
      hasSendableContent: true,
      interactiveBuiltin: null,
      draftSignature: text,
    },
  };
}

describe("ComposerQueuedSends", () => {
  it("renders nothing when the queue holds no frozen messages", () => {
    expect(
      renderToStaticMarkup(
        <ComposerQueuedSends entries={[]} threadRef={threadRef} skills={[]} onRestore={() => {}} />,
      ),
    ).toBe("");
  });

  it("gives every stacked message its own spinner and its own way out", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedSends
        entries={[entry("a", "first"), entry("b", "second")]}
        threadRef={threadRef}
        skills={[]}
        onRestore={() => {}}
      />,
    );

    // Two rows, and the labels are numbered: a screen reader hearing "Bring
    // queued message back" three times over cannot tell which one it is on.
    expect(markup.split('data-composer-queued-send="true"')).toHaveLength(3);
    expect(markup).toContain('aria-label="Bring queued message 1 back to the composer"');
    expect(markup).toContain('aria-label="Bring queued message 2 back to the composer"');
    expect(markup).toContain('aria-label="Queued message 1, waiting for the agent to finish"');
    expect(markup).toContain('aria-label="Queued message 2, waiting for the agent to finish"');
  });

  it("renders the X as a button, not a submit — the row lives inside the composer form", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedSends
        entries={[entry("a", "first")]}
        threadRef={threadRef}
        skills={[]}
        onRestore={() => {}}
      />,
    );

    expect(markup).toContain('type="button"');
    expect(markup).not.toContain('type="submit"');
  });
});

describe("ComposerQueuedSendAttachments", () => {
  it("renders nothing when the queued message carried no images", () => {
    expect(renderToStaticMarkup(<ComposerQueuedSendAttachments images={[]} />)).toBe("");
  });

  it("names each frozen attachment and offers no way to remove it", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedSendAttachments
        images={[
          {
            id: "img-1",
            type: "image",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            file: new File([], "screenshot.png"),
            previewUrl: "blob:preview",
          },
        ]}
      />,
    );

    expect(markup).toContain("screenshot.png");
    // Read-only by construction: attaching is wired to the single live draft,
    // so a row that offered a remove button would be lying about what it owns.
    expect(markup).not.toContain("<button");
  });
});
