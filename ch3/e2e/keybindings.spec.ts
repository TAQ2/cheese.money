/**
 * Settings → Keybindings is where a person learns the shortcut exists. A
 * command that works but is not listed here is undiscoverable; a listing that
 * shows the wrong keys is worse. `chat.findInThread` is the newest binding
 * (3f91e16f) and the one most likely to fall out of a merge.
 */
import { test, expect } from "./fixtures.ts";

test.use({
  // Pre-existing, not this suite's to fix: KeybindingPill in
  // apps/web/src/components/settings/KeybindingsSettings.tsx splits the
  // preview.zoomIn binding `mod++` on "+", which yields two empty parts and
  // therefore two React children keyed "". Remove this entry when that is
  // fixed — the guard will then hold this page to the same standard as every
  // other.
  knownConsoleErrors: {
    "KeybindingPill keys two empty parts of mod++": /Encountered two children with the same key/,
  },
});

test("Settings → Keybindings lists Find in conversation on mod+f", async ({ page }) => {
  await page.goto("/settings/keybindings");
  const command = page.locator('[aria-label="chat.findInThread"]');
  await expect(command).toHaveText("Chat: Find In Thread");

  const row = command.locator("xpath=ancestor::div[contains(@class, 'grid')][1]");
  const shortcut = row.getByRole("button", { name: "Edit shortcut for Chat: Find In Thread" });
  await expect(shortcut).toBeVisible();
  // `mod` renders as the platform's modifier; the keys are read from the same
  // platform the browser reports, so this holds on a Mac and on a Linux runner.
  const isMac = await page.evaluate(() => /mac/i.test(navigator.platform));
  await expect(shortcut.locator("kbd:not(:has(kbd))")).toHaveText([isMac ? "⌘" : "Ctrl", "F"]);
  await expect(row).toContainText("!terminalFocus && !previewFocus");
});
