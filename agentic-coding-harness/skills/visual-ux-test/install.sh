#!/usr/bin/env bash
# Install the visual UX test suite into a repository.
#
#   ./install.sh /path/to/repo --origin https://your-domain.com [--ts] [--install-deps] [--no-check]
#
#   --ts            also install the TypeScript assertion tier (repos that already have
#                   @playwright/test — reuse their runner instead of adding a python test tier)
#   --install-deps  pip-install the pinned python-playwright + chromium if missing
#   --no-check      skip the live test-fire capture (default: fire 2 widths to prove the CDN
#                   lets headless Chromium through before you trust the suite)
#
# Installs: tests/visual/{visual_check.py,conftest.py,visual_asserts.py}, the gitignore entry for
# the screenshot output, and .claude/skills/visual-ux-test/SKILL.md. Prints the placeholders you
# must still fill and the pipeline gates you must still wire.
set -euo pipefail

PLAYWRIGHT_PIN="1.52.0"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET=""; ORIGIN=""; WITH_TS=0; INSTALL_DEPS=0; CHECK=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin) ORIGIN="$2"; shift 2 ;;
    --ts) WITH_TS=1; shift ;;
    --install-deps) INSTALL_DEPS=1; shift ;;
    --no-check) CHECK=0; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done

[[ -n "$TARGET" && -n "$ORIGIN" ]] || { echo "usage: install.sh <repo-root> --origin https://domain [--ts] [--install-deps] [--no-check]" >&2; exit 64; }
TARGET="$(cd "$TARGET" && pwd)"
[[ -d "$TARGET/.git" ]] || { echo "!! $TARGET is not a git repository root" >&2; exit 64; }

# ── 1. dependency (pinned; nothing is ever fetched at run time) ────────────────────────────────
if ! python3 -c "import playwright" 2>/dev/null; then
  if [[ $INSTALL_DEPS -eq 1 ]]; then
    pip install "playwright==$PLAYWRIGHT_PIN"
    python3 -m playwright install chromium
  else
    echo "!! python-playwright missing. Re-run with --install-deps, or:" >&2
    echo "   pip install playwright==$PLAYWRIGHT_PIN && python3 -m playwright install chromium" >&2
    exit 69
  fi
fi
echo "== playwright $(python3 -c 'from importlib.metadata import version; print(version("playwright"))')"

# ── 2. the suite ───────────────────────────────────────────────────────────────────────────────
# The capture harness is python in every repo (one tool, one behaviour everywhere). The assertion
# tier follows the repo's own test runner: pytest, or --ts for repos that already have
# @playwright/test — a second test runner for one tier is entropy, not consistency.
mkdir -p "$TARGET/tests/visual"
cp "$SRC/python/visual_check.py" "$TARGET/tests/visual/"
echo "== installed tests/visual/visual_check.py (capture harness)"

if [[ $WITH_TS -eq 1 ]]; then
  cp "$SRC/typescript/visual-asserts.ts" "$TARGET/tests/visual/"
  sed "s|{{PROD_ORIGIN}}|$ORIGIN|g" "$SRC/typescript/playwright.visual.config.ts" > "$TARGET/playwright.visual.config.ts"
  echo "== installed playwright.visual.config.ts + tests/visual/visual-asserts.ts (assertion tier)"
  echo "   TODO: add to package.json scripts →  \"test:visual\": \"playwright test -c playwright.visual.config.ts\""
else
  cp "$SRC/python/visual_asserts.py" "$TARGET/tests/visual/"
  sed "s|{{PROD_ORIGIN}}|$ORIGIN|g" "$SRC/python/conftest.py" > "$TARGET/tests/visual/conftest.py"
  echo "== installed tests/visual/{conftest.py,visual_asserts.py} (assertion tier)"
fi

# ── 3. gitignore the screenshot output (same commit — stray runs/ files ride into commits) ─────
if ! grep -qxF "tests/visual/runs/" "$TARGET/.gitignore" 2>/dev/null; then
  printf '\n# Visual UX test screenshot output (evidence, not source)\ntests/visual/runs/\n' >> "$TARGET/.gitignore"
  echo "== gitignored tests/visual/runs/"
fi

# ── 4. the instructional layer ─────────────────────────────────────────────────────────────────
mkdir -p "$TARGET/.claude/skills/visual-ux-test"
PROJECT="$(basename "$TARGET")"
# Keep only the assertion-tier section matching the runner installed above.
DROP=$([[ $WITH_TS -eq 1 ]] && echo "PY" || echo "TS")
sed -e "s|{{PROJECT}}|$PROJECT|g" -e "s|{{PROD_ORIGIN}}|$ORIGIN|g" -e "s|{{PLAYWRIGHT_PIN}}|$PLAYWRIGHT_PIN|g" \
    -e "/<!--$DROP-->/,/<!--\/$DROP-->/d" -e "/<!--\/*[PT][YS]-->/d" \
    "$SRC/SKILL.template.md" > "$TARGET/.claude/skills/visual-ux-test/SKILL.md"
echo "== installed .claude/skills/visual-ux-test/SKILL.md"

# ── 5. proof, not report: fire the harness at the live origin ──────────────────────────────────
if [[ $CHECK -eq 1 ]]; then
  echo "== test-firing the harness against $ORIGIN (proves headless gets past the CDN)"
  (cd "$TARGET" && python3 tests/visual/visual_check.py "$ORIGIN" --viewports 390,1440 \
      --out tests/visual/runs/install-check --tag install-check)
fi

REMAINING="$(grep -o '{{[A-Z_]*}}' "$TARGET/.claude/skills/visual-ux-test/SKILL.md" | sort -u | tr '\n' ' ')"
cat <<EOF

── next (the suite is inert until these are done) ─────────────────────────────
1. LOOK at tests/visual/runs/install-check/*.png — the capture is only proof once seen.
2. Fill the remaining SKILL.md placeholders: ${REMAINING:-none}
3. Adapt the viewport matrices to this project's real CSS breakpoints (one pixel below and
   at/above each): tests/visual/conftest.py VIEWPORTS, tests/visual/visual_check.py DEFAULT_VIEWPORTS$([[ $WITH_TS -eq 1 ]] && echo ", playwright.visual.config.ts VIEWPORTS").
4. Write the first case file for the most load-bearing approved surface (pattern in SKILL.md),
   run it green: $([[ $WITH_TS -eq 1 ]] && echo "npm run test:visual" || echo "RUN_VISUAL=1 python3 -m pytest tests/visual/ -q").
5. Wire the three pipeline gates (implementer checklist / reviewer must-fix / merge + debugging
   rule) into the agent instruction docs — see SKILL.md "For the agent pipeline".
6. Commit suite + skill + gitignore + doc wiring together, in one commit.
EOF
