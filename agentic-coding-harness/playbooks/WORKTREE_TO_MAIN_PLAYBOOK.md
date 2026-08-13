# Worktree → Main — Merge Playbook (agent-executed)

How a completed orchestration worktree is brought onto the base branch and pushed. **This is a procedure the TPM agent runs itself at the Phase 5 gate, not a checklist handed to a human.** Every step below is a command the agent executes; no step waits for permission, and none of it happens in an editor's Source Control panel. The human's only act in this whole procedure is the deploy in step 8 — and its confirmation is what triggers step 9.

Use it in two situations: Stage 6 ran in `STAGE6_MODE=commit` (default) and left a single rich, long-form commit on the worktree branch — review it and land it; or the run stopped **before** Stage 6, leaving staged-uncommitted work — commit it on the branch first (step 1), then land it. One worktree at a time, sequentially.

Placeholders: `<repo>` = the repo working dir · `<repo>-wt-<feature>` = the orchestrator's worktree · `<branch>` = the worktree branch · `<base>` = the target branch (usually `main`).

## Prerequisites
- The orchestration finished its stages inside the worktree.
- The run artifacts (CCR, QA reports) are read and the Phase 5 business-outcome verdict is `PASS`. On `HOLD`, none of this runs.

## The one law

**The Stage 6 commit body must survive onto `<base>`.** That body is the only durable record of *why* the change looks the way it does. `git merge --squash` preserves the tree and **silently discards every branch commit message** — so `--squash` followed by a bare `git commit -m` destroys it with no warning, no conflict, and a clean-looking result. Always `git commit -C <branch>` (or `-c` to append a merge-gate section — append, never replace), and prove it before pushing.

## Steps

### 1. Commit inside the worktree — only if Stage 6 did not
If Stage 6 ran in commit mode, the rich commit is already on the branch; skip to step 2.
```bash
git -C <repo>-wt-<feature> status
git -C <repo>-wt-<feature> commit -m "<commit message from the CCR>"
```

### 2. Get onto a current base, and confirm it is clean
```bash
git -C <repo> checkout <base> && git -C <repo> pull origin <base>
git -C <repo> status            # must be clean — commit or stash anything first
```

### 3. Divergence check
```bash
git -C <repo> rev-parse <branch>^        # the rich commit's parent
git -C <repo> rev-parse <base>           # differ? <base> moved during the run
```
On divergence: **never rebase the worktree branch** — rebasing rewrites the exact tree QA reviewed, so what lands is no longer what was approved. `git cherry-pick -n <rich-commit>` onto `<base>` and resolve every conflict as a **union** of both sides (both parents' imports, list entries, doc rows, dependency edges kept; recompute counts/totals from the merged rows rather than picking either side's number). Then re-run the touched suites — a union tree is a tree nothing has ever run.

### 4. Dry-run, then stage the merge
```bash
git -C <repo> merge-tree --write-tree --name-only <base> <branch>   # exit 0, no file list = clean
git -C <repo> merge <branch> --squash --no-commit
git -C <repo> diff --cached --name-only                            # audit: nothing unrelated staged
```

### 5. Review the complete staged diff
Every changed file and every newly-added file — the whole blast radius, not a sample of filenames. Read the source, not the implementation report.

### 6. Re-run the project's validation and regenerate build artifacts
Build / lint / test, plus any generated CSS, JS, lockfiles or schema dumps, so the staged set is complete and green. **Never hand-edit a generated file** — regenerate it and stage the output.

### 7. Commit, prove the body survived, push
```bash
git -C <repo> commit -C <branch>
git -C <repo> log -1 --format=%B | wc -w      # hundreds of words, not tens
git -C <repo> push origin <base>
```
The push is part of the landing, not a separate favour to be requested afterwards.

### 8. Hand the human deployment instructions — the one human step
Report the SHA now on `origin/<base>` and the exact deploy commands/console steps in order, including every Manual / Ops step the brief flagged (DDL, env vars, third-party dashboards, scheduled jobs, service restarts) and their ordering. If the deploy is push-triggered, say so — the push *was* the deploy, and the confirmation is just the human seeing it live.

### 9. On the human's deploy confirmation: purge the scaffolding — unasked
```bash
git -C <repo> worktree remove <repo>-wt-<feature>   # --force only if dirty AND nothing unlanded is inside
git -C <repo> branch -D <branch>                    # -D: --squash leaves it "unmerged" in git's eyes
git -C <repo> push origin --delete <branch>         # only if that branch was ever pushed
git -C <repo> worktree prune
```
Then state in one line what was removed. A worktree still on disk after a confirmed deploy is unfinished Phase 5 work.

## Recovery if the commit body was already lost
The branch commit object survives locally even after `git branch -D`:
```bash
git log -1 --format=%B <old-branch-sha> > /tmp/newmsg.txt
git commit --amend -F /tmp/newmsg.txt
git rev-parse HEAD^{tree}                # MUST equal the pre-amend tree
git push --force-with-lease origin <base>
```
Amending rewrites only the message; verify the tree hash is unchanged before pushing. Force-pushing `<base>` rewrites published history — solo repos only, or coordinate first.

## Stale base
The worktree branches from `<base>` at run start. If `<base>` advances during the run, `git diff <base> <branch>` renders the newer commits as **reversions** — a two-dot artifact, not reality. Always review against the merge-base:
```bash
git diff --stat $(git merge-base <base> <branch>) <branch>
```
`git merge-tree` (step 4) is the authoritative check for whether the merge is clean.

## Multiple worktrees
Repeat 1–9 for each, one at a time, to keep history linear and avoid conflicts.

## Quick reference
```bash
git -C <repo>-wt-<feature> add -A && git -C <repo>-wt-<feature> commit -m "COMMIT_MSG"   # only if Stage 6 didn't
git -C <repo> checkout <base> && git -C <repo> pull origin <base>
git -C <repo> merge <branch> --squash --no-commit
# → review the full diff, run the project's checks, then:
git -C <repo> commit -C <branch> && git -C <repo> log -1 --format=%B | wc -w
git -C <repo> push origin <base>
# → report the SHA + deployment instructions; on the human's deploy confirmation:
git -C <repo> worktree remove <repo>-wt-<feature> && git -C <repo> branch -D <branch> && git -C <repo> worktree prune
```
