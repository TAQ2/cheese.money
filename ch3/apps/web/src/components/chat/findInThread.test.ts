import { describe, expect, it } from "vite-plus/test";

import type { PreviewAnnotationPayload } from "@ch3tools/contracts";

import { appendElementContextsToPrompt } from "../../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";
import type { TimelineEntry } from "../../session-logic";
import { findMatchesInThread } from "./findInThread";

let sequence = 0;

const message = (role: "user" | "assistant" | "system", text: string): TimelineEntry => {
  sequence += 1;
  const id = `m-${sequence}`;
  return {
    id,
    kind: "message",
    createdAt: "2026-08-12T00:00:00.000Z",
    message: { id, role, text, createdAt: "2026-08-12T00:00:00.000Z" },
  } as unknown as TimelineEntry;
};

const plan = (planMarkdown: string): TimelineEntry => {
  sequence += 1;
  const id = `p-${sequence}`;
  return {
    id,
    kind: "proposed-plan",
    createdAt: "2026-08-12T00:00:00.000Z",
    proposedPlan: { id, planMarkdown, createdAt: "2026-08-12T00:00:00.000Z" },
  } as unknown as TimelineEntry;
};

const work = (label: string): TimelineEntry => {
  sequence += 1;
  const id = `w-${sequence}`;
  return {
    id,
    kind: "work",
    createdAt: "2026-08-12T00:00:00.000Z",
    entry: { id, createdAt: "2026-08-12T00:00:00.000Z", label, tone: "tool" },
  } as unknown as TimelineEntry;
};

describe("findMatchesInThread", () => {
  it("numbers every occurrence inside one message", () => {
    const entry = message("assistant", "the reactor drains, then the reactor emits");
    expect(findMatchesInThread([entry], "reactor")).toEqual([
      { entryId: entry.id, occurrenceIndex: 0 },
      { entryId: entry.id, occurrenceIndex: 1 },
    ]);
  });

  it("returns matches across messages in timeline order", () => {
    const first = message("user", "checkpoint");
    const second = message("assistant", "checkpoint written, checkpoint verified");
    expect(findMatchesInThread([first, second], "checkpoint")).toEqual([
      { entryId: first.id, occurrenceIndex: 0 },
      { entryId: second.id, occurrenceIndex: 0 },
      { entryId: second.id, occurrenceIndex: 1 },
    ]);
  });

  it("matches without regard to case", () => {
    const entry = message("user", "Reactor REACTOR reactor");
    expect(findMatchesInThread([entry], "rEaCtOr")).toHaveLength(3);
  });

  it("has no matches for a blank query", () => {
    const entry = message("user", "anything at all");
    expect(findMatchesInThread([entry], "")).toEqual([]);
    expect(findMatchesInThread([entry], "   ")).toEqual([]);
  });

  it("has no matches for a query longer than the text", () => {
    expect(findMatchesInThread([message("user", "short")], "a much longer query")).toEqual([]);
  });

  it("counts overlapping candidates the way a browser does — non-overlapping", () => {
    const entry = message("assistant", "aaaa");
    expect(findMatchesInThread([entry], "aa")).toEqual([
      { entryId: entry.id, occurrenceIndex: 0 },
      { entryId: entry.id, occurrenceIndex: 1 },
    ]);
  });

  it("searches proposed plans", () => {
    const entry = plan("## Summary\nRebuild the driver boundary");
    expect(findMatchesInThread([entry], "driver")).toEqual([
      { entryId: entry.id, occurrenceIndex: 0 },
    ]);
  });

  it("ignores tool calls and system messages, which the counter cannot honestly hold", () => {
    expect(
      findMatchesInThread([work("reactor drain"), message("system", "reactor booted")], "reactor"),
    ).toEqual([]);
  });

  // The stored text of a user prompt carries what was attached to it — pasted
  // terminal output, picked elements, preview annotations — and the row strips
  // all of it into chips before rendering. The counter must count only what
  // the reader can see, so these fixtures are built by the same producers the
  // composer uses at send time; if a producer's format moves, the row's
  // derivation and this test move with it, and the counter stays honest.
  const previewAnnotation = (comment: string): PreviewAnnotationPayload => ({
    id: `annotation-${comment.length}`,
    pageUrl: "http://localhost:3000/settings",
    pageTitle: "Settings",
    comment,
    elements: [],
    regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-08-12T00:00:00.000Z",
  });

  it("does not count pasted terminal output the reader only sees as a chip", () => {
    const stored = appendTerminalContextsToPrompt("why does the build fail here?", [
      {
        terminalId: "term-1",
        terminalLabel: "zsh",
        lineStart: 1,
        lineEnd: 2,
        text: "npm ERR! ENOENT: no such file or directory\nnpm ERR! enoent",
      },
    ]);
    expect(stored).toContain("ENOENT");
    const entry = message("user", stored);

    expect(findMatchesInThread([entry], "ENOENT")).toEqual([]);
    expect(findMatchesInThread([entry], "build fail")).toEqual([
      { entryId: entry.id, occurrenceIndex: 0 },
    ]);
  });

  it("does not count preview annotations, including a second one stacked behind the first", () => {
    const stored = appendPreviewAnnotationPrompt(
      appendPreviewAnnotationPrompt("tighten the card spacing", previewAnnotation("cards overlap")),
      previewAnnotation("the header overlaps too"),
    );
    expect(stored.match(/<preview_annotation>/g)).toHaveLength(2);
    const entry = message("user", stored);

    expect(findMatchesInThread([entry], "overlap")).toEqual([]);
    expect(findMatchesInThread([entry], "spacing")).toEqual([
      { entryId: entry.id, occurrenceIndex: 0 },
    ]);
  });

  it("does not count a picked element's markup, and still counts the words around it", () => {
    const stored = appendElementContextsToPrompt("make the SubmitButton green", [
      {
        pageUrl: "https://example.com/dashboard",
        pageTitle: "Dashboard",
        tagName: "button",
        selector: "button.submit",
        htmlPreview: '<button class="submit">Save</button>',
        componentName: "SubmitButton",
        source: null,
        styles: ".submit { color: white; }",
      },
    ]);
    expect(stored).toContain("<element_context>");
    const entry = message("user", stored);

    // Once in the prose; the element block's own "SubmitButton" is not on the page.
    expect(findMatchesInThread([entry], "SubmitButton")).toEqual([
      { entryId: entry.id, occurrenceIndex: 0 },
    ]);
    expect(findMatchesInThread([entry], "button.submit")).toEqual([]);
  });

  it("matches accented and non-latin text, case-folding both sides", () => {
    const accented = message("user", "café CAFÉ");
    expect(findMatchesInThread([accented], "café")).toHaveLength(2);

    const cyrillic = message("assistant", "Привет привет");
    expect(findMatchesInThread([cyrillic], "ПРИВЕТ")).toHaveLength(2);

    const emoji = message("user", "ship it 🚀 then ship it 🚀");
    expect(findMatchesInThread([emoji], "🚀")).toHaveLength(2);
  });
});
