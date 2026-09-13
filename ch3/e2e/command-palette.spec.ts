/**
 * The command palette and project content search — the two keyboard doors
 * into everything (`mod+k`, `mod+shift+f` in packages/shared/src/keybindings.ts).
 * Thread search goes through the server's `searchThreads`, so a hit on message
 * text — not just a title — proves the whole request/response path, not a
 * client-side filter.
 */
import { test, expect } from "./fixtures.ts";

const palette = (mode: "command" | "content") =>
  `[data-testid="command-palette"][data-palette-mode="${mode}"]`;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("composer-editor")).toBeVisible();
});

test("mod+k opens the palette; a title search navigates to the thread; Escape closes it", async ({
  page,
  stack,
}) => {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(palette("command"))).toBeVisible();
  const input = page.getByPlaceholder("Search commands, projects, and threads...");
  await expect(input).toBeFocused();

  await input.fill("haiku");
  const hit = page
    .locator('[data-slot="command-item"]')
    .filter({ hasText: "Turn hydration warnings into haikus" });
  await expect(hit).toHaveCount(1);
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/${stack.environmentId}/hydration-haikus$`));
  await expect(page.locator(palette("command"))).toHaveCount(0);
  await expect(page.locator('[data-message-role="user"]')).toContainText(
    "Keep hydration errors precise",
  );

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(palette("command"))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(palette("command"))).toHaveCount(0);
});

test("thread search finds message text, not only titles", async ({ page, stack }) => {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder("Search commands, projects, and threads...");
  // Words from a user message in a settled thread whose title shares none of them.
  await input.fill("legible without adding");
  const hit = page
    .locator('[data-slot="command-item"]')
    .filter({ hasText: "Make the OOM killer explain itself" });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText("You:");
  await expect(hit).toContainText("legible without adding");
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/${stack.environmentId}/quieter-oom$`));
});

test("mod+shift+f opens project content search scoped to the active project; Escape closes it", async ({
  page,
}) => {
  await page.keyboard.press("ControlOrMeta+Shift+f");
  const dialog = page.locator(palette("content"));
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder(/^Search in /)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
