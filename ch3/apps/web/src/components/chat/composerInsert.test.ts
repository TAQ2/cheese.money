import { describe, expect, it } from "vite-plus/test";

import { composerInsertSeparator } from "./composerInsert";

describe("composerInsertSeparator", () => {
  it("adds nothing to an empty composer, whatever the caller asked for", () => {
    expect(composerInsertSeparator("", "space")).toBe("");
    expect(composerInsertSeparator("", "line")).toBe("");
  });

  it("adds nothing when the caller asked for no boundary", () => {
    // The type-to-focus path appends a single keystroke and must not have a
    // space wedged in front of it.
    expect(composerInsertSeparator("why is", undefined)).toBe("");
  });

  describe("space", () => {
    it("separates a mention from the word before it", () => {
      expect(composerInsertSeparator("look at", "space")).toBe(" ");
    });

    it("leaves whitespace that is already there alone", () => {
      expect(composerInsertSeparator("look at ", "space")).toBe("");
      expect(composerInsertSeparator("look at\n", "space")).toBe("");
      expect(composerInsertSeparator("look at\t", "space")).toBe("");
    });
  });

  describe("line", () => {
    it("breaks out of a half-typed sentence", () => {
      expect(composerInsertSeparator("why is", "line")).toBe("\n");
    });

    it("does not stack a break on a prompt that already ends one", () => {
      expect(composerInsertSeparator("first quote\n", "line")).toBe("");
    });

    it("still breaks after a trailing space, which is not a line break", () => {
      // The "space" rule would call this settled; a block insert would then run
      // onto the end of the previous line.
      expect(composerInsertSeparator("why is ", "line")).toBe("\n");
    });
  });
});
