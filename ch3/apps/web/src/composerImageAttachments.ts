/**
 * Turning picked files into composer image attachments.
 *
 * Extracted so the composer is not the only place that can accept an image.
 * The rewind dialog sends a turn without ever passing through the composer's
 * own input, and it needs the identical rules — the same accepted types, the
 * same per-message cap, the same downscale-rather-than-refuse behaviour, the
 * same wording when something is turned away. A second implementation beside
 * this one would drift on the first of those that changed.
 *
 * Split in two on purpose. Validation is synchronous so a caller can reserve
 * its attachment slots before the first `await`, which is what keeps two
 * concurrent pastes from each seeing the other's slots as free. Compression is
 * the slow half and returns finished attachments.
 *
 * @module composerImageAttachments
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ch3tools/contracts";

import type { ComposerImageAttachment } from "./composerDraftStore";
import { compressImageToByteLimit } from "./lib/imageCompression";
import { randomUUID } from "./lib/utils";

/** Which files may be attached, and why the rest were turned away. */
export function acceptComposerImageFiles(input: {
  readonly files: ReadonlyArray<File>;
  /**
   * Slots already spoken for — attached images plus any still compressing.
   * Counted by the caller because only it knows what else is in flight.
   */
  readonly alreadyReserved: number;
}): { readonly accepted: File[]; readonly error: string | null } {
  let reserved = input.alreadyReserved;
  const accepted: File[] = [];
  let error: string | null = null;
  for (const file of input.files) {
    if (!file.type.startsWith("image/")) {
      error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
      continue;
    }
    if (reserved >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
      break;
    }
    accepted.push(file);
    reserved += 1;
  }
  return { accepted, error };
}

/**
 * Compress what was accepted and build the attachments.
 *
 * Images over the wire cap are downscaled to fit rather than refused; files
 * already within it pass through byte-for-byte. Each attachment carries an
 * object URL for its thumbnail, so **every caller must revoke them** — on send,
 * on removal, and when whatever holds them is dismissed.
 */
export async function compressComposerImageFiles(
  files: ReadonlyArray<File>,
): Promise<{ readonly images: ComposerImageAttachment[]; readonly error: string | null }> {
  const images: ComposerImageAttachment[] = [];
  let error: string | null = null;
  for (const file of files) {
    const compressed = await compressImageToByteLimit(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (!compressed.ok) {
      error =
        compressed.reason === "unreadable"
          ? `'${file.name}' could not be read as an image.`
          : `'${file.name}' is too large to attach, even after compression.`;
      continue;
    }
    const attachmentFile = compressed.file;
    images.push({
      type: "image",
      id: randomUUID(),
      name: attachmentFile.name || "image",
      mimeType: attachmentFile.type,
      sizeBytes: attachmentFile.size,
      previewUrl: URL.createObjectURL(attachmentFile),
      file: attachmentFile,
    });
  }
  return { images, error };
}

/**
 * The file behind one image a sent message carried.
 *
 * Editing a message is a rewind that resends it, so it has to start from what
 * was actually sent — text and images both. Only the text was carried, so an
 * edit silently dropped every screenshot and the user had to find and attach
 * it again; there was no sign it had gone until the agent answered without it.
 *
 * The bytes are not in the client: a sent attachment is an id, a name and a
 * size. What the transcript shows it with is an asset URL minted per session,
 * so the caller passes that URL, and what comes back goes through the
 * identical accept-and-compress path a freshly dropped file takes — same cap,
 * same refusals, same remove control.
 *
 * The attachment's own name and type win over whatever the response says: they
 * are what the message was sent with, and they are what the chip in the dialog
 * is labelled with.
 *
 * Null rather than a throw when it cannot be fetched. An image whose asset URL
 * has expired costs the user that one image, never the rest of the edit.
 */
export async function composerImageFileFromAttachment(
  url: string,
  attachment: { readonly name: string; readonly mimeType: string },
): Promise<File | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return new File([await response.blob()], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}
