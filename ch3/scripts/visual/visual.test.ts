import { describe, expect, it } from "@effect/vitest";
import { PNG } from "pngjs";

import { comparePngBuffers } from "./compare.ts";
import { pairingCliArguments, parseDevRunnerAddress, parsePairingCredential } from "./stack.ts";
import { VISUAL_VIEWS } from "./views.ts";

function solidPng(width: number, height: number, color: readonly [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("parseDevRunnerAddress", () => {
  it("reads the ports and base dir out of the startup line", () => {
    const line =
      "[13:31:57.385] INFO (#1): [dev-runner] mode=dev source=hashed CH3CODE_DEV_INSTANCE=visual serverPort=16727 webPort=8687 baseDir=/tmp/ch3-visual/home\n";
    expect(parseDevRunnerAddress(line)).toEqual({
      serverPort: 16_727,
      webPort: 8_687,
      homeDir: "/tmp/ch3-visual/home",
    });
  });

  it("returns null until the line has been logged", () => {
    expect(parseDevRunnerAddress("[dev-runner] resolving ports")).toBeNull();
  });
});

describe("parsePairingCredential", () => {
  it("ignores the node SQLite warning printed before the JSON", () => {
    const output = `(node:1) ExperimentalWarning: SQLite is an experimental feature\n{\n  "id": "abc",\n  "credential": "S9DAH5AAGCMP"\n}\n`;
    expect(parsePairingCredential(output)).toBe("S9DAH5AAGCMP");
  });

  it("fails loudly when no credential came back", () => {
    expect(() => parsePairingCredential("boom")).toThrow(/no JSON/);
    expect(() => parsePairingCredential('{"id":"abc"}')).toThrow(/no credential/);
  });
});

describe("pairingCliArguments", () => {
  it("addresses an explicit home via --base-dir", () => {
    expect(
      pairingCliArguments({ stateDir: "/tmp/visual/home/userdata", webUrl: "http://localhost:1" }),
    ).toEqual(["--base-dir", "/tmp/visual/home"]);
  });

  it("addresses the default dev state dir via --dev-url", () => {
    expect(
      pairingCliArguments({
        stateDir: "/Users/dev/.ch3/dev",
        webUrl: "http://localhost:5734",
        defaultHomeDir: "/Users/dev/.ch3",
      }),
    ).toEqual(["--dev-url", "http://localhost:5734"]);
  });

  it("refuses a dev state dir under a non-default home, which no flag can reach", () => {
    expect(
      pairingCliArguments({
        stateDir: "/tmp/other/dev",
        webUrl: "http://localhost:1",
        defaultHomeDir: "/Users/dev/.ch3",
      }),
    ).toBeNull();
  });
});

describe("comparePngBuffers", () => {
  it("reports identical images as unchanged", () => {
    const image = solidPng(4, 4, [10, 20, 30]);
    const result = comparePngBuffers(image, image);
    expect(result.sameSize).toBe(true);
    expect(result.changedPixels).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it("ignores channel noise below the tolerance", () => {
    const result = comparePngBuffers(solidPng(4, 4, [10, 20, 30]), solidPng(4, 4, [20, 30, 40]));
    expect(result.changedPixels).toBe(0);
  });

  it("counts pixels that moved further than the tolerance", () => {
    const result = comparePngBuffers(solidPng(4, 4, [0, 0, 0]), solidPng(4, 4, [255, 255, 255]));
    expect(result.changedPixels).toBe(16);
    expect(result.ratio).toBe(1);
    expect(result.diffImage).not.toBeNull();
  });

  it("flags a size change instead of diffing mismatched buffers", () => {
    const result = comparePngBuffers(solidPng(4, 4, [0, 0, 0]), solidPng(8, 4, [0, 0, 0]));
    expect(result.sameSize).toBe(false);
    expect(result.diffImage).toBeNull();
  });
});

describe("VISUAL_VIEWS", () => {
  it("keeps view ids unique (they name the baseline files)", () => {
    const ids = VISUAL_VIEWS.map((view) => view.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every view at least one structural check", () => {
    for (const view of VISUAL_VIEWS) {
      expect(view.checks.length).toBeGreaterThan(0);
    }
  });
});
