# Stacked PR Merge-Forward Playbook

## Context

Many teams use **squash-and-merge**. When a PR is squash-merged, the host (GitHub/Gitea) creates a new commit hash on the base branch that does not match the original branch's commits. Downstream branches in a **stacked PR chain** can't recognize that squash commit, so they show conflicts with the base even though the content is logically identical.

This playbook resolves those conflicts safely. Run it **each time a stacked PR is merged and the next PR in the chain needs to become mergeable**.

Placeholders: `<base>` = base branch (usually `main`) · `<pr-branch>` = the next PR's branch · `<number>` = its PR number.

## Prerequisites
- The prior PR in the stack was **merged** (squash-and-merge completed).
- You have the next PR's branch name (`gh pr view <number> --json headRefName`, or `tea` equivalent).

## Strategy A: Cherry-pick (preferred — clean, linear history)

### 1. Fetch the latest base and the PR branch
```bash
git fetch origin <base> <pr-branch>
```
### 2. Identify the PR's own commits (not already on base)
```bash
git log --oneline origin/<pr-branch> --not origin/<base>
```
Keep only the commits that belong to **this** PR (the ones after the last predecessor PR's final commit — earlier ones are already on base via squash).
### 3. Fresh branch from base, cherry-pick this PR's commits oldest-first
```bash
git checkout origin/<base> -b <pr-branch>-v2
git cherry-pick <commit1> <commit2> ... <commitN>
```
On conflict: resolve manually, then `git add -A && git cherry-pick --continue --no-edit`. **Never hand-resolve a generated/build-output file** — resolve its source, regenerate it, and stage the output.
### 4. Run your local checks
Run your project's full validation (build, lint, type-check, tests). Do not rely on CI alone.
### 5. Replace the original branch
```bash
git push origin <pr-branch>-v2:<pr-branch> --force-with-lease
```
### 6. Verify mergeable, then clean up
```bash
gh pr view <number> --json mergeable --jq '.mergeable'   # must be MERGEABLE
git branch -D <pr-branch>-v2
```

## Strategy B: Merge with `-X ours` (fallback)

Use when cherry-picking is impractical (too many commits, or merge commits in the chain). Produces a merge commit and less-clean history.

### 1–3. Fetch, reset the PR branch, merge base favoring the PR
```bash
git fetch origin <base>
git checkout <pr-branch> && git reset --hard origin/<pr-branch>
git merge origin/<base> -X ours
```
`-X ours` keeps the PR branch's version for every conflict — safe because the PR was built on top of the prior PR and already contains the correct code; the base's squash commit is a repackaging of what the PR already has.

### 4. Fix what `-X ours` silently dropped
`-X ours` can keep the PR's **older** version of a file when the base has a **fix** the PR never received. Watch for:
- **Dependency/lockfile drift** — the manifest pins an old version but the environment has a newer one (installed by a prior session). Align them; if the current PR doesn't touch the dependency files, take the base's: `git checkout origin/<base> -- <manifest> <lockfile>` and reinstall.
- **Duplicated blocks** — a non-conflicting addition from the base that the PR already had, now duplicated. Remove the duplicate.
- **Generated output out of sync** — a build artifact kept the PR's older output while its source changed on the base. Regenerate and stage.

**Rule of thumb**: if a file was changed by a *prior* PR (not the current one), it's safe to take the base's version (`git checkout origin/<base> -- <file>`). If the *current* PR also modifies it, merge manually.

### 5–6. Re-run checks, push, verify
```bash
git push origin <pr-branch>
gh pr view <number> --json mergeable --jq '.mergeable'   # must be MERGEABLE
```

## Critical constraints
1. **Sequential only** — each PR must be merged before proceeding; the squash commit on base is required.
2. **Always base on `origin/<base>`** — merging local branches into each other does not work with squash merges.
3. **Verify locally before pushing** — run all applicable checks; don't rely on CI alone.
4. **Cherry-pick is preferred** — clean history, and the PR diff shows only the PR's own changes. Use the fallback only when cherry-picking is impractical.
5. **Watch for environment drift** — installing packages mutates the shared dependency tree across PRs; verify installed versions match the branch's lockfile (a clean install gives a clean slate).
