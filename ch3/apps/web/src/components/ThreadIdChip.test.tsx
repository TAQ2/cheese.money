import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadIdChip } from "./ThreadIdChip";

const THREAD_ID = "0d6e2f18-1c4a-4a3b-9d2e-77b0a1c9f4e5";

describe("ThreadIdChip", () => {
  it("shows the first block and carries the whole id where it can be read", () => {
    const markup = renderToStaticMarkup(<ThreadIdChip threadId={THREAD_ID} />);

    expect(markup).toContain(">0d6e2f18<");
    // The short form is a label, not the value: both the tooltip and the
    // accessible name have to name the id somebody is actually going to paste.
    expect(markup).toContain(`Copy conversation id ${THREAD_ID}`);
    expect(markup).toContain(`Conversation ${THREAD_ID}`);
  });

  it("keeps a fixed width, so copying cannot reflow the row it sits on", () => {
    const markup = renderToStaticMarkup(<ThreadIdChip threadId={THREAD_ID} />);
    expect(markup).toContain("w-[4.25rem]");
  });

  it("is a button, because the rows it sits on open a conversation when clicked", () => {
    const markup = renderToStaticMarkup(<ThreadIdChip threadId={THREAD_ID} />);
    expect(markup).toContain('type="button"');
  });
});
