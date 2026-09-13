import { describe, expect, it } from "@effect/vitest";

import { prepareSpokenText } from "./spokenText.ts";

describe("prepareSpokenText", () => {
  it("replaces fenced code blocks with a spoken cue", () => {
    const spoken = prepareSpokenText(
      "Here is the fix:\n```ts\nconst x = 1;\nconsole.log(x);\n```\nDone.",
    );
    expect(spoken).toContain("Code block omitted.");
    expect(spoken).not.toContain("const x");
    expect(spoken).toContain("Done.");
  });

  it("swallows an unterminated fence to the end", () => {
    const spoken = prepareSpokenText("Look:\n```\nsecret code\nmore code");
    expect(spoken).not.toContain("secret code");
  });

  it("keeps inline code content without the backticks", () => {
    expect(prepareSpokenText("Set `speechVoice` in the store.")).toBe(
      "Set speechVoice in the store.",
    );
  });

  it("keeps link text and drops the target", () => {
    expect(prepareSpokenText("See [the docs](https://example.com/a/b) for more.")).toBe(
      "See the docs for more.",
    );
  });

  it("drops bare URLs", () => {
    expect(prepareSpokenText("Deployed to https://example.com/x now.")).toBe("Deployed to now.");
  });

  it("reads a table row as its cells", () => {
    const spoken = prepareSpokenText("| Name | Count |\n| --- | --- |\n| clips | 12 |");
    expect(spoken).toContain("Name, Count");
    expect(spoken).toContain("clips, 12");
    expect(spoken).not.toContain("|");
    expect(spoken).not.toContain("---");
  });

  it("strips heading, emphasis and quote notation but keeps the words", () => {
    expect(prepareSpokenText("## The **bold** _plan_\n> quoted line")).toBe(
      "The bold plan\nquoted line",
    );
  });

  it("strips bullet markers but keeps the items", () => {
    expect(prepareSpokenText("- first thing\n- second thing")).toBe("first thing\nsecond thing");
  });

  it("drops lines that are only a file path", () => {
    const spoken = prepareSpokenText(
      "The change lives here:\n/Users/someone/project/src/main.ts:42\nand it works.",
    );
    expect(spoken).not.toContain("/Users");
    expect(spoken).toContain("and it works.");
  });

  it("returns an empty string for a reply that is nothing but code", () => {
    expect(prepareSpokenText("```\nonly code\n```")).toBe("Code block omitted.");
    expect(prepareSpokenText("/a/path/only.ts")).toBe("");
  });

  it("does not let a fence mentioned mid-sentence swallow the reply", () => {
    const spoken = prepareSpokenText(
      "Wrap it in ``` to make a fence. Then run the build and check the output, which should be green.",
    );
    expect(spoken).toContain("should be green");
    expect(spoken).not.toContain("Code block omitted");
  });

  it("recognises tilde fences and indented code runs", () => {
    expect(prepareSpokenText("Look:\n~~~\nhidden\n~~~\nDone.")).not.toContain("hidden");
    const indented = prepareSpokenText(
      "Here:\n    const a = 1;\n    const b = 2;\n    const c = 3;\nAfter.",
    );
    expect(indented).not.toContain("const a");
    expect(indented).toContain("After.");
  });

  it("strips heading markers inside blockquotes", () => {
    expect(prepareSpokenText("> ## Title\n> body")).toBe("Title\nbody");
  });

  it("leaves math, snake_case names and prose pipes alone", () => {
    expect(prepareSpokenText("The area is 2*3*4 square metres.")).toBe(
      "The area is 2*3*4 square metres.",
    );
    expect(prepareSpokenText("Set the speech_voice_spanish column to null.")).toBe(
      "Set the speech_voice_spanish column to null.",
    );
    expect(prepareSpokenText("Run cat file | grep x now.")).toBe("Run cat file | grep x now.");
  });

  it("still strips real emphasis at word boundaries", () => {
    expect(prepareSpokenText("This is *important* and **very bold** indeed.")).toBe(
      "This is important and very bold indeed.",
    );
  });

  it("removes terminal colour codes and control characters", () => {
    expect(prepareSpokenText("Output: \u001b[31mred\u001b[0m done.")).toBe("Output: red done.");
    expect(prepareSpokenText("a\u0000b\u0008c\u000bd")).toBe("abcd");
  });

  it("drops HTML tags and autolinks but keeps their content", () => {
    expect(prepareSpokenText("<div>hello</div> and <https://example.com/docs> end")).toBe(
      "hello and end",
    );
  });

  it("keeps reference-link text", () => {
    expect(prepareSpokenText("See [the docs][1] for more.")).toBe("See the docs for more.");
  });

  it("collapses adjacent code blocks into one cue", () => {
    const spoken = prepareSpokenText("```\na\n```\n```\nb\n```\n```\nc\n```");
    expect(spoken).toBe("Code block omitted.");
  });

  it("speaks the cue in Spanish for Spanish replies", () => {
    expect(prepareSpokenText("Aquí está:\n```\ncode\n```", "es")).toBe(
      "Aquí está:\nBloque de código omitido.",
    );
  });

  it("collapses runs of blank lines left by the removals", () => {
    expect(prepareSpokenText("start\n\n\n\n\nend")).toBe("start\n\nend");
  });
});
