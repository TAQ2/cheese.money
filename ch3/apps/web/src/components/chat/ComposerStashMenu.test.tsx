import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashMenu } from "./ComposerStashMenu";

const noop = () => {};

describe("ComposerStashMenu", () => {
  it("offers a labelled close control in the panel header, empty or not", () => {
    // The bug: ⌘S was the only exit anyone found. Escape worked and was
    // invisible, so the panel read as stuck — and it reads that way hardest
    // on the empty state, which is the first thing a new user opens.
    const empty = renderToStaticMarkup(
      <ComposerStashMenu entries={[]} onRestore={noop} onDelete={noop} onClose={noop} />,
    );

    expect(empty).toContain('aria-label="Close stashed prompts"');
    // A real button: reachable by Tab, activated by Enter and Space, and
    // announced as a control rather than as decoration.
    expect(empty).toContain('type="button"');
    expect(empty).not.toContain('aria-label="Close stashed prompts" disabled');

    const withEntries = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "stash-1",
            prompt: "a stashed prompt",
            attachments: [],
            droppedImageNames: [],
            createdAt: "2026-09-11T00:00:00.000Z",
          },
        ]}
        onRestore={noop}
        onDelete={noop}
        onClose={noop}
      />,
    );

    expect(withEntries).toContain('aria-label="Close stashed prompts"');
    // The per-row delete control is a different control with a different
    // label; the close button must not be mistaken for it.
    expect(withEntries).toContain('aria-label="Delete stashed prompt"');
  });
});
