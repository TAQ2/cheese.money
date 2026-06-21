# Stacked PR Merge-Forward Playbook

## Context

This repository (`TAQ2/lastminuteoutdoors`, remote `origin` = `git@github.com:TAQ2/lastminuteoutdoors.git`, default branch `main`) uses **squash-and-merge** on GitHub. When a PR is squash-merged, GitHub creates a new commit hash on `main` that does not match the original branch's commits. Downstream branches in a stacked PR chain cannot recognize this squash commit, so they show merge conflicts with `main` even though the content is logically identical.

This playbook resolves those conflicts safely and must be executed **every time a stacked PR is merged and the next PR in the chain needs to become mergeable**.

## Prerequisites

- The prior PR in the stack has been **merged on GitHub** (squash-and-merge completed).
- You have the next PR's branch name (check with `gh pr view <number> --json headRefName`).

## Strategy: Cherry-Pick (Preferred)

The cherry-pick strategy produces a **clean, linear history** with no merge commits. It creates a fresh branch from `main` and replays only the commits that belong to the current PR. This is the preferred approach.

### 1. Fetch latest main and the PR branch

```bash
git fetch origin main <pr-branch>
```

### 2. Identify the PR's own commits

List commits on the PR branch that are NOT on main:

```bash
git log --oneline origin/<pr-branch> --not origin/main
```

From this output, identify which commits belong to the **current PR** vs commits from earlier PRs in the stack (those are already on main via squash). The current PR's commits are the ones added after the last predecessor PR's final commit.

If the PR was based directly on the prior PR's branch, you can also use:

```bash
git log --oneline origin/<pr-branch> --not <last-commit-of-prior-pr>
```

### 3. Create a fresh branch from main

```bash
git checkout origin/main -b <pr-branch>-v2
```

### 4. Cherry-pick the PR's commits in order

```bash
git cherry-pick <commit1> <commit2> ... <commitN>
```

List commits oldest-first (bottom of `git log` output first).

If a cherry-pick conflicts:
- Resolve the conflict manually (usually doc files with different base content). Special case: never hand-resolve a conflict in `prototype/css/app.css` — it is generated. Resolve `prototype/css/tailwind.css` / `prototype/css/theme.css` instead, run `npm run css`, and stage the regenerated output.
- `git add -A && git cherry-pick --continue --no-edit`

### 5. Run all local checks

```bash
# CSS build — prototype/css/app.css is generated; it must rebuild cleanly and the
# regenerated file must match what is committed on the branch
npm run css
git status --short -- prototype/css/app.css

# Tier-0 visual verification — Playwright screenshot pixel-compare of the pages this
# PR touches, in both locales (serve with: cd prototype && python3 -m http.server 5555)

# WHEN THE NEXT.JS APP LANDS (MANIFESTO.md quality gates):
# npm run typecheck
# npx biome check .
# npx vitest run
```

### 6. Force-push to the original PR branch

```bash
git push origin <pr-branch>-v2:<pr-branch> --force-with-lease
```

This replaces the old branch with the clean cherry-picked version.

### 7. Verify on GitHub

```bash
gh pr view <number> --json mergeable --jq '.mergeable'
```

Must return `MERGEABLE`. The PR should now show a clean diff against `main` with only the PR's own changes.

### 8. Clean up the local temporary branch

```bash
git branch -D <pr-branch>-v2
```

---

## Strategy: Merge with `-X ours` (Fallback)

Use this when cherry-picking is impractical (e.g., too many commits to identify, or the PR has merge commits that can't be cherry-picked). This produces a merge commit and a less clean history.

### 1. Fetch latest main

```bash
git fetch origin main
```

### 2. Checkout and reset the next PR branch

```bash
git checkout <next-pr-branch>
git reset --hard origin/<next-pr-branch>
```

### 3. Merge main into the PR branch, favoring the PR's code

```bash
git merge origin/main -X ours
```

`-X ours` means: for every conflict, keep the PR branch's version. This is safe because the PR was built on top of the prior PR and already contains the correct version of all conflicting code. Main's squash commit is a repackaging of what the PR already has.

### 4. Run all local checks

```bash
# Run the same checks as Strategy 1, Step 5:
# npm run css + git status --short -- prototype/css/app.css
# Playwright screenshot pixel-compare of touched pages (both locales)
# (typecheck / Biome / Vitest once the Next.js app lands)
```

### 5. Fix any issues from `-X ours` silently dropping main's changes

The `-X ours` strategy can silently keep the PR's **older** version of a file when main has a **fix** that the PR branch never received. Common symptoms:

- **Library version mismatch**: The environment has a newer library (installed into `node_modules/` by a prior PR session) but `package.json`/`package-lock.json` has the old pin. Fix: check the installed version (`npm ls <pkg>`) against the manifest and align them. If the current PR doesn't modify the dependency files, take main's version with `git checkout origin/main -- package.json package-lock.json` and run `npm ci`.
- **Duplicate code blocks**: Git auto-merges a non-conflicting addition from main that the PR already has, resulting in duplicated functions/imports (or duplicated HTML sections / CSS rules in the prototype). Fix: remove the duplicate.
- **Generated output out of sync**: `prototype/css/app.css` kept the PR's older generated output while `tailwind.css`/`theme.css` (or utility classes in HTML) gained changes from main. Fix: re-run `npm run css` and commit the regenerated file.

**Rule of thumb**: If a file was changed by a *prior* PR (not the current one), it is safe to take main's version with `git checkout origin/main -- <file>`. If the *current* PR also modifies that file, you must merge manually — taking main's version would overwrite the current PR's feature additions.

### 6. Re-run all checks after fixes

Repeat Step 4 to confirm everything passes.

### 7. Push

```bash
git push origin <next-pr-branch>
```

### 8. Verify on GitHub

```bash
gh pr view <number> --json mergeable --jq '.mergeable'
```

Must return `MERGEABLE`. If it still shows `CONFLICTING`, main may have moved again — repeat from Step 1.

---

## Critical Constraints

1. **Sequential only** — Each PR must be merged on GitHub before proceeding to the next. The squash commit on main is required.
2. **Never skip `origin/main`** — Merging local branches into each other does NOT work with squash merges. Always base on `origin/main`.
3. **Always verify locally before pushing** — Run all applicable checks (today: CSS build + visual pixel-compare; plus typecheck, tests, and linting once the app lands). Do not rely on CI alone.
4. **Cherry-pick is preferred** — It produces clean history, avoids merge commits, and makes the PR diff on GitHub show only the PR's own changes. Use the merge fallback only when cherry-picking is impractical.
5. **Watch for environment drift** — When working on multiple PRs in one session, installing packages changes the shared `node_modules/`. A PR may pass checks because the environment has a newer library than what `package-lock.json` specifies. Always verify installed versions match the branch's lockfile — `npm ci` gives a clean slate.
