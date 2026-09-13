/**
 * The auth boundary. The web client is reachable by anything that can see the
 * port — on the tailnet, that is every device — and the only thing between a
 * visitor and this machine's filesystem is pairing. If a bare origin ever
 * renders the app, or a spent token pairs twice, everything else in this suite
 * is decoration.
 */
import { test, expect, watchConsole, assertCleanConsole } from "./fixtures.ts";

// Every test in this file starts unpaired: no cookie jar, no session.
test.use({
  storageState: { cookies: [], origins: [] },
  // An unpaired client is refused: the server answers its socket and its API
  // calls with 401, and Chromium reports each refusal on the console. The
  // refusal is the property under test, not noise around it.
  knownConsoleErrors: {
    "the unpaired socket is refused":
      /WebSocket connection to .* failed: HTTP Authentication failed/,
    "the unpaired API call is refused":
      /Failed to load resource: the server responded with a status of 401/,
  },
});

test("a bare origin does not render the app; it lands on the pairing screen", async ({
  page,
  stack,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/pair$/);
  await expect(page.getByRole("heading", { name: "Pair with this environment" })).toBeVisible();
  await expect(page.getByLabel("Pairing token")).toBeVisible();
  await expect(page.getByTestId("composer-editor")).toHaveCount(0);

  // A deep link is gated the same way — the redirect is not a courtesy of the
  // index route alone.
  await page.goto(`/${stack.environmentId}/${stack.threadId}`);
  await expect(page).toHaveURL(/\/pair$/);
  await expect(page.locator("[data-timeline-row-id]")).toHaveCount(0);

  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(200);
  expect(await session.json()).toMatchObject({ authenticated: false });
});

test("the pairing URL pairs the browser exactly once", async ({
  page,
  browser,
  mintPairingCredential,
  knownConsoleErrors,
}) => {
  // `ch3 auth pairing create` is what the app's own Connections screen and the
  // dev runner's startup line hand out; the token rides in the URL hash so it
  // never reaches a server log.
  const credential = await mintPairingCredential();
  const pairingUrl = `/pair#token=${encodeURIComponent(credential)}`;

  await page.goto(pairingUrl);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("composer-editor")).toBeVisible();
  expect(await (await page.request.get("/api/auth/session")).json()).toMatchObject({
    authenticated: true,
  });

  // The same token, replayed from a browser that never paired: refused, and
  // the visitor is left on the pairing screen with nothing behind it.
  const replay = await browser.newContext();
  const replayPage = await replay.newPage();
  const replayConsole = watchConsole(replayPage);
  try {
    await replayPage.goto(pairingUrl);
    await expect(replayPage).toHaveURL(/\/pair$/);
    // The auto-submit has run and failed: the form is idle again.
    await expect(replayPage.getByRole("button", { name: "Continue" })).toBeEnabled();
    await expect(replayPage.getByTestId("composer-editor")).toHaveCount(0);
    expect(await (await replayPage.request.get("/api/auth/session")).json()).toMatchObject({
      authenticated: false,
    });
    assertCleanConsole(replayConsole.errors, knownConsoleErrors);
  } finally {
    await replay.close();
  }
});
