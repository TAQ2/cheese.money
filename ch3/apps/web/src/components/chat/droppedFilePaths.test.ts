import { describe, expect, it } from "vite-plus/test";

import {
  composerTextForDroppedPaths,
  fileUriToPath,
  formatPathForComposer,
  resolveDroppedFilePaths,
} from "./droppedFilePaths";

/** A File stand-in: only `name` is read, and jsdom's File needs no real bytes. */
const file = (name: string): File => new File([], name);

describe("fileUriToPath", () => {
  it("percent-decodes, which is the whole point for real filenames", () => {
    // The file that exposed this: spaces, parentheses, an underscore and an
    // ampersand. Pasted still-encoded, every later `open` on it fails.
    expect(
      fileUriToPath(
        "file:///Users/Conrad/Books/Mary%20Beard%20-%20Women%20%26%20Power_%20A%20Manifesto%20(2017,%20Liveright).epub",
      ),
    ).toBe("/Users/Conrad/Books/Mary Beard - Women & Power_ A Manifesto (2017, Liveright).epub");
  });

  it("ignores anything that is not a local file URL", () => {
    expect(fileUriToPath("https://example.com/x.pdf")).toBeNull();
    expect(fileUriToPath("/Users/Conrad/x.pdf")).toBeNull();
    expect(fileUriToPath("file://server/share/x.pdf")).toBe("/share/x.pdf");
  });

  it("refuses a malformed escape rather than pasting the raw form", () => {
    expect(fileUriToPath("file:///Users/Conrad/%E0%A4%A.pdf")).toBeNull();
  });
});

describe("resolveDroppedFilePaths", () => {
  it("prefers the Electron bridge, which is exact per file", () => {
    const result = resolveDroppedFilePaths({
      files: [file("a.epub"), file("b.pdf")],
      uriList: "file:///wrong/a.epub\nfile:///wrong/b.pdf",
      getPathForFile: (f) => `/exact/${f.name}`,
    });
    expect(result.paths).toEqual(["/exact/a.epub", "/exact/b.pdf"]);
    expect(result.unresolved).toEqual([]);
  });

  it("falls back to the drag's uri-list when no bridge exists", () => {
    // The browser build has no preload; without this path it would have nothing
    // to offer and the drop would still be a dead end.
    const result = resolveDroppedFilePaths({
      files: [file("a.epub")],
      uriList: "# comment\nfile:///Users/Conrad/a.epub\n",
    });
    expect(result.paths).toEqual(["/Users/Conrad/a.epub"]);
  });

  it("does not attribute a mismatched uri-list entry to a file", () => {
    // A drag carrying unrelated URLs must not make us claim the wrong path —
    // an agent would then read a file the user never dropped.
    const result = resolveDroppedFilePaths({
      files: [file("a.epub")],
      uriList: "file:///Users/Conrad/something-else.pdf",
    });
    expect(result.paths).toEqual([]);
    expect(result.unresolved).toEqual(["a.epub"]);
  });

  it("reports files whose path cannot be established", () => {
    const result = resolveDroppedFilePaths({ files: [file("pasted.bin")] });
    expect(result.paths).toEqual([]);
    expect(result.unresolved).toEqual(["pasted.bin"]);
  });

  it("de-duplicates the same path dropped twice", () => {
    const result = resolveDroppedFilePaths({
      files: [file("a.epub"), file("a.epub")],
      getPathForFile: () => "/Users/Conrad/a.epub",
    });
    expect(result.paths).toEqual(["/Users/Conrad/a.epub"]);
  });
});

describe("formatPathForComposer", () => {
  it("leaves an already-safe path bare", () => {
    expect(formatPathForComposer("/Users/Conrad/notes.md")).toBe("/Users/Conrad/notes.md");
  });

  it("quotes what a shell would otherwise re-interpret", () => {
    // These paths get handed to agents that run commands with them; spaces,
    // parentheses and & each change the meaning of an unquoted word.
    expect(formatPathForComposer("/Users/Conrad/Women & Power (2017).epub")).toBe(
      "'/Users/Conrad/Women & Power (2017).epub'",
    );
  });

  it("survives an apostrophe in the name", () => {
    expect(formatPathForComposer("/Users/Conrad/Reader's Digest.pdf")).toBe(
      `'/Users/Conrad/Reader'\\''s Digest.pdf'`,
    );
  });

  it("writes one path per line", () => {
    expect(composerTextForDroppedPaths(["/a/b.txt", "/c d/e.txt"])).toBe("/a/b.txt\n'/c d/e.txt'");
  });
});
