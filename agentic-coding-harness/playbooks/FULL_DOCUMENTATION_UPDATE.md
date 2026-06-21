# Full Documentation Update — Coding Agent Runbook

Run this procedure after every PR's code changes are complete and before final push. Documentation must only begin after all verification gates pass — never document a broken build.

This is the Last Minute Outdoors (`TAQ2/lastminuteoutdoors`) edition of the runbook. The repo is currently a **static HTML/CSS prototype** (`prototype/` + the Tailwind v4 CSS-first design system); there is no application code and no test runner yet. The verification gates below reflect that reality, with explicit notes for when the Next.js + Vitest stack lands (per `MANIFESTO.md`).

## Steps

### 1. Run the full test gauntlet

Every gate must pass before documentation begins. If any step fails, fix the code first — do not proceed to documentation.

```bash
# CSS build gate — prototype/css/app.css is GENERATED; the build must succeed
npm run css

# The regenerated app.css must hold no surprises: any diff must be explained by this
# PR's changes to tailwind.css / theme.css or by new utility classes used in the HTML
git -C "/Users/Conrad/Desktop/lastminuteoutdoors" status --short -- prototype/css/app.css

# Tier-0 visual verification — Playwright screenshot pixel-compare:
#   1. Serve the prototype:  (cd prototype && python3 -m http.server 5555)
#   2. Capture Playwright screenshots of every page this PR touches, in BOTH locales
#      (prototype/es/ and prototype/en/), plus any affected documentation page.
#   3. Pixel-compare against pre-change screenshots. A pixel diff on a page this PR
#      did not intend to change is a failure — fix the code first.

# WHEN VITEST LANDS (Next.js app — MANIFESTO.md quality gates) the gauntlet becomes:
# npm run typecheck            # tsc --noEmit — must be clean
# npx biome check .            # lint + format gate
# npx vitest run --coverage    # unit tests with coverage (threshold enforced in CI)
```

**Stop here if anything fails.** Fix the failure, re-run, and only proceed to Step 2 when all gates are green. The verification output from this step is the source of truth for all numbers in TEST_DOCUMENTATION.md — save or reference it.

### 2. Regenerate function maps

The reference artifacts live in `LLM coding agent documents/`: `domains-function-map.md`, `FUNCTION_DEPENDENCY_MAP.jsonl`, and `lmo-db-schema.jsonl`. While the repo is a static prototype there is no parseable function surface, so these maps are maintained **by hand** — update them to reflect this PR's changes (pages added/removed/renamed, design tokens, the `<lmo-logo>` component; `lmo-db-schema.jsonl` only once the Drizzle schema exists and changes). When the Next.js app lands, add generator scripts and call them here instead.

For a **full rebuild** of the two generated reference documents, use the repo scripts (one `claude -p` call per production file — use for full regeneration, not incremental PR updates):

```bash
bash "/Users/Conrad/Desktop/lastminuteoutdoors/LLM coding agent documents/scripts/build_service_documentation.sh" lastminuteoutdoors
bash "/Users/Conrad/Desktop/lastminuteoutdoors/LLM coding agent documents/scripts/build_test_documentation.sh" lastminuteoutdoors
```

(Both scripts resolve the repo root with `git rev-parse --show-toplevel`, so when working in an orchestrator worktree, run them from inside the worktree.)

### 3. Identify and fill SERVICE_DOCUMENTATION.md gaps

Compare the updated `domains-function-map.md` against `SERVICE_DOCUMENTATION.md`:

- Every production file in the function map must have a corresponding `### \`prototype/...\`` section in SERVICE_DOCUMENTATION.md. Today's per-file production surface: `prototype/css/theme.css`, `prototype/css/tailwind.css`, `prototype/assets/logo.js`, `prototype/index.html`, and `package.json` (plus `src/**/*.ts` when the app lands).
- The 40+ `prototype/es/` + `prototype/en/` wireframe pages are covered by the **Wireframe Page Inventory** section — keep that inventory in sync (pages added/removed/renamed), do not write per-page sections for them.
- Never document `prototype/css/app.css` — it is generated output (`npm run css`).
- New files from this PR must have full sections: Layer, Purpose, Imports from, Imported by, function/class/token docs, Design Notes
- Modified files must have their existing sections updated (new tokens, changed component classes, changed signatures, new parameters)
- QA findings (awareness-only or code-change) must be captured as Design Notes per Section 14 of the Coding Agent playbook

Fix all gaps before proceeding.

### 4. Update TEST_DOCUMENTATION.md from actual test output

Use the verification output saved from Step 1 — do not guess or carry forward stale numbers.

Update TEST_DOCUMENTATION.md to match reality:

- **Header**: commit hash, last updated date, current verification mode (Tier-0 visual suite — no coverage instrumentation yet)
- **Test Run Status**: the result of `npm run css` plus the pixel-compare run — pages compared, locales, diffs found, and whether each diff was intended — with a PR-specific changelog entry
- **Tier-0 visual suite section**: keep the suite description accurate (serve command, pages in scope, compare procedure, locale-parity rule)
- **Per-module test sections**: none today — when Vitest lands, every new test file needs its own section with test count, scenarios covered, known gaps
- **WHEN VITEST LANDS**: the header gains overall coverage (stmts, missed, percentage); the Per-Module Coverage table is replaced entirely from actual `npx vitest run --coverage` output — never hand-edit individual rows; add a Modules Below Target table (every module under the CI threshold with cover percentage and missed statement count); unit-test counts come from the Vitest run summary
- **Last Updated**: date, author, changelog summary

### 5. Commit documentation, run commit hash update, push

```bash
git -C "/Users/Conrad/Desktop/lastminuteoutdoors" add \
    "LLM coding agent documents/domains-function-map.md" \
    "LLM coding agent documents/FUNCTION_DEPENDENCY_MAP.jsonl" \
    "LLM coding agent documents/SERVICE_DOCUMENTATION.md" \
    "LLM coding agent documents/TEST_DOCUMENTATION.md"
git -C "/Users/Conrad/Desktop/lastminuteoutdoors" commit -m "docs(prN): update function maps, SERVICE/TEST docs"

bash "/Users/Conrad/Desktop/lastminuteoutdoors/LLM coding agent documents/scripts/update_doc_commit_hash.sh"
git -C "/Users/Conrad/Desktop/lastminuteoutdoors" add \
    "LLM coding agent documents/SERVICE_DOCUMENTATION.md" \
    "LLM coding agent documents/TEST_DOCUMENTATION.md" \
    "LLM coding agent documents/domains-function-map.md"
git -C "/Users/Conrad/Desktop/lastminuteoutdoors" commit -m "chore(docs): update commit hash to $(git -C "/Users/Conrad/Desktop/lastminuteoutdoors" rev-parse HEAD)"
git -C "/Users/Conrad/Desktop/lastminuteoutdoors" push
```

The hash update must run after the documentation commit because it stamps the hash of the commit that contains the documentation changes. Two commits are required: one for the content, one for the hash.

> **Orchestrated worktree runs**: when this runbook executes as Stage 5 of `orchestrate-agents.sh`, do **not** commit or push — the orchestrator leaves the worktree fully STAGED and the user performs the manual commit / squash-merge / push per `WORKTREE_TO_MAIN_PLAYBOOK.md`. In that mode, stop after the first `git add` and skip the hash-stamp commit (the user re-runs `update_doc_commit_hash.sh` after the manual commit). Substitute the worktree path (e.g. `/Users/Conrad/Desktop/lastminuteoutdoors-wt-<feature>`) in the `git -C` commands above.

## Verification checklist

- [ ] `npm run css` succeeds and the regenerated `prototype/css/app.css` diff is fully explained by this PR
- [ ] Tier-0 visual suite passes: Playwright pixel-compare of every touched page (both locales) shows only intended diffs
- [ ] Unit tests pass with coverage >= threshold [N/A — no Vitest yet; becomes `npx vitest run --coverage` when the app lands]
- [ ] E2E / component tests pass [N/A — project does not use E2E tests yet]
- [ ] Integration tests pass (when applicable) [N/A — none yet]
- [ ] `domains-function-map.md` updated — file/page/token counts match the codebase
- [ ] `FUNCTION_DEPENDENCY_MAP.jsonl` updated (and `lmo-db-schema.jsonl` when the Drizzle schema changes)
- [ ] Every production file in the function map has a SERVICE_DOCUMENTATION.md section; the Wireframe Page Inventory is current
- [ ] Every new/modified token group, component, or function documented with correct signature
- [ ] QA findings documented as Design Notes
- [ ] TEST_DOCUMENTATION.md Test Run Status matches the actual Step 1 output exactly [coverage table from `npx vitest run --coverage` — N/A until Vitest lands]
- [ ] TEST_DOCUMENTATION.md unit and E2E counts match the runner's output [N/A until Vitest lands]
- [ ] Commit hashes synchronized across SERVICE_DOCUMENTATION.md, TEST_DOCUMENTATION.md, domains-function-map.md (via `scripts/update_doc_commit_hash.sh`)
- [ ] `git -C "/Users/Conrad/Desktop/lastminuteoutdoors" status` is clean — no uncommitted documentation changes [orchestrated worktree runs: fully staged instead]
