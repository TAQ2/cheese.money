# Instantiating the harness for a new repository

This is the step-by-step to turn the generic harness in this folder into a working setup for **your** repo. Allow ~30–60 minutes the first time.

> Reference instantiation: **Last Minute Outdoors (LMO)**. Where a choice is non-obvious, "what LMO did" is called out.

---

## 0. Decide where the harness lives

Two layouts work:

- **In-repo**: copy this folder to `LLM coding agent documents/` at your repo root. The orchestrator's repo selector finds it automatically.
- **Workspace-level** (multi-service): put one `LLM coding agent documents/` folder beside all your service repos and point the selector's scan dir at the parent.

LMO uses the in-repo layout.

---

## 1. Configure the orchestrator

Open `orchestrate-agents.sh` and edit the **`# ─── CONFIG / ADAPT ───`** block near the top:

- `WORKSPACE_DIR` / repo marker — how the selector finds your repo(s).
- VCS: a `github.com` remote uses `gh`; anything else is treated as Gitea and uses `tea` (set `TEA_LOGIN` to your Gitea login name; run `tea login add` once).
- Commit-message convention (Conventional Commits, or your house pattern) — used by the Stage 6 metadata step.
- Model picker defaults, jitter, effort.

Sanity check: `bash -n orchestrate-agents.sh` must be clean.

---

## 2. Write the three agent docs

The orchestrator loads three instruction files. Generate them from the templates:

- `templates/BRAIN_AGENT.template.md`  → `{{ProjectName}} Brain Agent.md`
- `templates/CODING_AGENT.template.md` → `{{ProjectName}} Coding Agent.md`
- `templates/TPM_AGENT.template.md`    → `{{ProjectName}} Technical Product Manager.md`

Replace every `{{PLACEHOLDER}}`. The fastest, highest-fidelity way is to run the **LLM Coding Agent Creation Playbook** (`playbooks/LLM_CODING_AGENT_CREATION.md`) — point Claude at your codebase and have it fill the placeholders from the real code.

**Do NOT touch** the `## Coding Principles` block (Principle 0 + Operating Rules 0.1–0.7 + Principles 1–5). It is the doctrine and must stay byte-identical between the Brain and Coding docs.

Required filename globs (the selector matches these): `*Brain*Agent*.md`, `*Coding*Agent*.md`.

---

## 3. Keep the doctrine

Copy `doctrine/MINIMUM_ENTROPY_MANIFESTO.md` and `doctrine/CAVEMAN_CODE.md` into your harness folder as-is. In the manifesto, swap the single project-anchored example in rule **0.7** for one from your own codebase (the recurring shared-surface that drift hurts most). Nothing else changes.

---

## 4. Wire the doc-update runbook

Edit `playbooks/FULL_DOCUMENTATION_UPDATE.md` to list your real documentation set (service docs, test docs, function maps) and validation commands. Stage 5 executes this verbatim. If you have no doc set yet, Stage 5 degrades gracefully (it's skipped when the runbook is absent).

---

## 5. Set up the landing path (commit — default — or PR)

Stage 6's ending is controlled by `STAGE6_MODE` in the CONFIG block:

- **`commit` (default)** — the run ends with a single rich, template-compliant commit (subject + the full change description as the body) pushed to the worktree branch. No PR, no `gh`/`tea` needed. Best for 1–2-dev repos with no PR-gated CI or branch protection; fast-forward it into `main` when ready (see `playbooks/WORKTREE_TO_MAIN_PLAYBOOK.md`).
- **`pr`** — opens a draft PR against the base branch; configure the host below.

- **GitHub**: `gh auth login` once. Stage 6 (`pr` mode) uses `gh pr create --draft`.
- **Gitea**: `brew install tea` then `tea login add` (use `-i` if your instance has a self-signed/weak cert). On Gitea 1.20+, grant the token the **full scope set up front** to avoid incremental "missing scope" errors — `read:user,write:user,read:repository,write:repository,write:organization,read:issue,write:issue` (repo-create needs `write:user`; PR create/merge needs `read:issue`+`write:issue`, since PRs are issues in Gitea; the legacy `repo` scope is rejected). Set `TEA_LOGIN` in the orchestrator. Stage 6 uses `tea pull create` with a `WIP:` title prefix for draft.

Trim `templates/PR_DESCRIPTION_TEMPLATE.md` to the sections you actually use (the monitoring/observability section is optional).

---

## 6. First run

```bash
# from inside your repo, with an inline task
./orchestrate-agents.sh --task "Add a /health endpoint returning the build SHA"

# or preview the plan without running anything
./orchestrate-agents.sh --dry-run
```

Stay attached (`tmux attach`) and supervise. Stage 1 pauses for you to approve the Code Change Request. The run ends with a draft PR.

---

## 7. Verify before you trust it

- `bash -n orchestrate-agents.sh` clean.
- A `--dry-run` shows your repo, base branch, and the model picker.
- A real run on a tiny task ends with a rich commit whose message follows the template (or a draft PR in `STAGE6_MODE=pr`).

That last one — a real end-to-end run on a throwaway task — is the only true proof. Do it once before relying on the harness.
