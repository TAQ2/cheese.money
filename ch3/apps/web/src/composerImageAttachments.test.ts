import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@ch3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acceptComposerImageFiles,
  composerImageFileFromAttachment,
} from "./composerImageAttachments";

const image = (name: string) => new File(["x"], name, { type: "image/png" });
const notAnImage = (name: string) => new File(["x"], name, { type: "application/pdf" });

describe("acceptComposerImageFiles", () => {
  it("accepts images and names the file it turned away", () => {
    const { accepted, error } = acceptComposerImageFiles({
      files: [image("a.png"), notAnImage("notes.pdf"), image("b.png")],
      alreadyReserved: 0,
    });

    expect(accepted.map((file) => file.name)).toEqual(["a.png", "b.png"]);
    // The name matters: "unsupported file type" alone leaves someone who
    // dropped six files guessing which one was refused.
    expect(error).toContain("notes.pdf");
  });

  it("counts slots already spoken for, not just what is in this batch", () => {
    // The caller passes attached images PLUS anything still compressing, which
    // is what stops two concurrent pastes each seeing the same free slots.
    const { accepted, error } = acceptComposerImageFiles({
      files: [image("a.png"), image("b.png")],
      alreadyReserved: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(accepted).toHaveLength(1);
    expect(error).toContain(String(PROVIDER_SEND_TURN_MAX_ATTACHMENTS));
  });

  it("stops at the cap rather than accepting and failing later", () => {
    const { accepted } = acceptComposerImageFiles({
      files: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 3 }, (_, index) =>
        image(`${index}.png`),
      ),
      alreadyReserved: 0,
    });
    expect(accepted).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  });

  it("says nothing when everything was accepted", () => {
    const { accepted, error } = acceptComposerImageFiles({
      files: [image("a.png")],
      alreadyReserved: 0,
    });
    expect(accepted).toHaveLength(1);
    expect(error).toBeNull();
  });

  it("takes no slots for an empty pick", () => {
    expect(acceptComposerImageFiles({ files: [], alreadyReserved: 0 })).toEqual({
      accepted: [],
      error: null,
    });
  });
});

describe("composerImageFileFromAttachment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const attachment = { name: "screenshot.png", mimeType: "image/png" };

  it("rebuilds the file a sent message carried, under its own name and type", async () => {
    // Editing a message is a rewind that resends it, and it used to resend the
    // text alone: every screenshot on the original was dropped silently and
    // had to be found and attached again.
    vi.stubGlobal("fetch", async () => new Response("pixels", { status: 200 }));

    const file = await composerImageFileFromAttachment("https://host/assets/a1", attachment);

    expect(file?.name).toBe("screenshot.png");
    expect(file?.type).toBe("image/png");
    expect(await file?.text()).toBe("pixels");
  });

  it("gives up on the one image, not the edit, when the asset is gone", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    expect(await composerImageFileFromAttachment("https://host/assets/a1", attachment)).toBeNull();
  });

  it("does the same when the fetch itself throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("asset url expired");
    });

    expect(await composerImageFileFromAttachment("https://host/assets/a1", attachment)).toBeNull();
  });
});
