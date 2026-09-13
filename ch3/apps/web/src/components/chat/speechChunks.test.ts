import { SPEECH_MAX_RAW_TEXT_CHARS, SPEECH_MAX_TEXT_CHARS } from "@ch3tools/contracts";
import { maxSpokenLength } from "@ch3tools/shared/spokenText";
import { describe, expect, it } from "vite-plus/test";

import { splitForSpeech } from "./speechChunks";

describe("splitForSpeech", () => {
  it("leaves something short alone", () => {
    expect(splitForSpeech("Short enough to say in one breath.")).toEqual([
      "Short enough to say in one breath.",
    ]);
  });

  it("says nothing about nothing", () => {
    expect(splitForSpeech("   \n  ")).toEqual([]);
    expect(splitForSpeech("")).toEqual([]);
  });

  it("says nothing about text that speaks to nothing", () => {
    // A reply that is only a file path cleans away entirely. Offering a part
    // for it means a press that the server answers with "nothing is left to
    // read", which is a worse answer than not offering the press.
    expect(splitForSpeech("/Users/someone/Downloads/CH3/apps/web/src/main.tsx")).toEqual([]);
  });

  it("keeps every part within the SPOKEN limit the server enforces", () => {
    // The shape that broke it: ordinary prose, where cleaning removes almost
    // nothing. Sized against the raw ceiling, part one of this document
    // arrives at the server as far more speakable characters than it accepts.
    const document = Array.from({ length: 400 }, (_, index) =>
      `## Section ${index}\n\nSome analysis about section ${index}. `.repeat(4),
    ).join("\n\n");
    expect(document.length).toBeGreaterThan(SPEECH_MAX_RAW_TEXT_CHARS * 3);

    const parts = splitForSpeech(document);
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(SPEECH_MAX_RAW_TEXT_CHARS);
      expect(maxSpokenLength(part)).toBeLessThanOrEqual(SPEECH_MAX_TEXT_CHARS);
    }
  });

  it("fills a part with markdown the listener never hears", () => {
    // The other side of the same rule: a reply that is mostly fenced code
    // cleans down to a cue, so it must NOT be cut as if every character were
    // going to be spoken. One request, not four.
    const codeHeavy = `Here is the change.\n\n\`\`\`ts\n${"const x = 1;\n".repeat(700)}\`\`\`\n\nThat is all.`;
    expect(codeHeavy.length).toBeGreaterThan(SPEECH_MAX_TEXT_CHARS);
    expect(splitForSpeech(codeHeavy)).toHaveLength(1);
  });

  it("loses nothing but the whitespace at the seams", () => {
    const document = Array.from({ length: 50 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
    const parts = splitForSpeech(document, { raw: 60 });
    // Rejoining is what proves it is a split rather than a truncation, which is
    // the failure that would be invisible: the listener simply never hears the
    // end and has no way to know.
    expect(parts.join("\n\n")).toBe(document);
  });

  it("cuts between paragraphs rather than mid-sentence", () => {
    const document = `${"a".repeat(50)}\n\n${"b".repeat(50)}\n\n${"c".repeat(50)}`;
    const parts = splitForSpeech(document, { raw: 120 });
    expect(parts[0]).toBe(`${"a".repeat(50)}\n\n${"b".repeat(50)}`);
    expect(parts[1]).toBe("c".repeat(50));
  });

  it("falls back to a sentence end when there is no blank line", () => {
    const document = `${"Sentence one is here. ".repeat(6)}${"Sentence two is here. ".repeat(6)}`;
    const parts = splitForSpeech(document, { raw: 80 });
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(80);
    }
    // Ends on a sentence, so the listener hears a full thought before the gap.
    expect(parts[0]?.endsWith(".")).toBe(true);
  });

  it("cuts by length when the text offers no break at all", () => {
    const blob = "x".repeat(500);
    const parts = splitForSpeech(blob, { raw: 100 });
    expect(parts).toHaveLength(5);
    expect(parts.every((part) => part.length === 100)).toBe(true);
    expect(parts.join("")).toBe(blob);
  });

  it("obeys the spoken ceiling even when the request ceiling is far higher", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(200);
    const parts = splitForSpeech(prose, { raw: 9_000, spoken: 500 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(maxSpokenLength(part)).toBeLessThanOrEqual(500);
    }
    expect(parts.join(" ")).toBe(prose.trim());
  });
});
