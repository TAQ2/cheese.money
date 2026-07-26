---
name: visual-ux-test
description: MANDATORY visual UX verification gate for {{PROJECT}} — run BEFORE staging/committing/deploying ANY change that touches templates, components, CSS, or user-visible JS (layout, placement, popovers, buttons, responsive behavior). Screenshots at the device matrix + executable bounding-box assertions on the real rendered page, all on the locally pinned python-playwright (zero npm/npx/MCP). Use when the user says "visual test", "UX test", "check the layout", "screenshot the page", when debugging a reported visual/UX defect, or automatically whenever a diff touches {{UI_PATHS}}.
---

# Visual UX Test Suite — {{PROJECT}}

## Why this exists (the scar)

A share-button placement shipped **4 wrong iterations in one day** — overlapping a photo thumbnail,
straddling a gap, riding the wrong flex line — because an agent reasoned about CSS geometry instead
of rendering it. Each blind deploy burned a human review cycle. The first screenshot loop found and
proved the correct fix in a single pass.

Standing law: **UI changes ship only after being SEEN working at the full device matrix.** Capturing
screenshots and not opening them is the exact failure mode this suite exists to kill.

## Security / installation posture (deliberate — do not "modernize" it)

- **Zero-npm architecture.** No `npx`, no `npm install -g`, no Playwright MCP, no Chrome DevTools
  MCP. The capture harness runs on the **locally pinned python-playwright ({{PLAYWRIGHT_PIN}})**
  with Chromium from the local browser cache. Nothing is fetched at run time, so the npm-registry
  supply-chain surface (unpinned `npx <pkg>@latest` re-resolving every session, registry-level
  campaigns, provenance-forging CI compromises) simply does not exist here.
- An MCP server would also cost context permanently; a CLI invoked via Bash costs nothing until
  used and writes its output to disk, where it is read on demand.
- Heavier isolation, if ever wanted: run inside the official `mcr.microsoft.com/playwright` image
  **pinned by digest** — never `--pull=always` on a mutable tag, that is the `npx` problem wearing
  a Docker coat. Optional tier, not a requirement.
- **CDN/bot protection:** {{PROD_ORIGIN}} serves headless Chromium fine today. If that ever changes,
  fall back in order: (a) CDP-attach to a real browser
  (`p.chromium.connect_over_cdp("http://localhost:9222")` against Chrome/Brave started with
  `--remote-debugging-port=9222` — it IS a real browser, so it defeats most bot detection);
  (b) point the suite at localhost instead of production.
- **Scope:** CSS width tiers on desktop Chromium — no touch/DPR/UA device emulation. Tiers are what
  responsive CSS branches on; device emulation adds flake, not signal.

## The two tools

### 1. Capture harness — `tests/visual/visual_check.py` (the iteration loop)

```bash
# shoot the current state at the full matrix, framed on the surface under test
python3 tests/visual/visual_check.py "{{PROD_ORIGIN}}{{STABLE_PATH}}" --scroll-to "<selector>" --tag before

# candidate-fix loop (the killer feature): inject candidate CSS over the LIVE page —
# no local server, no build, no deploy, seconds per iteration
python3 tests/visual/visual_check.py "<url>" --patch-css /tmp/candidate.css --tag candidate

# drive page state before the shot (open a popover, click a tab, fill a form)
echo 'document.getElementById("my-toggle").click();' > /tmp/open.js
python3 tests/visual/visual_check.py "<url>" --patch-js /tmp/open.js --tag popover-open
```

`--viewports` overrides the matrix, `--full-page` for layout-holistic checks, `--height`/`--settle`
for slow or tall pages. Output lands in `tests/visual/runs/<timestamp>/` (gitignored). Console
errors and failed requests are printed per shot — a 404'd stylesheet explains a "broken layout" in
one line. Non-zero exit if any width failed to capture.

### 2. Assertion cases — the durable regression layer

<!--PY-->
```bash
RUN_VISUAL=1 python3 -m pytest tests/visual/ -q                                   # against production
VISUAL_BASE_URL=http://localhost:{{DEV_PORT}} RUN_VISUAL=1 python3 -m pytest tests/visual/ -q   # pre-deploy
```

Config (viewport matrix, base URL, timeouts) lives in `tests/visual/conftest.py`; geometry helpers
in `tests/visual/visual_asserts.py`. One case file per stakeholder-approved surface:

```python
"""Visual UX assertions for <FEATURE>."""
from visual_asserts import (assert_inside_viewport, assert_no_horizontal_overflow,
                            assert_no_overlap, assert_vertically_centered_on, box)

VISUAL_PATH = "{{STABLE_PATH}}"     # a stable, content-rich page that exercises the surface fully
WIDE_BREAKPOINT = {{WIDE_BREAKPOINT}}   # must match the CSS breakpoint exactly


def test_no_horizontal_overflow(page):        # universal invariant — in EVERY case file
    assert_no_horizontal_overflow(page)


def test_element_visible_and_contained(page):
    assert_inside_viewport(page, page.locator("#my-element"), "my-element")


def test_element_never_overlaps_neighbor(page):
    assert_no_overlap(box(page.locator("#my-element"), "my-element"),
                      box(page.locator(".neighbor").first, "neighbor"), "element vs neighbor")


def test_tier_placement(page):                # approved geometry per responsive tier
    el = box(page.locator("#my-element"), "my-element")
    anchor_sel = ".wide-anchor" if page.viewport_size["width"] >= WIDE_BREAKPOINT else ".narrow-anchor"
    assert_vertically_centered_on(el, box(page.locator(anchor_sel).first, anchor_sel), anchor_sel)


def test_interaction_state(page):             # drive it, then assert the result
    page.locator("#my-toggle").click()
    panel = page.locator("#my-panel")
    assert_inside_viewport(page, panel, "my-panel")
    ids = panel.evaluate("el => Array.from(el.querySelectorAll('a[id], button[id]')).map(n => n.id)")
    assert ids == ["expected", "order", "here"], f"child order wrong: {ids}"
```
<!--/PY-->
<!--TS-->
```bash
npm run test:visual                                    # pre-deploy gate: local production build
VISUAL_BASE_URL={{PROD_ORIGIN}} npm run test:visual    # post-deploy proof: the served pixels
```

The assertion tier rides this repo's existing `@playwright/test` runner — a second test runner for
one tier would be entropy, not consistency. Config (viewport matrix as one project per width, base
URL) lives in `playwright.visual.config.ts`, **separate from `playwright.config.ts` so this tier can
never be dragged into the e2e/CI gate by accident**; geometry helpers in
`tests/visual/visual-asserts.ts`. One `tests/visual/<feature>.visual.spec.ts` per approved surface:

```ts
import { test } from "@playwright/test";
import { assertInsideViewport, assertNoHorizontalOverflow, assertNoOverlap, box, gotoSettled } from "./visual-asserts";

const VISUAL_PATH = "{{STABLE_PATH}}";
const WIDE_BREAKPOINT = {{WIDE_BREAKPOINT}};

test.beforeEach(async ({ page }) => { await gotoSettled(page, VISUAL_PATH); });   // never bare networkidle

test("no horizontal overflow", async ({ page }) => {   // universal invariant — in EVERY case file
  await assertNoHorizontalOverflow(page);
});

test("element visible and contained", async ({ page }) => {
  await assertInsideViewport(page, page.locator("#my-element"), "my-element");
});

test("tier placement", async ({ page }) => {
  const el = await box(page.locator("#my-element"), "my-element");
  const anchorSel = page.viewportSize()!.width >= WIDE_BREAKPOINT ? ".wide-anchor" : ".narrow-anchor";
  assertNoOverlap(el, await box(page.locator(anchorSel).first(), anchorSel), `${anchorSel} tier`);
});
```
<!--/TS-->

**Why bounding-box math, not pixel diffing:** full-page baselines flake on any live site (photos,
prices, dates change daily). Geometry assertions — is X inside/outside/left-of/centered-on Y — are
content-independent and survive copy changes. Pixel baselines are a deliberate non-goal.

## MANDATORY workflow for any UI-touching change

1. **Capture BEFORE writing the fix** (`--tag before`) and **LOOK** at the PNGs (Read tool).
   Diagnose from pixels, never from CSS source — a `margin-left:auto` item riding the last wrapped
   line is invisible in source review.
2. **Iterate with `--patch-css`** over the live page until right at ALL matrix widths. Zero deploys
   burned on guesses.
3. **Apply to the repo** only the visually proven patch. Bump the asset-version/cache-bust token if
   the stack uses one (a new query-param URL is uncached by definition — no CDN purge needed).
4. **Run the assertion cases** — green required.
5. **Commit** (docs same commit) → **deploy** → **re-capture the LIVE page** (`--tag after`). A
   deploy script reporting success is not proof; served pixels are.
6. **New approved geometry ⇒ new assertion case, in the same commit as the feature.** This is how
   the suite compounds: every layout the stakeholder approves becomes a permanent regression fence.
   Same-commit, or it never happens.

## Rules

- **LOOK at the PNGs.** Every time. Capture without reading the images is not verification.
- **Anchor an element in its semantic neighbor's DOM.** Positioning with offsets from a *foreign*
  container is guessing with extra steps — that was the share-button saga's root cause.
- **Flexbox trap:** `margin-left:auto` in a *wrapping* flex row puts the item on the last wrapped
  line, not beside the first-line content — visible only once content actually wraps (i.e. mobile).
  Absolute-position inside the flex container + reserved padding is the wrap-proof pattern.
- **Reserve space for overlaid elements** (`padding-right: <icon width + gap>` on the container) so
  text can never underlap them at any content length.
- **Assert on ids, not classes** — classes churn with styling. Give interactive elements stable ids.
- **Geometry is measured on a frozen page.** The fixtures inject an animation/transition kill
  switch after load: a page that animates forever never satisfies Playwright's actionability check
  (clicks time out), and a box read mid-transition is noise. `reduced_motion` alone only helps on
  sites that honour `prefers-reduced-motion`.
- The tier stays **opt-in and out of coverage gates** (network + browser + ~minutes). Never move
  these into the unit tests.

## For the agent pipeline (three gates — the suite only matters if the pipeline can't skip it)

- **Implementer / Coding Agent**: any change touching {{UI_PATHS}} MUST run workflow steps 1–4
  before declaring implementation complete, and paste the assertion-suite result into its report.
- **Reviewer / QA**: a UI-touching diff whose report carries no visual evidence (matrix screenshots
  looked at + green assertion run) is an automatic **Must Fix** — unverified by construction.
  Re-capture 1–2 viewports independently; do not trust the report's images.
- **Merge gate / TPM**: for UI changes the outcome spot-check includes viewing the run's
  screenshots or capturing fresh ones. For any reported visual defect, **first** capture the live
  page at the matrix — diagnose from pixels before opening a single source file.
