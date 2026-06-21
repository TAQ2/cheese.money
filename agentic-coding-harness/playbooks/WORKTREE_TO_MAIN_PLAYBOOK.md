# Worktree to Main — Manual Merge Playbook

How to merge a completed orchestration worktree back into the base branch as **staged (uncommitted)** changes, so you review them in your editor's Source Control panel before committing. Use this when you stop **before** the orchestrator's Stage 6 (auto-PR) and merge by hand. One worktree at a time, sequentially.

Placeholders: `<repo>` = your repo working dir · `<repo>-wt-<feature>` = the orchestrator's worktree · `<feature>` = the worktree branch · `<base>` = the target branch (usually `main`).

## Prerequisites
- The orchestration finished its stages inside the worktree.
- You reviewed the run artifacts (CCR, QA reports) and are satisfied.

## Steps

### 1. Commit the staged changes inside the worktree
The Coding Agent only `git add`s; commit them on the feature branch so `git merge` has something to merge.
```bash
cd <repo>-wt-<feature>
git status                       # review what's staged
git commit -m "<commit message from CCR Section 8>"
```

### 2. Go to the main working directory and verify it's clean
```bash
cd <repo>
git status                       # must be clean — commit/stash anything first
```

### 3. Squash-merge into the staging area (no commit)
```bash
git merge <feature> --squash --no-commit
```
This brings all the worktree's changes into your staging area on `<base>` **without committing**. Your editor's Source Control panel now shows them all as staged for review.

### 4. Review, then run your validation
Review the diffs. Re-run **your project's build / lint / test commands** and regenerate any build artifacts (generated CSS/JS, lockfiles, schema dumps) so the staged set is complete and green. **Never hand-edit a generated file** — regenerate it and stage the output.

### 5. Commit manually
Commit from the Source Control panel (or terminal) with the commit message from CCR Section 8.

### 6. Push (and deploy per your pipeline)
```bash
git push origin <base>
```
If your deploy is push-triggered (CI → production), the push *is* the deploy. Otherwise run your deploy step.

### 7. Remove the worktree + delete the branch
```bash
cd <repo>
git worktree remove ../<repo>-wt-<feature>
git branch -D <feature>          # -D because --squash leaves it "unmerged" in Git's eyes
```

## Multiple worktrees
Repeat 1–7 for each, **one at a time**, to keep history linear and avoid conflicts.

## Quick reference
```bash
cd <repo>-wt-<feature> && git add -A && git commit -m "COMMIT_MSG"
cd <repo>             && git merge <feature> --squash --no-commit
# → review + run your checks, commit, then:
git push origin <base>
git worktree remove ../<repo>-wt-<feature>
git branch -D <feature>
```
