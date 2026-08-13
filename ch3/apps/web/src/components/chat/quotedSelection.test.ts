import { describe, expect, it } from "vite-plus/test";

import {
  composerTextForQuotedSelection,
  normalizeQuotedFragment,
  quotableSelectionText,
  runQuotedSelectionContextMenu,
  type QuotableSelection,
  type QuotedSelectionAction,
} from "./quotedSelection";

/** Node stand-ins: only identity is read, through the container's `contains`. */
const insideNode = { id: "inside" } as unknown as Node;
const outsideNode = { id: "outside" } as unknown as Node;
const transcript = { contains: (node: Node | null) => node === insideNode };

const selectionOf = (
  text: string,
  ends: { anchor?: Node | null; focus?: Node | null } = {},
): QuotableSelection => ({
  isCollapsed: text.length === 0,
  anchorNode: ends.anchor ?? insideNode,
  focusNode: ends.focus ?? insideNode,
  toString: () => text,
});

describe("quotableSelectionText", () => {
  it("returns the flat selection when nothing can render it as markdown", () => {
    expect(quotableSelectionText(selectionOf("  a claim  "), transcript)).toBe("  a claim  ");
  });

  it("prefers the transcript's own markdown, which is what carries links and fences", () => {
    // `toString()` on rendered markdown drops the href entirely — quoting a
    // citation without its source is the one thing this feature cannot do.
    expect(
      quotableSelectionText(selectionOf("see the docs"), transcript, () => "see the [docs](/x.md)"),
    ).toBe("see the [docs](/x.md)");
  });

  it("falls back when the serializer renders nothing", () => {
    expect(quotableSelectionText(selectionOf("a claim"), transcript, () => null)).toBe("a claim");
    expect(quotableSelectionText(selectionOf("a claim"), transcript, () => "   ")).toBe("a claim");
  });

  it("does not consult the serializer for a selection it has already rejected", () => {
    let calls = 0;
    quotableSelectionText(selectionOf("x", { anchor: outsideNode }), transcript, () => {
      calls += 1;
      return "should not happen";
    });
    expect(calls).toBe(0);
  });

  it("has nothing to act on without a selection", () => {
    expect(quotableSelectionText(null, transcript)).toBeNull();
    expect(quotableSelectionText(selectionOf(""), transcript)).toBeNull();
    expect(quotableSelectionText(selectionOf("a claim"), null)).toBeNull();
  });

  it("ignores a selection that is only whitespace", () => {
    expect(quotableSelectionText(selectionOf(" \n\t "), transcript)).toBeNull();
  });

  it("refuses a selection with either end outside the transcript", () => {
    // Dragging out of the transcript sweeps up the composer's own draft; the
    // reader did not mean to quote themselves back at the agent.
    expect(quotableSelectionText(selectionOf("x", { focus: outsideNode }), transcript)).toBeNull();
    expect(quotableSelectionText(selectionOf("x", { anchor: outsideNode }), transcript)).toBeNull();
  });
});

describe("normalizeQuotedFragment", () => {
  it("normalises line endings and strips layout whitespace", () => {
    expect(normalizeQuotedFragment("\n  first \r\n\tsecond\t\r third  \n")).toBe(
      "first\n\tsecond\n third",
    );
  });

  it("keeps blank lines between paragraphs", () => {
    expect(normalizeQuotedFragment("one\n\ntwo")).toBe("one\n\ntwo");
  });
});

describe("composerTextForQuotedSelection", () => {
  it("keeps the fragment verbatim, quote characters and all", () => {
    // Escaping would make the quote no longer match the text it was taken
    // from, which is the whole point of quoting it back at the agent.
    expect(composerTextForQuotedSelection('He said "hello"')).toBe(
      'Quoted Text: "He said "hello""\n',
    );
  });

  it("keeps a fenced code block fenced", () => {
    expect(composerTextForQuotedSelection("```ts\nconst a = 1;\n```")).toBe(
      'Quoted Text: "```ts\nconst a = 1;\n```"\n',
    );
  });

  it("ends on a newline, so the reader writes under the quote", () => {
    expect(composerTextForQuotedSelection("  a claim  ")).toBe('Quoted Text: "a claim"\n');
  });

  it("keeps a multi-line quote intact inside the quotes", () => {
    expect(composerTextForQuotedSelection("first\nsecond")).toBe('Quoted Text: "first\nsecond"\n');
  });

  it("contributes nothing when the fragment is blank", () => {
    expect(composerTextForQuotedSelection("   \n  ")).toBe("");
  });
});

describe("runQuotedSelectionContextMenu", () => {
  const harness = (action: QuotedSelectionAction | null) => {
    const quoted: string[] = [];
    const copied: string[] = [];
    const failures: string[] = [];
    const shown: Array<{
      items: readonly { id: string; label: string }[];
      position: { x: number; y: number };
    }> = [];
    return {
      quoted,
      copied,
      failures,
      shown,
      options: {
        fragment: "a claim",
        position: { x: 4, y: 8 },
        showContextMenu: async (
          items: readonly { id: string; label: string }[],
          position: { readonly x: number; readonly y: number },
        ) => {
          shown.push({ items, position: { x: position.x, y: position.y } });
          return action;
        },
        quote: (fragment: string) => quoted.push(fragment),
        copy: async (fragment: string) => copied.push(fragment),
        reportFailure: (operation: string) => failures.push(operation),
      },
    };
  };

  it("offers exactly Quote and Copy, at the click", async () => {
    // Without this, an empty item array would still pass every other test here
    // while the native menu returns immediately — a menu that has already
    // suppressed the platform's own and can then do nothing.
    const h = harness(null);
    await runQuotedSelectionContextMenu(h.options);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]?.items.map((item) => [item.id, item.label])).toEqual([
      ["quote", "Quote"],
      ["copy", "Copy"],
    ]);
    expect(h.shown[0]?.position).toEqual({ x: 4, y: 8 });
  });

  it("quotes the selection when Quote is picked", async () => {
    const h = harness("quote");
    await runQuotedSelectionContextMenu(h.options);
    expect(h.quoted).toEqual(["a claim"]);
    expect(h.copied).toEqual([]);
  });

  it("copies the selection when Copy is picked", async () => {
    const h = harness("copy");
    await runQuotedSelectionContextMenu(h.options);
    expect(h.copied).toEqual(["a claim"]);
    expect(h.quoted).toEqual([]);
  });

  it("does nothing when the menu is dismissed", async () => {
    const h = harness(null);
    await runQuotedSelectionContextMenu(h.options);
    expect(h.quoted).toEqual([]);
    expect(h.copied).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it("reports the menu itself failing, and the action failing, separately", async () => {
    const menuFailures: string[] = [];
    await runQuotedSelectionContextMenu({
      ...harness(null).options,
      showContextMenu: async () => {
        throw new Error("no menu");
      },
      reportFailure: (operation) => menuFailures.push(operation),
    });
    expect(menuFailures).toEqual(["show-selection-context-menu"]);

    const copyFailures: string[] = [];
    await runQuotedSelectionContextMenu({
      ...harness("copy").options,
      copy: async () => {
        throw new Error("clipboard denied");
      },
      reportFailure: (operation) => copyFailures.push(operation),
    });
    expect(copyFailures).toEqual(["copy"]);
  });
});
