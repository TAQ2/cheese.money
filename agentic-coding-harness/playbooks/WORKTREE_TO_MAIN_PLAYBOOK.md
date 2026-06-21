# Worktree to Main — Manual Merge Playbook

This playbook covers how to merge a completed worktree back into `main` so the changes appear as staged (uncommitted) changes in VS Code's Source Control panel. Execute these steps **one worktree at a time, sequentially**. Do not merge multiple worktrees simultaneously.

## Prerequisites

- The orchestration script has finished all 5 stages inside the worktree
- You have reviewed the orchestration artifacts (CCR, QA reports) and are satisfied
- You are ready to commit and deploy this feature

## Steps

### 1. Commit all changes inside the worktree

The Coding Agent only stages files (`git add`). You need to commit them on the feature branch so `git merge` has something to work with.

```bash
cd /Users/Conrad/Desktop/lastminuteoutdoors-wt-<feature-name>
git status                    # review what's staged
git commit -m "<commit message from CCR Section 8>"
```

### 2. Go to the main working directory

```bash
cd /Users/Conrad/Desktop/lastminuteoutdoors
```

### 3. Verify main is clean

```bash
git status
```

If there are uncommitted changes on `main`, commit or stash them first. The merge requires a clean working tree.

### 4. Merge with squash and no-commit

```bash
git merge <feature-branch-name> --squash --no-commit
```

This brings all the worktree's changes into your staging area on `main` **without creating a commit**. VS Code's Source Control panel will now show all the changes as staged.

### 5. Review in VS Code

Open VS Code on the `lastminuteoutdoors/` folder. The Source Control panel shows all staged changes. Review the diffs. If anything needs adjustment, edit the files and re-stage. (If the change touched `prototype/css/tailwind.css`, `prototype/css/theme.css`, or used new utility classes in HTML, confirm the regenerated `prototype/css/app.css` is part of the staged set — run `npm run css` if it is not.)

### 6. Commit manually

Commit from VS Code's Source Control panel (or terminal) with the commit message from the CCR Section 8.

### 7. Push and deploy

```bash
git push origin main
```

Today the repo is a static HTML/CSS prototype — there is nothing to deploy; pushing `main` ends the procedure. To eyeball the result locally, serve the prototype:

```bash
cd /Users/Conrad/Desktop/lastminuteoutdoors/prototype && python3 -m http.server 5555
```

When the Next.js app lands on Vercel, the push itself is the deploy: `git push` → CI gates → production (per `MANIFESTO.md`). There is no SSH or manual deploy step in this project — ever (SSH-based ops are on the Forbidden list).

### 8. Remove the worktree

```bash
cd /Users/Conrad/Desktop/lastminuteoutdoors
git worktree remove ../lastminuteoutdoors-wt-<feature-name>
```

### 9. Delete the feature branch

```bash
git branch -d <feature-branch-name>
```

If the branch wasn't "merged" in Git's eyes (because we used `--squash`), use:

```bash
git branch -D <feature-branch-name>
```

## Multiple Worktrees

If you have multiple finished worktrees, repeat steps 1-9 for each one, in order. Always merge one at a time to keep the history linear and avoid conflicts.

## Quick Reference

```bash
# Full single-worktree merge sequence (copy-paste template)
cd /Users/Conrad/Desktop/lastminuteoutdoors-wt-FEATURE
git add -A && git commit -m "COMMIT_MSG"
cd /Users/Conrad/Desktop/lastminuteoutdoors
git merge FEATURE --squash --no-commit
# → Review in VS Code, commit, then:
git push origin main
git worktree remove ../lastminuteoutdoors-wt-FEATURE
git branch -D FEATURE
```
