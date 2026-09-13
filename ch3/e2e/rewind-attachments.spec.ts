/**
 * Editing a message brings the message's images back with it.
 *
 * "Edit and resend" is a rewind: the thread truncates to that message and the
 * edited prompt is sent again. It carried the text alone, so a message sent
 * with a screenshot reopened without it, the screenshot had to be found and
 * attached by hand, and nothing on screen said it had gone — the agent
 * answering a prompt about a picture it could not see was the first sign.
 *
 * The seed's last turn (`LONG_CONVERSATION.attachmentTurn`) is the one message
 * with a real attachment behind it — a row that names it and a file on disk —
 * so every count below is exact.
 */
import type { Page } from "@playwright/test";

import { LONG_CONVERSATION as L } from "../scripts/visual/fixtures.ts";
import { test, expect } from "./fixtures.ts";

const dialog = (page: Page) => page.getByTestId("rewind-dialog");
const draftText = (page: Page) => dialog(page).getByRole("textbox");
/** The chip for the restored image, and the control that takes it away. */
const restoredImage = (page: Page) => dialog(page).getByRole("img", { name: L.attachmentName });
const removeRestoredImage = (page: Page) =>
  dialog(page).getByRole("button", { name: `Remove ${L.attachmentName}` });

test.beforeEach(async ({ page, stack }) => {
  await page.goto(`/${stack.environmentId}/${stack.longThreadId}`);
  // A reopened conversation lands at its end, which is where the turn seeded
  // with an attachment sits.
  await expect(page.locator(`[data-message-id="${L.answerMessageId(L.turnCount)}"]`)).toBeVisible();
  const row = page.locator(`[data-message-id="${L.requestMessageId(L.attachmentTurn)}"]`);
  await row.hover();
  await row.getByRole("button", { name: "Edit and resend this message" }).click();
  await expect(dialog(page)).toBeVisible();
});

test("the dialog opens with the message's own image already attached", async ({ page }) => {
  await expect(restoredImage(page)).toHaveCount(1);
  // Beside the text it was sent with, not instead of it.
  await expect(draftText(page)).toHaveValue(new RegExp(`^Step ${String(L.attachmentTurn)}: `, "u"));
});

test("the restored image is removable, like one attached by hand", async ({ page }) => {
  await removeRestoredImage(page).click();
  await expect(restoredImage(page)).toHaveCount(0);

  // Removed for good. Nothing puts it back while the dialog stays on the same
  // message, or the remove button would be a lie — so the edit sends the text
  // alone, which is what the user just asked for.
  await draftText(page).fill("Announce it, and skip the screenshot this time.");
  await expect(restoredImage(page)).toHaveCount(0);
});

test("choosing a different message leaves the first message's image behind", async ({ page }) => {
  await expect(restoredImage(page)).toHaveCount(1);

  // The list runs newest first, so the second row is the turn before the one
  // that carries the image, and it carries none.
  await dialog(page).getByRole("radio").nth(1).check();
  await expect(draftText(page)).toHaveValue(
    new RegExp(`^Step ${String(L.attachmentTurn - 1)}: `, "u"),
  );
  await expect(restoredImage(page)).toHaveCount(0);
});
