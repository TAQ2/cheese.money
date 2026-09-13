import { describe, expect, it } from "vite-plus/test";

import { formatPreviewUrl } from "./previewUrlPresentation";

describe("formatPreviewUrl", () => {
  it("formats signed asset URLs with the environment label and decoded filename", () => {
    expect(
      formatPreviewUrl({
        url: "http://127.0.0.1:3773/api/assets/token/architecture%20brief.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("Local environment · architecture brief.pdf");
  });

  it("does not alias assets from another origin", () => {
    expect(
      formatPreviewUrl({
        url: "https://example.com/api/assets/token/report.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("example.com");
  });

  it("formats regular preview URLs as their exact host", () => {
    expect(
      formatPreviewUrl({
        url: "http://127.0.0.1:5173/dashboard",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("127.0.0.1:5173");
  });

  it("shows a local file as the path the user typed, not its percent-encoded form", () => {
    expect(
      formatPreviewUrl({
        url: "file:///tmp/report.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("/tmp/report.pdf");
    expect(
      formatPreviewUrl({
        url: "file:///Users/conradws/Downloads/Credit%20Risk%20Review%20%E2%80%93%20September%202026%20%231.html",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("/Users/conradws/Downloads/Credit Risk Review – September 2026 #1.html");
  });

  it("does not compact a file URL whose path cannot be decoded", () => {
    expect(
      formatPreviewUrl({
        url: "file:///tmp/%E0%A4%A",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBeNull();
  });

  it("does not compact non-http URLs", () => {
    expect(
      formatPreviewUrl({
        url: "ftp://example.com/report.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBeNull();
  });
});
