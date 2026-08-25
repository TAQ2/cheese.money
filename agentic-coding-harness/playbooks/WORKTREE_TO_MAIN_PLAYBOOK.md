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

### 4. Dry-run, then land it
```bash
# Prefer the fast-forward: if `<base>` has not moved and the run left its rich commit(s) on the
# branch, this lands them untouched — the long-form body survives with no `-C` needed, and the
# branch stays a true ancestor, so the guarded `git branch -d` works at purge time.
git -C <repo> merge --ff-only <branch>
```
If that refuses, `<base>` moved (or the branch is not a descendant) — merge `<base>` forward inside
the worktree and try again, or take the squash path below and accept that the purge will need the
evidence check in step 9.

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

### 8. Publish the deploy plan — then fire the parts you own
**Publish it as bullets, never prose**: numbered, in execution order, one action per bullet, each tagged `[me]` or `[human]` and each naming the proof you will check (log line, DB row, endpoint, pixel). Where the project's deploy tool collects a human gate per run (Touch ID, hardware key), the `[me]` bullets are yours to fire in plan order — that gate is the approval, and you never route around it. Where it does not, every deploy bullet is `[human]`.

Report the SHA now on `origin/<base>` and the exact deploy commands/console steps in order, including every Manual / Ops step the brief flagged (DDL, env vars, third-party dashboards, scheduled jobs, service restarts) and their ordering. If the deploy is push-triggered, say so — the push *was* the deploy, and the confirmation is just the human seeing it live.

### 9. On the human's deploy confirmation: purge the scaffolding — unasked
```bash
git -C <repo> worktree remove <repo>-wt-<feature>   # --force only if dirty AND nothing unlanded is inside
git -C <repo> branch -d <branch>                    # lowercase: git refuses unless the work really is on <base>
git -C <repo> push origin --delete <branch>         # only if that branch was ever pushed
git -C <repo> worktree prune
```
Then state in one line what was removed. A worktree still on disk after a confirmed deploy is unfinished Phase 5 work.

**`-d`, not `-D`.** A fast-forward landing leaves the branch a true ancestor of `<base>`, so the
lowercase, *guarded* delete succeeds and costs nothing. After a **squash** landing git still reads
the branch as unmerged and `-d` refuses — that refusal is a question to answer, not a flag to
upgrade. Prove the content actually landed (`git -C <repo> diff <base> <branch>` empty, or
`git -C <repo> cherry -v <base> <branch>` showing every commit as `-`), and only then `-D`. Never reach for
`-D` because `-d` complained: a genuine refusal means something still exists only on that branch.
(`git branch -D` is denied outright by policy in some repos for exactly this reason, and the deny
list is case-sensitive — `-d` runs unprompted.)

## Recovery if the commit body was already lost
The branch commit object survives locally even after the branch is deleted:
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
git -C <repo> worktree remove <repo>-wt-<feature> && git -C <repo> branch -d <branch> && git -C <repo> worktree prune
```
