/**
 * The "Scroll to end" pill (4bbcd6b1): on a long, virtualised thread a single
 * jump lands where the list ESTIMATES the end to be, and every unmeasured row
 * taller than its estimate leaves the reader short of the real last message
 * while the list believes it is at the end. The pill must reach the last
 * message and hold there.
 */
import { LONG_CONVERSATION as L } from "../scripts/visual/fixtures.ts";
import { test, expect } from "./fixtures.ts";

test("the pill returns the reader to the last message and stays there", async ({ page, stack }) => {
  // Guards 4bbcd6b1 ("Scroll to end" reaches the end of a long thread and
  // stays there), on this tree through the #47 squash (dc4db86f). While every
  // settled turn folded by default, one jump still landed a few hundred pixels
  // short here — a folded turn's row is measured at one height and the fold's
  // estimate at another. With turns open by default (8a963572) the jump lands.
  // If this fails again, look at fold heights before the pill.
  await page.goto(`/${stack.environmentId}/${stack.longThreadId}`);
  const lastAnswer = page.locator(`[data-message-id="${L.answerMessageId(L.turnCount)}"]`);
  await expect(lastAnswer).toBeInViewport();
  const pill = page.getByRole("button", { name: "Scroll to end" });
  await expect(pill).toHaveCount(0);

  // Read back up the thread the way a person does: with the wheel, over the
  // timeline. Far enough that the list has unmounted the end.
  await lastAnswer.hover();
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, -3000);
  }
  await expect(pill).toBeVisible();
  await expect(lastAnswer).toHaveCount(0);

  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect(lastAnswer).toBeInViewport();

  // "Stays there": the list re-measures rows after the jump lands. Two frames
  // later the last message must still be on screen — not a tick of wall-clock
  // time, two layout passes.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(lastAnswer).toBeInViewport();
  await expect(pill).toHaveCount(0);
});
