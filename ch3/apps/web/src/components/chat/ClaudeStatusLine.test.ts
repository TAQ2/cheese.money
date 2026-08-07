import { describe, expect, it } from "vite-plus/test";

import { parseAnsiSpans } from "./ClaudeStatusLine";

const ESC = "\u001b";

describe("parseAnsiSpans", () => {
  it("returns one unstyled span for plain text", () => {
    expect(parseAnsiSpans("hello")).toEqual([{ text: "hello", style: {} }]);
  });

  it("applies 256-color foreground codes", () => {
    const spans = parseAnsiSpans(`${ESC}[38;5;87mrepo${ESC}[0m`);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.text).toBe("repo");
    expect(spans[0]?.style.color).toBe("rgb(95, 255, 255)");
  });

  it("keeps bold and color together, then resets", () => {
    const spans = parseAnsiSpans(`${ESC}[1;38;5;208m#102${ESC}[0m OPEN`);
    expect(spans[0]?.style.fontWeight).toBe("bold");
    expect(spans[0]?.style.color).toBeDefined();
    expect(spans[1]).toEqual({ text: " OPEN", style: {} });
  });

  it("renders dim as reduced opacity so 238-on-dark stays legible", () => {
    const spans = parseAnsiSpans(`${ESC}[2mdim${ESC}[22mbright`);
    expect(spans[0]?.style.opacity).toBe(0.65);
    expect(spans[1]?.style.opacity).toBeUndefined();
  });

  it("supports truecolor", () => {
    const spans = parseAnsiSpans(`${ESC}[38;2;10;20;30mx`);
    expect(spans[0]?.style.color).toBe("rgb(10, 20, 30)");
  });

  it("treats a bare reset sequence as a full reset", () => {
    const spans = parseAnsiSpans(`${ESC}[1mbold${ESC}[mplain`);
    expect(spans[1]?.style.fontWeight).toBeUndefined();
  });

  it("strips non-SGR escapes and control bytes instead of rendering them", () => {
    const spans = parseAnsiSpans(`${ESC}[2Kclean${ESC}[1;5Htext`);
    expect(spans.map((span) => span.text).join("")).toBe("cleantext");
  });

  it("preserves the block-drawing characters a usage bar is made of", () => {
    const spans = parseAnsiSpans(`${ESC}[38;5;67m[████░░░░░░]${ESC}[0m`);
    expect(spans[0]?.text).toBe("[████░░░░░░]");
  });
});
