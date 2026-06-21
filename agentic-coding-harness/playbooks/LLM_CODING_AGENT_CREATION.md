# LLM Coding Agent Creation Playbook

How to turn the three template files in `../templates/` into accurate, repo-specific agent docs. The goal is a Brain Agent, Coding Agent, and TPM Agent that know **your** codebase well enough to plan and implement in it without hand-holding.

Run this once per repo (or after a major architecture change). Budget ~30–60 minutes.

---

## Principle: fill from the code, not from imagination

Every `{{PLACEHOLDER}}` is answered by reading the real repository, never by guessing. An agent doc that describes a codebase that doesn't exist is worse than no doc — it sends every future agent down a wrong path. So the process is **read → extract → fill → verify against code**.

---

## Step 1 — Point Claude at the repo

Open the repo in Claude Code (or paste the templates into a session with repo access). Give it this instruction:

> Read this repository's structure, entry points, datastore access, conventions, and test setup. You are going to fill in the `{{PLACEHOLDERS}}` in three agent-instruction templates. Fill each one **only** from what you can verify in the code. Where you can't verify something, ask — do not guess. **Do not edit the `## Coding Principles` block** in any template; copy it through verbatim.

## Step 2 — Extract the project context (the load-bearing placeholders)

Have it produce, from the code:

- **Product + core flow** — one paragraph: what it is, who it serves, the main data/request flow.
- **Stack** — language, framework, datastore + the *exact* access pattern, messaging, third parties, observability.
- **Service / module map** — each component, its one responsibility, and its blast radius (what halts if it's down).
- **Navigation order** — the real files an agent reads to orient: service docs → source layout → schema reference → dependency tracing.
- **Structural law** — the file/function layout and naming conventions, stated as rules the agent copies verbatim.
- **Data-access / security policy** — if there's a single sanctioned way to reach the datastore and prohibited patterns, state them as ABSOLUTE. If there isn't, delete that section.
- **0.7 anchor** — the recurring shared surface where a second convention hurts most (the thing that, drifted on one file, creates a half-migration). This is the one project-specific line inside the otherwise-verbatim doctrine block.
- **Test tiers** — how tests are organized and run, and the coverage habit.
- **Commit convention** — Conventional Commits, or your house pattern.

## Step 3 — Fill the three templates

- `CODING_AGENT.template.md` → `{{ProjectName}} Coding Agent.md`
- `BRAIN_AGENT.template.md` → `{{ProjectName}} Brain Agent.md`
- `TPM_AGENT.template.md` → `{{ProjectName}} Technical Product Manager.md`

Keep the **Coding Principles** block byte-identical between the Brain and Coding docs (the orchestrator and reviewers rely on this). Keep `CAVEMAN_CODE.md` and `MINIMUM_ENTROPY_MANIFESTO.md` as-is (swap only the manifesto's 0.7 example for your 0.7 anchor).

## Step 4 — Add the shared CCR form

Create one Code Change Request Form file the Brain and Coding docs both reference (who fills which section). It is the pipeline's handoff artifact; the orchestrator persists the completed form per run. Keep it in a single file so the two agent docs can't drift on it.

## Step 5 — Verify against the code

For each filled doc, spot-check 5 claims against the actual repository: does that file exist? does that function do what the doc says? is that the real test command? A doc that survives this check is ready. One that doesn't gets corrected before first use.

## Step 6 — First orchestration is the real test

Run the orchestrator on a tiny throwaway task. If Stage 1 (Brain planning) produces a sane, code-grounded CCR and Stage 2 (Coding) implements it without inventing structure, the docs are good. If an agent flails, the gap it hit is a placeholder you filled wrong — fix that doc, not the orchestrator.

---

## Maintenance

Treat the agent docs as living. When a QA finding or a failed run reveals a gap in these instructions, the Coding Agent's output format includes "agent-instruction updates if a correction revealed a gap" — fold those back in. The docs are only as good as their agreement with the code.
