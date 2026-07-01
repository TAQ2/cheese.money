# Full Documentation Update — Coding Agent Runbook

Run this after a change's code changes are complete and before the final push. Documentation begins **only after all verification gates pass** — never document a broken build. The orchestrator's Stage 5 executes this runbook verbatim, so fill the `{{PLACEHOLDERS}}` with your project's real commands and doc set.

## Steps

### 1. Run the full validation gauntlet
Every gate must pass before documentation begins. If any fails, fix the code first.
```bash
{{your build command}}        # e.g. compile / bundle / generate assets — must succeed
{{your type-check command}}   # if applicable — must be clean
{{your lint command}}         # lint + format gate
{{your test command}}         # unit/integration tests, with coverage if you enforce a threshold
```
For any **generated artifact** (CSS/JS bundles, schema dumps, lockfiles), rebuild it and confirm its diff is fully explained by this change's source changes — never hand-edit generated output.

**Stop here if anything fails.** The verification output from this step is the source of truth for the numbers in your test docs — save or reference it.

### 2. Regenerate function / dependency maps
Update your machine-readable reference artifacts (e.g. a function-map, a dependency map, a DB-schema dump) to reflect this change. If you have generator scripts, run them here; otherwise maintain the maps by hand. Run generators from the repo root (`git rev-parse --show-toplevel`), or from inside the worktree when running under the orchestrator.

### 3. Identify and fill service/architecture documentation gaps
Compare the updated maps against your service/architecture docs:
- Every production file in the map must have a corresponding section in the docs.
- New files from this change get full sections (purpose, imports/imported-by, function/class/symbol docs, design notes).
- Modified files get their sections updated (new symbols, changed signatures, new parameters).
- QA findings (awareness-only or code-change) are captured as design notes.
- Never document generated output.

### 4. Update test documentation from actual output
Use the saved verification output from Step 1 — never guess or carry forward stale numbers. Update: the header (commit hash, date, verification mode), the test-run status (results + a changelog entry), per-module sections (each new test file: count, scenarios, known gaps), and coverage tables **regenerated from the runner's output**, never hand-edited row by row.

### 5. Commit the docs, stamp the commit hash, push
```bash
cd <repo>
git add {{your doc set: service docs, test docs, function/dependency maps}}
git commit -m "docs: update function maps + service/test docs"
{{optional: run your doc-commit-hash stamp script}}   # stamps the hash of the docs commit
git add {{the stamped docs}} && git commit -m "chore(docs): update commit hash"
git push
```
The hash stamp (if you use one) runs **after** the docs commit, so it records the hash of the commit that contains the docs.

> **Orchestrated worktree runs**: when this runs as Stage 5 of `orchestrate-agents.sh`, do **not** commit or push — Stage 6 (or your manual merge-back per `WORKTREE_TO_MAIN_PLAYBOOK.md`) handles that. In that mode, stop after the first `git add`. Substitute the worktree path in any `git -C` commands.

## Verification checklist
- [ ] Build / type-check / lint / tests all pass; generated artifacts rebuilt and their diffs explained by this change
- [ ] Coverage ≥ your threshold (if enforced)
- [ ] Function / dependency / schema maps updated to match the codebase
- [ ] Every production file in the maps has a docs section; inventories (page/module lists) current
- [ ] Every new/modified symbol documented with correct signature
- [ ] QA findings captured as design notes
- [ ] Test docs match the actual Step 1 output exactly (coverage tables regenerated, not hand-edited)
- [ ] Commit hashes synchronized across the doc set (if you stamp them)
- [ ] `git status` clean — no uncommitted documentation changes (orchestrated worktree runs: fully staged instead)
