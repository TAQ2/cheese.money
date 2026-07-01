# Agentic Coding Harness

A drop-in, project-agnostic harness for running a **Brain Agent ↔ Coding Agent ↔ Independent Reviewer** workflow that plans, implements, QAs, documents, and ships a code change as a pull request — fully automated, with human checkpoints.

This folder is the **abstracted, reproducible form** of a harness that runs in production across several real repositories. It is distilled from the **Last Minute Outdoors (LMO)** instantiation, used here as the reference implementation. The doctrine, templates, and playbooks are project-agnostic — project specifics are lifted into `{{placeholders}}` and the instantiation guide. The **orchestrator engine is included as-is**: its `CONFIG / ADAPT` header marks the values to change per project, and a few of its internal paths still reference the reference implementation until you adapt them.

---

## What it is

A single Bash orchestrator drives **N persistent interactive `claude` sessions inside a detached tmux session** — one window per agent role — through a **6-stage pipeline**:

```
Stage 1  Brain Agent (Mode 1)     Planning + Code Change Request (user checkpoint)
Stage 2  Coding Agent             Implementation of the CCR
         └─ Reduction pass        Test-gated subtractive turn (shrink the diff, no behavior change)
Stage 3  Brain Agent (Mode 2)     QA review + fix loop until convergence
Stage 4  Independent Reviewer(s)  Fresh Brain sessions + fix loops (N rounds)
Stage 5  Coding Agent             Documentation finalization via runbook
Stage 6  Git Operations           Rich commit (full template body) → push branch  [STAGE6_MODE=commit, default]
                                   — or — subject-only commit → push → draft PR   [STAGE6_MODE=pr, gh / tea]
```

Everything runs inside a disposable **git worktree** branched from the tip of the current PR stack. Nothing is committed to the working repo until Stage 6. Every prompt, raw output, session, and artifact is persisted under `runs/<repo>/<timestamp>/` so any run is fully resumable and auditable.

---

## The pieces

| Path | What it is | Adapt? |
|---|---|---|
| `orchestrate-agents.sh` | The orchestrator engine (tmux variant). | Edit the **CONFIG / ADAPT** header block (workspace dir, VCS host, commit convention, `STAGE6_MODE`). |
| `doctrine/MINIMUM_ENTROPY_MANIFESTO.md` | The complexity doctrine — *how much* you build. Prime directive: Principle 0. | Language- and codebase-agnostic; keep verbatim (swap the one project-anchored example in 0.7). |
| `doctrine/CAVEMAN_CODE.md` | Operational companion — smallest-diff, read-before-write working mode. | Keep verbatim. |
| `templates/BRAIN_AGENT.template.md` | Brain Agent (planner/reviewer) instructions. | Fill `{{PLACEHOLDERS}}`. |
| `templates/CODING_AGENT.template.md` | Coding Agent (implementer) instructions. | Fill `{{PLACEHOLDERS}}`. |
| `templates/TPM_AGENT.template.md` | TPM Agent — the human-driven bookends around the orchestrator: frames the smallest Product Brief upstream of Brain (Phases 1–3), acts as the stakeholder's proxy when downstream agents return questions (Phase 4), and gates the merge-to-`main` on business outcome (Phase 5). | Fill `{{PLACEHOLDERS}}`. |
| `templates/PR_DESCRIPTION_TEMPLATE.md` | Canonical PR body Stage 6 makes the agent fill. | Generic; trim sections you don't use. |
| `playbooks/LLM_CODING_AGENT_CREATION.md` | How to generate the three agent docs for a brand-new repo. | Follow it. |
| `playbooks/FULL_DOCUMENTATION_UPDATE.md` | The doc-update runbook Stage 5 executes. | Light edits for your doc set. |
| `playbooks/WORKTREE_TO_MAIN_PLAYBOOK.md` | Manual merge-back fallback (if you stop before Stage 6). | Light edits. |
| `playbooks/STACKED_PR_MERGE_PLAYBOOK.md` | Stacked-PR landing order + base updates. | Light edits. |

---

## The core idea (read this even if you read nothing else)

The harness is opinionated about **one thing above all**: **Minimum Entropy** (Principle 0). Every line of code is a liability; the bug rate of code that does not exist is zero. The best diff is net-negative. The whole pipeline exists to make a change land **small, correct, readable, and reviewable** — the planning checkpoint, the QA loop, the independent reviewers, the dedicated subtractive reduction pass, and the falsifiable PR body all serve that one goal.

The doctrine is carried in three places that must stay in agreement:
1. **`MINIMUM_ENTROPY_MANIFESTO.md`** — the long-form *why*.
2. The **Principle 0 + Operating Rules (0.1–0.7)** block embedded in each agent doc — the distilled *what*, **identical in the Brain and Coding docs**.
3. **`CAVEMAN_CODE.md`** — the keystroke-level *how*.

---

## Prerequisites

| Tool | Why |
|---|---|
| Claude Code CLI (authenticated) | Drives every agent turn |
| `tmux` | Each agent session runs in a tmux pane (keeps usage on the subscription pool) |
| `bash` ≥ 4 | Uses `mapfile` (macOS ships 3.2 — `brew install bash`) |
| `jq` | Parses the Claude CLI stream-json output |
| `git` with worktrees | All stages run inside a disposable worktree |
| `gh` (GitHub) **or** `tea` (Gitea) | Only for `STAGE6_MODE=pr` — Stage 6 opens a draft PR (pick the one matching your remote). Not needed in the default commit mode |

---

## Quick start

1. Copy this folder into your repo (or a sibling "LLM coding agent documents/" folder).
2. Edit the **CONFIG / ADAPT** block at the top of `orchestrate-agents.sh`.
3. Generate your agent docs from the templates — see [`INSTANTIATE.md`](./INSTANTIATE.md) and [`playbooks/LLM_CODING_AGENT_CREATION.md`](./playbooks/LLM_CODING_AGENT_CREATION.md).
4. Run it:
   ```bash
   ./orchestrate-agents.sh --task "Add a /health endpoint that returns build SHA"
   ```

Full step-by-step in [`INSTANTIATE.md`](./INSTANTIATE.md).

---

## Safety model

- Runs inside a **git worktree** — agents can only mutate the worktree, never the original repo root.
- **Staged-but-not-committed** until Stage 6 — bail at any checkpoint and inspect with `git diff`.
- **Rich commit by default, or draft PR** — by default (`STAGE6_MODE=commit`) Stage 6 ends with one rich, template-compliant commit pushed to the worktree branch (no PR), for a human to fast-forward into `main`; set `STAGE6_MODE=pr` to open a draft instead (`gh --draft` / Gitea `WIP:` prefix) that a human marks ready.
- Global + inactivity timeouts kill hung runs; an oversized-prompt guard rejects prompts before they hit Claude.
