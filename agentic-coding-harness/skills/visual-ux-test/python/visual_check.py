"""Visual UX capture harness — screenshot any page across the viewport matrix, optionally with a
candidate CSS/JS patch injected over the LIVE page, so layout work is verified on pixels BEFORE
any commit or deploy.

Zero-npm architecture: runs on the locally pinned python-playwright (no npx, no Node toolchain,
no MCP server). Chromium comes from the local browser cache — nothing is fetched at run time.

Usage:
  python3 tests/visual/visual_check.py URL [options]

Options:
  --viewports 360,390,1024,1440   comma-separated widths (default: DEFAULT_VIEWPORTS below)
  --patch-css FILE                inject this CSS over the page before shooting (candidate loop)
  --patch-js FILE                 run this JS after load (open a popover, click a tab, seed state)
  --scroll-to SELECTOR            scroll this element into view before the shot
  --out DIR                       output dir (default tests/visual/runs/<timestamp>)
  --tag NAME                      filename prefix (default "shot")
  --full-page                     full-page screenshot instead of the viewport clip
  --height PX                     viewport height (default 900)
  --settle MS                     extra wait after load + patches (default 600)

The PNGs are the deliverable: OPEN and LOOK at them. Capture-without-looking is the exact failure
mode this harness exists to kill. Console errors and failed requests are reported per shot (a
404'd stylesheet explains a "broken layout" in one line). Exit code is 1 if any viewport failed.

Deliberate scope: this emulates CSS width tiers on desktop Chromium — no touch/DPR/UA device
emulation. Tiers are what responsive CSS branches on; device emulation adds flake, not signal.
"""
import argparse
import pathlib
import sys
import time

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

# Device matrix: fold-closed (Galaxy Fold cover 280), phones (360/390), fold-open (717),
# tablet portrait (768), laptop (1024), CSS tier boundary (1280), desktop (1440), wide (1920).
# ADAPT: every breakpoint in your CSS belongs here, tested one pixel below and at/above it.
DEFAULT_VIEWPORTS = [280, 360, 390, 717, 768, 1024, 1280, 1440, 1920]

NAV_TIMEOUT_MS = 45000


def _watch_page_problems(page, problems):
    """Record the page-level failures that explain most 'mystery' layout bugs."""
    page.on("console", lambda m: problems.append(f"console error: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(f"page error: {e}"))
    page.on("requestfailed", lambda r: problems.append(f"request failed: {r.url}"))


def _goto(page, url, problems):
    try:
        page.goto(url, wait_until="networkidle", timeout=NAV_TIMEOUT_MS)
    except PlaywrightTimeout:
        # Analytics beacons / long-polling sockets can keep a page from ever going network-idle.
        # DOM-ready + the settle wait is enough to shoot; aborting would lose the whole matrix.
        problems.append("networkidle never reached — shot after domcontentloaded")
        page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)


def shoot(url, viewports, out_dir, tag, patch_css=None, patch_js=None, scroll_to=None,
          full_page=False, height=900, settle=600):
    """Screenshot `url` at each width. Returns [(path, [problem, ...]), ...]; a width that fails
    outright yields (None, [error]) and does not stop the rest of the matrix."""
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    css = pathlib.Path(patch_css).read_text() if patch_css else None
    js = pathlib.Path(patch_js).read_text() if patch_js else None
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in viewports:
            problems = []
            page = browser.new_page(viewport={"width": width, "height": height}, reduced_motion="reduce")
            _watch_page_problems(page, problems)
            try:
                _goto(page, url, problems)
                if css:
                    page.add_style_tag(content=css)
                if js:
                    # Wrapped in an IIFE so multi-statement patch files evaluate as an expression.
                    page.evaluate(f"(() => {{\n{js}\n}})()")
                if scroll_to:
                    page.locator(scroll_to).first.scroll_into_view_if_needed(timeout=10000)
                page.wait_for_timeout(settle)
                path = out / f"{tag}-{width}.png"
                # animations="disabled" freezes CSS animations to their first frame: the same
                # page shot twice is the same pixels.
                page.screenshot(path=str(path), full_page=full_page, animations="disabled")
                results.append((path, problems))
                print(f"  {path}")
            except Exception as exc:  # one bad width must not cost the other eight
                results.append((None, problems + [f"FAILED: {type(exc).__name__}: {exc}"]))
                print(f"  [{width}px] FAILED: {type(exc).__name__}: {exc}")
            finally:
                page.close()
            for problem in dict.fromkeys(problems):  # de-duplicated, order preserved
                print(f"      ! {problem}")
        browser.close()
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("--viewports", default=",".join(str(v) for v in DEFAULT_VIEWPORTS))
    ap.add_argument("--patch-css")
    ap.add_argument("--patch-js")
    ap.add_argument("--scroll-to")
    ap.add_argument("--out", default=f"tests/visual/runs/{time.strftime('%Y%m%d-%H%M%S')}")
    ap.add_argument("--tag", default="shot")
    ap.add_argument("--full-page", action="store_true")
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--settle", type=int, default=600)
    args = ap.parse_args()
    viewports = [int(v) for v in args.viewports.split(",") if v.strip()]
    results = shoot(
        args.url, viewports, args.out, args.tag,
        patch_css=args.patch_css, patch_js=args.patch_js, scroll_to=args.scroll_to,
        full_page=args.full_page, height=args.height, settle=args.settle,
    )
    shot = [r for r in results if r[0]]
    failed = len(results) - len(shot)
    print(f"\n{len(shot)}/{len(results)} screenshots -> {args.out}"
          f"{f' ({failed} FAILED)' if failed else ''}\n"
          "Now OPEN and LOOK at them before shipping anything.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
