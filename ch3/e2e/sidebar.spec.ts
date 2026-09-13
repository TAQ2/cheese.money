/**
 * The seeded data, rendered: both sidebar modes and the kanban board. Counts
 * are exact because the fixture is — a card that goes missing or a shelf that
 * miscounts is a projection or grouping bug, and a minimum would hide it.
 *
 * Fixture arithmetic (scripts/visual/fixtures.ts): 8 showcase threads plus the
 * long conversation = 9. One is snoozed, two more are settled, so the inbox
 * shows 6 active cards, "Snoozed (1)" and "Settled (2)".
 */
import { test, expect } from "./fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("composer-editor")).toBeVisible();
});

test("the inbox shows every active thread and counts the snoozed and settled shelves", async ({
  page,
}) => {
  const inbox = page.getByTestId("sidebar-mode-toggle-inbox");
  await expect(inbox).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("sidebar-v2-row-card")).toHaveCount(6);
  await expect(page.getByTestId("sidebar-v2-snoozed-shelf-toggle")).toHaveText("Snoozed (1)");
  await expect(page.getByTestId("sidebar-v2-settled-shelf-toggle")).toHaveText("Settled (2)");
});

test("projects mode lists every thread under its project, and the mode toggle is reversible", async ({
  page,
}) => {
  const projects = page.getByTestId("sidebar-mode-toggle-projects");
  const inbox = page.getByTestId("sidebar-mode-toggle-inbox");
  await projects.click();
  await expect(projects).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-testid^="thread-row-"]')).toHaveCount(9);
  await expect(page.getByTestId("thread-row-long-conversation")).toBeVisible();
  await expect(page.getByTestId("thread-row-quieter-oom")).toBeVisible();

  // The way out is as important as the way in — and the mode is a persisted
  // client setting, so leave the stack the way the next test expects it.
  await inbox.click();
  await expect(inbox).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("sidebar-v2-row-card")).toHaveCount(6);
});

test("the kanban board renders all seven columns with every thread as a card", async ({ page }) => {
  await page.goto("/kanban");
  await expect(page.getByTestId("kanban-board")).toBeVisible();
  await expect(page.locator('[data-testid^="kanban-column-"]')).toHaveText([
    /./,
    /./,
    /./,
    /./,
    /./,
    /./,
    /./,
  ]);
  const columnIds = await page
    .locator('[data-testid^="kanban-column-"]')
    .evaluateAll((columns) => columns.map((column) => column.getAttribute("data-testid")));
  expect(columnIds).toEqual([
    "kanban-column-snoozed",
    "kanban-column-exploration",
    "kanban-column-move-along",
    "kanban-column-full-attention",
    "kanban-column-decision-needed",
    "kanban-column-final-review",
    "kanban-column-settled",
  ]);
  await expect(page.getByTestId("kanban-card")).toHaveCount(9);
  await expect(page.getByTestId("kanban-column-snoozed").getByTestId("kanban-card")).toContainText(
    "Stream the shell before the data",
  );
  await expect(page.getByTestId("kanban-column-settled").getByTestId("kanban-card")).toHaveCount(2);
});
