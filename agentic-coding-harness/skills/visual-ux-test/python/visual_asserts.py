"""Geometry helpers for visual assertion cases.

Bounding-box math on a live rendered page: content-independent, so it survives copy edits, new
photos and changing prices — unlike pixel baselines, which flake on any live site.
"""


def box(locator, name):
    """bounding_box() that names the element instead of failing later with a None TypeError."""
    b = locator.bounding_box()
    assert b is not None, f"{name}: no bounding box — not rendered (display:none / detached / offscreen)"
    return b


def boxes_intersect(a, b):
    return not (
        a["x"] + a["width"] <= b["x"]
        or b["x"] + b["width"] <= a["x"]
        or a["y"] + a["height"] <= b["y"]
        or b["y"] + b["height"] <= a["y"]
    )


def assert_no_overlap(a, b, what):
    assert not boxes_intersect(a, b), f"{what}: boxes overlap — {a} vs {b}"


def assert_inside_viewport(page, locator, name):
    """Element is visible and fully within the horizontal viewport (the containment invariant)."""
    assert locator.is_visible(), f"{name}: not visible"
    b = box(locator, name)
    vw = page.viewport_size["width"]
    assert b["x"] >= 0 and b["x"] + b["width"] <= vw + 1, f"{name}: overflows viewport {vw}px — {b}"
    return b


def assert_vertically_centered_on(inner, outer, what, tolerance=8):
    """Inner's vertical center sits within `tolerance` of outer's vertical span."""
    cy = inner["y"] + inner["height"] / 2
    assert outer["y"] - tolerance <= cy <= outer["y"] + outer["height"] + tolerance, (
        f"{what}: center {cy:.0f} not aligned to {outer} (±{tolerance}px)"
    )


def assert_no_horizontal_overflow(page):
    """The universal 'nothing broke anywhere on this page at this width' invariant — one
    scrollWidth read catches ANY element escaping the page, not just the surface under test.
    Put it in every case file."""
    vw = page.viewport_size["width"]
    scroll_width = page.evaluate("document.documentElement.scrollWidth")
    assert scroll_width <= vw + 1, (
        f"page overflows horizontally: scrollWidth {scroll_width} > viewport {vw}. "
        "Find the culprit in the page console with: "
        "[...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth)"
    )
