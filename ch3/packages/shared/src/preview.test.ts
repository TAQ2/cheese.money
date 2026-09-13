import { describe, expect, it } from "vite-plus/test";

import {
  isLoopbackHost,
  isPreviewableUrl,
  newPreviewTabId,
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
} from "./preview.ts";

describe("newPreviewTabId", () => {
  it("returns a unique tab id every call", () => {
    const a = newPreviewTabId();
    const b = newPreviewTabId();
    expect(a).not.toBe(b);
    expect(a.startsWith("tab_")).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["example.com", "192.168.1.10", "10.0.0.1", ""])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("isPreviewableUrl", () => {
  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:3000/path",
    "http://0.0.0.0:8080",
    "http://[::1]:5173",
  ])("%s is previewable", (url) => {
    expect(isPreviewableUrl(url)).toBe(true);
  });

  it.each(["https://example.com", "ws://localhost:5173", "file:///etc/passwd", "not-a-url", ""])(
    "%s is not previewable",
    (url) => {
      expect(isPreviewableUrl(url)).toBe(false);
    },
  );
});

describe("normalizePreviewUrl", () => {
  it("treats bare loopback hosts as http", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("treats bare public hosts as https", () => {
    expect(normalizePreviewUrl("example.com")).toBe("https://example.com/");
  });

  it("respects explicit schemes", () => {
    expect(normalizePreviewUrl("https://localhost:5173")).toBe("https://localhost:5173/");
    expect(normalizePreviewUrl("http://example.com/path?q=1")).toBe("http://example.com/path?q=1");
  });

  it.each([
    ["/tmp/report.html", "file:///tmp/report.html"],
    [
      "/Users/conradws/Downloads/Credit Risk Review - September 2026 - Notion.html",
      "file:///Users/conradws/Downloads/Credit%20Risk%20Review%20-%20September%202026%20-%20Notion.html",
    ],
    [
      "/Users/conradws/Downloads/Credit Risk Review – September 2026 #1 ?x.html",
      "file:///Users/conradws/Downloads/Credit%20Risk%20Review%20%E2%80%93%20September%202026%20%231%20%3Fx.html",
    ],
    ["/", "file:///"],
    // A literal `%` in a filename must not be read as the start of an escape,
    // and `file:` being a special scheme must not turn a backslash into a separator.
    ["/tmp/Report%20final.pdf", "file:///tmp/Report%2520final.pdf"],
    ["/tmp/a\\b.html", "file:///tmp/a%5Cb.html"],
  ])("turns the absolute path %s into a file URL", (path, expected) => {
    expect(normalizePreviewUrl(path)).toBe(expected);
  });

  it("accepts a file URL, so the value the URL bar shows can be resubmitted", () => {
    expect(normalizePreviewUrl("file:///tmp/report.html")).toBe("file:///tmp/report.html");
    expect(
      normalizePreviewUrl(
        "file:///Users/conradws/Downloads/Credit%20Risk%20Review%20%E2%80%93%202026.html",
      ),
    ).toBe("file:///Users/conradws/Downloads/Credit%20Risk%20Review%20%E2%80%93%202026.html");
  });

  it("keeps host and scheme inputs on the URL path rather than reading them as paths", () => {
    expect(normalizePreviewUrl("//example.com")).toBe("https://example.com/");
    expect(normalizePreviewUrl("https://x.dev/p?q=1")).toBe("https://x.dev/p?q=1");
  });

  it("rejects empty input", () => {
    try {
      normalizePreviewUrl("   ");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect("cause" in (error as object)).toBe(false);
    }
  });

  it("rejects a UNC file URL, which names a host rather than a local path", () => {
    const rawUrl = "file://server/share/x.html";
    try {
      normalizePreviewUrl(rawUrl);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "file:",
      });
    }
  });

  it("rejects unsupported protocols", () => {
    try {
      normalizePreviewUrl("ftp://example.com");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: "ftp://example.com".length,
        reason: "unsupported-protocol",
        protocol: "ftp:",
      });
    }
  });

  it("rejects unparseable input without retaining credentials or tokens", () => {
    const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
    try {
      normalizePreviewUrl(rawUrl);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect((error as PreviewUrlNormalizationError).cause).toBeInstanceOf(Error);
      expect((error as PreviewUrlNormalizationError).message).not.toContain(
        ((error as PreviewUrlNormalizationError).cause as Error).message,
      );
      expect((error as PreviewUrlNormalizationError).message).not.toMatch(
        /user|password|access_token|secret|fragment/,
      );
    }
  });
});
