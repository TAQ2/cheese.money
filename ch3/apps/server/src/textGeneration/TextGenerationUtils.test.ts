import { describe, expect, it } from "vite-plus/test";

import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";

describe("sanitizeThreadTitle", () => {
  it("keeps a short title untouched", () => {
    expect(sanitizeThreadTitle("Fix statusline rate limits")).toBe("Fix statusline rate limits");
  });

  it("caps a wordy title at six words", () => {
    // A model that ignores the prompt must not be able to flood the sidebar.
    expect(
      sanitizeThreadTitle("Investigate why the statusline stopped rendering plan usage meters"),
    ).toBe("Investigate why the statusline stopped rendering");
  });

  it("still applies the character cap when six words are long", () => {
    const title = sanitizeThreadTitle(
      "Extraordinarily internationalization circumnavigating counterproductive incomprehensibility notwithstanding",
    );
    expect(title.length).toBeLessThanOrEqual(50);
    expect(title.endsWith("...")).toBe(true);
  });

  it("takes the first line only and strips wrapping quotes", () => {
    expect(sanitizeThreadTitle('"Rename threads automatically"\nSecond line')).toBe(
      "Rename threads automatically",
    );
  });

  it("collapses whitespace before counting words", () => {
    expect(sanitizeThreadTitle("  one   two    three  ")).toBe("one two three");
  });

  it("falls back to the default title when empty", () => {
    expect(sanitizeThreadTitle("   ")).toBe("New thread");
  });
});
