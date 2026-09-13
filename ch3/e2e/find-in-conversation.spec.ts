/**
 * Find in conversation (3f91e16f, hardened in b02594b9): the acceptance test
 * that feature shipped without. The timeline is virtualised and folds settled
 * turns, so the browser's own find cannot see most of a long thread; this bar
 * searches the entry model, counts honestly, and reveals what it lands on —
 * unfolding a turn, expanding a clipped message, reaching inside a code block.
 *
 * The fixture (`LONG_CONVERSATION`) plants one word exactly three times, one
 * in each kind of hidden place, so every number below is exact.
 */
import { LONG_CONVERSATION as L } from "../scripts/visual/fixtures.ts";
import { test, expect } from "./fixtures.ts";

/** How many ranges each registered highlight holds — `{}` when none. */
const highlightSizes = () =>
  Object.fromEntries([...CSS.highlights.entries()].map(([name, ranges]) => [name, ranges.size]));

const foldToggle = (turn: number) => `[data-timeline-row-id="turn-fold:${L.turnId(turn)}"]`;

test.beforeEach(async ({ page, stack }) => {
  await page.goto(`/${stack.environmentId}/${stack.longThreadId}`);
  // Landed at the end of the thread, as a reopened conversation always does.
  await expect(page.locator(`[data-message-id="${L.answerMessageId(L.turnCount)}"]`)).toBeVisible();
});

test("mod+f opens the bar focused; pressing it again selects the query", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+f");
  const input = page.getByLabel("Find in conversation");
  await expect(input).toBeFocused();

  await input.fill(L.findMarker);
  await page.getByTestId("composer-editor").click();
  await expect(input).not.toBeFocused();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(input).toBeFocused();
  // Browser-style: the second press selects what is there so typing replaces it.
  await expect
    .poll(() =>
      input.evaluate(
        (el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length,
      ),
    )
    .toBe(true);
});

test("typing a query reveals its first match even inside a folded turn far away", async ({
  page,
}) => {
  // Found by this suite, fixed in 3fb54636: with the reader at the end of the
  // thread, the first reveal after typing did not scroll when the match sat
  // inside a folded turn whose rows were not mounted yet. The counter said
  // "1 of 3", the list stayed put, and only stepping (Enter) moved it — the
  // reveal pass found no row for the match, returned, and the unfold that
  // followed mounted nothing on screen, so nothing re-ran it. The pass now
  // re-runs when the rows change. This test is what keeps it that way.
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByLabel("Find in conversation").fill(L.findMarker);
  await expect(page.getByRole("search").locator("[aria-live]")).toHaveText("1 of 3");
  await expect(page.locator(foldToggle(L.foldedMarkerTurn)).getByRole("button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.locator(`[data-timeline-row-id="${L.commentaryMessageId(L.foldedMarkerTurn)}"]`),
  ).toBeInViewport();
});

test("the counter is exact, and every step reveals the match it lands on", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+f");
  const bar = page.getByRole("search");
  const input = page.getByLabel("Find in conversation");
  const counter = bar.locator("[aria-live]");

  await input.fill("no-such-word-anywhere");
  await expect(counter).toHaveText("0 of 0");
  await expect(bar.getByRole("button", { name: "Next match" })).toBeDisabled();

  // Three occurrences in the thread, counted from the entry model rather than
  // the screenful of rows the virtualised list has mounted.
  await input.fill(L.findMarker);
  await expect(counter).toHaveText("1 of 3");

  // 2 of 3 — the last line of a user message long enough to render clipped.
  // The body must be expanded, not merely scrolled to.
  await input.press("Enter");
  await expect(counter).toHaveText("2 of 3");
  const requestRow = page.locator(
    `[data-timeline-row-id="${L.requestMessageId(L.collapsedMarkerTurn)}"]`,
  );
  const requestBody = requestRow.locator("[data-user-message-body]");
  await expect(requestBody).toHaveAttribute("data-user-message-collapsible", "true");
  await expect(requestBody).toHaveAttribute("data-user-message-collapsed", "false");
  await expect(requestRow).toBeInViewport();
  await expect
    .poll(() => page.evaluate(highlightSizes))
    .toMatchObject({
      "find-in-thread-active": 1,
    });

  // 3 of 3 — inside a fenced code block. Shiki emits that as cached HTML, so
  // the highlight has to be painted by the CSS Custom Highlight API on the
  // rendered text; the active range must sit inside the <pre>.
  await input.press("Enter");
  await expect(counter).toHaveText("3 of 3");
  const codeRow = page.locator(
    `[data-timeline-row-id="${L.answerMessageId(L.codeBlockMarkerTurn)}"]`,
  );
  await expect(codeRow.locator("pre")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = CSS.highlights.get("find-in-thread-active");
        const range = active === undefined ? undefined : [...active][0];
        const container = range?.startContainer;
        return container instanceof Node && container.parentElement?.closest("pre") !== null;
      }),
    )
    .toBe(true);

  // 1 of 3 again, by wrapping — inside turn 1's commentary, which the settled
  // turn had folded behind "Worked for …". The fold opens and the commentary
  // row is on screen.
  await input.press("Enter");
  await expect(counter).toHaveText("1 of 3");
  await expect(page.locator(foldToggle(L.foldedMarkerTurn)).getByRole("button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    page.locator(`[data-timeline-row-id="${L.commentaryMessageId(L.foldedMarkerTurn)}"]`),
  ).toBeInViewport();

  // And backwards.
  await input.press("Shift+Enter");
  await expect(counter).toHaveText("3 of 3");
});

test("Escape closes the bar, drops every highlight and returns focus to the composer", async ({
  page,
}) => {
  await page.keyboard.press("ControlOrMeta+f");
  const input = page.getByLabel("Find in conversation");
  await input.fill(L.findMarker);
  await expect(page.getByRole("search").locator("[aria-live]")).toHaveText("1 of 3");
  // Step once so the active match is on screen and highlighted; Escape must
  // then clear both registries, not just the one it can see.
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(2);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("search")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.size)).toBe(0);
  await expect(page.getByTestId("composer-editor")).toBeFocused();
});
