import { describe, expect, it } from "vite-plus/test";

import { takeFilesFromInput } from "./composerFilePicker";

/** A File stand-in: only `name` is read, and Node's File needs no real bytes. */
const file = (name: string): File => new File([], name);

/**
 * An input stand-in: the unit suite runs on the node environment, so there is
 * no DOM to build a real `<input type="file">` in. Only `files` and `value`
 * are touched.
 */
const input = (files: ReadonlyArray<File> | null, value = "C:\\fakepath\\report.pdf") =>
  ({ files, value }) as unknown as HTMLInputElement;

describe("takeFilesFromInput", () => {
  it("returns the files in selection order", () => {
    const picked = input([file("a.png"), file("report.pdf")]);
    expect(takeFilesFromInput(picked).map((f) => f.name)).toEqual(["a.png", "report.pdf"]);
  });

  it("clears the input so the same file can be picked twice in a row", () => {
    // The regression: a file input fires no `change` when the re-picked file
    // is the one already sitting in its `value`, so the second attach of
    // `report.pdf` would do nothing at all.
    const picked = input([file("report.pdf")]);
    takeFilesFromInput(picked);
    expect(picked.value).toBe("");
  });

  it("clears the input after a cancelled selection too", () => {
    const picked = input([]);
    expect(takeFilesFromInput(picked)).toEqual([]);
    expect(picked.value).toBe("");
  });

  it("survives an input exposing no file list", () => {
    const picked = input(null);
    expect(takeFilesFromInput(picked)).toEqual([]);
    expect(picked.value).toBe("");
  });
});
