import { EnvironmentId, ThreadId } from "@ch3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const isPreviewSupportedInRuntime = vi.fn(() => true);
const applyPreviewServerSnapshot = vi.fn();
const rememberPreviewUrl = vi.fn();
const openBrowser = vi.fn();
const resolveAssetUrl = vi.fn((base: string, relative: string) => `${base}${relative}`);

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot,
  isPreviewSupportedInRuntime,
  rememberPreviewUrl,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser }) },
}));
vi.mock("~/assets/assetUrls", () => ({ resolveAssetUrl }));

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const openPreview = vi.fn(async () =>
  AsyncResult.success({
    threadId: "thread-1",
    tabId: "tab_1",
    navStatus: { _tag: "Idle" as const },
    canGoBack: false,
    canGoForward: false,
    viewport: { _tag: "Fill" as const },
    updatedAt: "2026-09-03T00:00:00.000Z",
  }),
);

const createAssetUrl = vi.fn(async () =>
  AsyncResult.success({ relativeUrl: "/api/assets/tok/report.html" }),
);

const LOCAL_HTTP_BASE_URL = "http://127.0.0.1:3773";
const REMOTE_HTTP_BASE_URL = "http://100.65.180.100:3773";

const open = async (filePath: string, httpBaseUrl = LOCAL_HTTP_BASE_URL) => {
  const { openFileInPreview } = await import("./openFileInPreview");
  return openFileInPreview({
    threadRef,
    filePath,
    httpBaseUrl,
    createAssetUrl: createAssetUrl as never,
    openPreview: openPreview as never,
  });
};

describe("canOpenFileInBrowserPreview", () => {
  it.each([
    ["/Users/me/docs/CCR-20260903-001-notes.md", LOCAL_HTTP_BASE_URL, true],
    ["/Users/me/report.html", LOCAL_HTTP_BASE_URL, true],
    ["/Users/me/Reports/2026 plan.pdf", LOCAL_HTTP_BASE_URL, true],
    ["/Users/me/src/main.ts", LOCAL_HTTP_BASE_URL, true],
    // Relative — the caller failed to resolve it against the project root, and
    // a browser cannot guess what it is relative to.
    ["docs/notes.md", LOCAL_HTTP_BASE_URL, false],
    // A UNC share names no local path.
    ["\\\\server\\share\\notes.md", LOCAL_HTTP_BASE_URL, false],
    // The path is on the environment's disk, not this window's.
    ["/Users/me/docs/notes.md", REMOTE_HTTP_BASE_URL, false],
    // ...but a workspace html is served by the environment, so it still travels.
    ["/Users/me/project/report.html", REMOTE_HTTP_BASE_URL, true],
  ])("%s on %s -> %s", async (filePath, httpBaseUrl, expected) => {
    const { canOpenFileInBrowserPreview } = await import("./openFileInPreview");
    expect(canOpenFileInBrowserPreview(filePath, httpBaseUrl)).toBe(expected);
  });
});

describe("openFileInPreview", () => {
  beforeEach(() => {
    isPreviewSupportedInRuntime.mockReturnValue(true);
    openPreview.mockClear();
    createAssetUrl.mockClear();
    openBrowser.mockClear();
    rememberPreviewUrl.mockClear();
  });

  it("opens a non-servable local file as a file URL in the thread's preview tab", async () => {
    const result = await open("/Users/me/docs/CCR-20260903-001-notes.md");

    expect(result._tag).toBe("Success");
    expect(createAssetUrl).not.toHaveBeenCalled();
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { threadId: "thread-1", url: "file:///Users/me/docs/CCR-20260903-001-notes.md" },
    });
    expect(openBrowser).toHaveBeenCalledWith(threadRef, "tab_1");
  });

  it("percent-encodes a local path the way the URL bar does", async () => {
    await open("/Users/me/change requests/2026 notes#1.md");

    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        threadId: "thread-1",
        url: "file:///Users/me/change%20requests/2026%20notes%231.md",
      },
    });
  });

  it("still serves a workspace html file over the signed asset URL", async () => {
    await open("/Users/me/project/report.html");

    expect(createAssetUrl).toHaveBeenCalledOnce();
    expect(openPreview).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        threadId: "thread-1",
        url: "http://127.0.0.1:3773/api/assets/tok/report.html",
      },
    });
  });

  it("never opens a remote environment's path as a file URL in this window", async () => {
    // The environment owns the disk that path names, so the file route is off
    // and the request stays on the asset route the environment serves.
    await open("/Users/me/docs/notes.md", REMOTE_HTTP_BASE_URL);

    expect(createAssetUrl).toHaveBeenCalledOnce();
    expect(openPreview).not.toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ url: expect.stringMatching(/^file:/) }),
      }),
    );
  });

  it("fails without navigating when the runtime has no preview", async () => {
    isPreviewSupportedInRuntime.mockReturnValue(false);

    const result = await open("/Users/me/docs/notes.md");

    expect(result._tag).toBe("Failure");
    expect(openPreview).not.toHaveBeenCalled();
  });
});
