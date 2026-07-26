// Geometry helpers for visual assertion cases.
//
// Bounding-box math on a live rendered page: content-independent, so it survives copy edits, new
// photos and changing prices — unlike pixel baselines, which flake on any live site.
import { expect, type Locator, type Page } from "@playwright/test";

export type Box = { x: number; y: number; width: number; height: number };

/** The viewport width the matrix pinned for this project — fails loudly if it is unset. */
export function viewportWidth(page: Page): number {
  const size = page.viewportSize();
  if (!size) throw new Error("viewport size unavailable — the visual tier requires a fixed viewport");
  return size.width;
}

/**
 * Navigate and settle. Never wait on `networkidle` alone: an app that prefetches (Next.js RSC
 * payloads) or holds an analytics socket never goes idle, and the test dies on timeout instead of
 * asserting. DOM-ready + best-effort quiet + a short settle is all layout geometry needs.
 */
export async function gotoSettled(page: Page, path: string, settleMs = 400): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  // Freeze animations: a page that animates forever never satisfies Playwright's actionability
  // check (clicks time out), and geometry read mid-transition is noise. reducedMotion only helps
  // on sites that honour prefers-reduced-motion — this does not ask.
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; }" });
  await page.waitForTimeout(settleMs);
}

/** boundingBox() that names the element instead of failing later on a null. */
export async function box(locator: Locator, name: string): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`${name}: no bounding box — not rendered (display:none / detached / offscreen)`);
  return b;
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

export function assertNoOverlap(a: Box, b: Box, what: string): void {
  expect(boxesIntersect(a, b), `${what}: boxes overlap — ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false);
}

/** Element is visible and fully within the horizontal viewport (the containment invariant). */
export async function assertInsideViewport(page: Page, locator: Locator, name: string): Promise<Box> {
  await expect(locator, `${name}: not visible`).toBeVisible();
  const b = await box(locator, name);
  const vw = viewportWidth(page);
  expect(b.x >= 0 && b.x + b.width <= vw + 1, `${name}: overflows viewport ${vw}px — ${JSON.stringify(b)}`).toBe(true);
  return b;
}

/** Inner's vertical center sits within `tolerance` of outer's vertical span. */
export function assertVerticallyCenteredOn(inner: Box, outer: Box, what: string, tolerance = 8): void {
  const cy = inner.y + inner.height / 2;
  expect(
    cy >= outer.y - tolerance && cy <= outer.y + outer.height + tolerance,
    `${what}: center ${cy.toFixed(0)} not aligned to ${JSON.stringify(outer)} (±${tolerance}px)`,
  ).toBe(true);
}

/**
 * The universal "nothing broke anywhere on this page at this width" invariant — one scrollWidth
 * read catches ANY element escaping the page, not just the surface under test. Put it in every
 * case file.
 */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const vw = viewportWidth(page);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(
    scrollWidth <= vw + 1,
    `page overflows horizontally: scrollWidth ${scrollWidth} > viewport ${vw}. Find the culprit with: ` +
      "[...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth)",
  ).toBe(true);
}
