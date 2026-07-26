"""Shared configuration + fixtures for the visual assertion tier.

Opt-in by construction (real network, real browser, ~seconds per width — this tier must never run
inside the hermetic unit gates):

  RUN_VISUAL=1 python3 -m pytest tests/visual/ -q

Env overrides:
  VISUAL_BASE_URL   origin under test (default DEFAULT_BASE_URL — point at localhost pre-deploy)
  VISUAL_VIEWPORTS  comma-separated widths (default VIEWPORTS)

Each case file declares its own target: `VISUAL_PATH = "/some/stable/content-rich/page"`.
"""
import os

import pytest

DEFAULT_BASE_URL = "{{PROD_ORIGIN}}"

# One pixel below and at/above every CSS breakpoint — tier-flip bugs hide exactly there.
# ADAPT to the project's real breakpoints.
VIEWPORTS = [280, 390, 768, 1024, 1279, 1440, 1920]

# Animations are the #1 flake source in visual testing: a page that animates forever never
# satisfies Playwright's actionability check (clicks time out), and geometry read mid-transition is
# noise. reduced_motion only helps on sites that honour prefers-reduced-motion — this does not ask.
FREEZE_ANIMATIONS_CSS = "*, *::before, *::after { animation: none !important; transition: none !important; }"

VIEWPORT_HEIGHT = 900
NAV_TIMEOUT_MS = 45000
SETTLE_MS = 400


def pytest_collection_modifyitems(config, items):
    """One gate for the whole tier, so no case file can forget it and no bare `pytest` run can
    drag network-dependent tests into a coverage gate."""
    if os.environ.get("RUN_VISUAL") == "1":
        return
    skip = pytest.mark.skip(reason="visual tier is opt-in: set RUN_VISUAL=1")
    for item in items:
        item.add_marker(skip)


def _viewports():
    raw = os.environ.get("VISUAL_VIEWPORTS")
    return [int(v) for v in raw.split(",") if v.strip()] if raw else VIEWPORTS


@pytest.fixture(scope="session")
def browser():
    # Imported inside the fixture: bare collection must stay harmless on a machine without
    # playwright installed.
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture(params=_viewports(), ids=lambda w: f"{w}px")
def page(browser, request):
    """One page per viewport width, loaded on the case file's VISUAL_PATH."""
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    url = os.environ.get("VISUAL_BASE_URL", DEFAULT_BASE_URL) + getattr(request.module, "VISUAL_PATH", "/")
    pg = browser.new_page(viewport={"width": request.param, "height": VIEWPORT_HEIGHT}, reduced_motion="reduce")
    try:
        pg.goto(url, wait_until="networkidle", timeout=NAV_TIMEOUT_MS)
    except PlaywrightTimeout:
        # Beacons/sockets can prevent network-idle forever; DOM-ready + settle is enough geometry.
        pg.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    pg.add_style_tag(content=FREEZE_ANIMATIONS_CSS)
    pg.wait_for_timeout(SETTLE_MS)
    yield pg
    pg.close()
