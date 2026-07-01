# PR Description Template

Canonical pull-request body format for every PR opened by the orchestrator.
Stage 6 hands this file (plus the CCR + implementation report + QA findings)
to the Coding Agent that just shipped the change and asks it to produce a
template-compliant `pr_body.md` artifact, which is then attached verbatim via
`gh pr create --body-file` (GitHub) or `tea pull create --description` (Gitea).
In the default `STAGE6_MODE=commit`, that same body becomes the **git commit
message body** (subject line + this description) instead of a PR — so this file
is the canonical *change-description* format either way, PR or commit.

> Adapt for your project: trim sections you don't use (the post-deploy
> monitoring section is optional) and replace any house-specific identifiers
> with your own.

---

## Hard rules

1. **Heading text is byte-exact.** If your CI regex-checks PR headings (some
   teams gate on `## What / Why?` and `## How?` literally — including the
   trailing `?` and the spaces around `/`), misspelled headings fail. Keep them exact.
2. **Section order is fixed** (see schema below).
3. **Three `---` horizontal rules** split the body into the four major
   blocks: above-the-fold summary / CCR Form / Testing Demo / monitoring +
   metadata.
4. **Never invent evidence.** If a test wasn't run, say so in
   `### Section 5: Testing` under "Known test gaps". Captured-evidence
   blocks must be real terminal output, trimmed only with explicit
   `[trimmed N lines]` markers.
5. **Do NOT emit the `## Orchestration Metrics` table.** The orchestrator
   appends it after the agent finishes, with live wall-clock / call counts.
6. **PR title** is the Conventional Commit subject line (≤ 72 chars,
   imperative, no body). Generated separately from the body.
7. **Falsifiability over flourish.** Every claim in the body should be
   verifiable by reading the diff, the captured evidence, or a named
   artifact. No marketing prose.
8. **Deviations are disclosed loudly, never buried.** If the shipped change
   departed in any way from the CCR / plan it implements, the `## ⚠️
   Deviations from Plan` section is REQUIRED and near the top; if it didn't,
   that section says so in one line. Never omit it.

---

## Required schema (in order)

### 1. `## TL;DR`

Two-to-four sentences. State what shipped, the smallest possible
description of how it works, and the user-visible delta. Bold the most
load-bearing identifiers (policy name, flag key, endpoint). No bullet
list.

### 1b. `## ⚠️ Deviations from Plan` (REQUIRED — loud, never buried)

Carried straight from the Coding Agent's Deviation Disclosure. If the
shipped change departed from the CCR / agreed plan in ANY way (different
files, different approach, added/removed/reordered steps, changed data
shape, a workaround), list each as: **Plan said** → **Shipped instead** →
**Why (business outcome)** → **Risk + how it was verified/mitigated**.
This is where the highest-risk code hides, so a reviewer must see it
before anything else. If there were none, this section is a single line:
`No deviations from the CCR — implemented as specified.` Never omit it.

### 2. `---`

### 3. `## 🎯 [N] Lines That Make [thing] Run — [outcome punchline]`

The "punchline" block. Pick the smallest number of code lines (usually 2–4)
that, if removed, would break the feature, and call each one out with:

- **Line X — `path/to/file.ext:LINE_NO`** — one-sentence purpose.
- ```language code excerpt — the minimum identifier/expression that proves
  the claim```

End with a **Proof chain** paragraph: connect the lines into a causal
narrative from input to observable effect, naming the test or transcript
that verifies it end-to-end.

### 4. `---`

### 5. `## What / Why?`

Three labeled paragraphs (NOT a single blob):

- **What**: one paragraph naming the files/modules/functions touched and
  the observable behavioral delta. No motivation here.
- **What difference does this change actually make to the business?**:
  one paragraph quantifying the impact in money / risk / funnel terms.
  If unknown, say so explicitly — never bluff.
- **Blast Radius**:
  - **Touched**: bullet list of files/modules.
  - **Data**: schema/DDL/DML impact (or "none").
  - **Callers / consumers affected**: downstream systems that read or
    write the touched contract.
  - **Worst case**: the most damaging realistic failure mode + the
    recovery path. State whether a kill switch exists and where it lives.

### 6. `## How?`

- **Approach**: one paragraph on the design choice. Reference the
  architectural pattern reused (e.g. "mirrors `CEP_VERIFICATION_PROXY`")
  or, if novel, justify against Principle 1 (single responsibility) and
  Principle 5 (minimal surface area).
- **Before → After**: ASCII flow diagram showing the control flow on
  each side. Two columns when it fits. Skip only if the change is purely
  additive with no flow delta.
- **Feature Flag**: a dedicated sub-block specifying mechanism, system,
  default state on merge, rollout plan, kill switch, and scope. If the
  PR is exempt from the playbook's flag requirement, state the
  exemption category (surgical hotfix / pure refactor / docs-CI-only /
  migration-only-no-reader / flag-system bootstrap / rollout-gated-
  downstream) and document the kill-switch reality + named human
  approver inline.

### 7. `---`

### 8. `## Code Change Request Form`

Verbatim heading. Followed by:

- `### Header` — bullets: **Date**, **Developer**, **Ticket**, **Target
  Deployment Date**.
- `### Section 1: Change Summary` — **Description** paragraph +
  **What difference does this change actually make to the business?**
  paragraph (yes, repeat — the form is a standalone artifact).
- `### Section 2: Technical Implementation` — bullets covering
  **Components Affected**, **Files Modified** (full list), **Files
  Added**, **DB Changes** (DDL/DML/none + revision IDs), **API
  Changes**, **Feature Flag** (recap from `## How?`), plus any
  domain-specific bullets (deploy ordering, DAG schedule, operator
  changes, etc.).
- `### Section 3: Implementation Details` — **Approach** paragraph +
  **Alternatives Considered** list (each alternative + one-line reason
  it was rejected).
- `### Section 4: Use Cases & Edge Cases` — a markdown table:
  `| Scenario | Expected Behavior |`. Cover happy path + every edge
  case discovered during QA + every override / fallback path.
- `### Section 5: Testing` — bullets covering **Environments Tested**,
  **Scenarios Covered**, **Coverage Impact** (with before/after
  numbers when available), **Pre-commit hooks pass** (yes/no), **Known
  test gaps**.
- `### Section 6: User Impact` — bullets covering **Operational
  Changes**, **External system impact**, **Rollback Plan** (both
  operational and disaster-recovery paths).
- `### Section 7: Risk Self-Assessment` — **Level** (LOW / MEDIUM /
  HIGH), **Rationale** paragraph, **Main Concerns** numbered list with
  🔴 / 🟡 / 🟢 severity glyphs.
- `### Section 8: Commit Messages` — fenced code block listing every
  commit subject created for this PR (typically one squashed commit for
  the implementation + optional docs commit).

### 9. `---`

### 10. `## Testing Demo — Unfalsifiable Proof`

Open with one line stating the change category (business logic /
infra / data migration / refactor) and the proof type (live transcript
/ e2e suite / migration round-trip / prod-data replay).

- `### How to reproduce` — fenced shell block with the exact commands
  another engineer can run to reproduce the result.
- `### Expected observable outcome` — one paragraph stating what the
  commands above should print / persist.
- `### Captured evidence (source: <env>, <date>)` — fenced block with
  real terminal output. Use `[...trimmed N lines for context
  efficiency — full breakdown: ...]` to elide repetitive output but
  always keep the canonical proof line (e.g. `28 passed`, `200 OK`,
  the specific asserted value).
- `### Falsification criterion` — one paragraph stating what the
  captured evidence would have to look like for the claim to be FALSE.
- `### Minimum-lines check` — checkbox list confirming the evidence is
  the smallest verbatim capture that proves the claim, with a
  one-sentence justification for any trimming.

### 11. `---`

### 12. `## Success Metric`

State the **primary** success metric in one sentence, including the
target threshold and the direction of expected movement. Then link the
dashboard / metrics card that tracks it, with its identifier and
title. End with the observation window (e.g. "4 weeks post-deploy") and
how to read the chart (what should drop / flatten / step-down).

### 13. `---`

### 14. (Optional) `## Post-Deploy Monitoring`

If the change is worth watching after deploy, include a copy-paste-ready
monitoring prompt for whatever observability stack you use (dashboards,
metrics, log queries). Cover at minimum:

- **What changed** — one paragraph mirroring the TL;DR for someone who hasn't read the PR.
- **Deploy window** — merged PR number, deploy time, monitoring window, timezone.
- **Metrics to monitor** — the specific metrics + how to read them (and the exact query/SQL when a metric is derived).
- **Population scope** — which cohort / segment / filters.
- **Comparison baseline** — treatment vs control window definitions, if applicable.
- **Alerting thresholds** — warning / critical thresholds and the action to take (e.g. "auto-halt rollout").
- **Hard constraints** — datasource discipline, timezone, PII rules — whatever your house rules require.

Delete this section if the change doesn't warrant post-deploy monitoring.

### 15. (Optional) `---` + `## Stacked PR`

Use only when the PR's base branch is not `main` / `master` /
`develop`. State which parent PR must merge first and how to update
this PR's base after the parent lands.

### 16. `## Merge Checklist`

Markdown checkboxes for every condition that must be true before this
PR merges. Pre-check items that the orchestrator already verified
(pre-commit, tests). Leave human-gated items unchecked (named approver,
downstream config readiness, base-branch update). Always include at
minimum:

- [x] All unit tests pass — verified locally
- [x] All pre-commit hooks pass — verified locally
- [ ] (any human-gated approvals or downstream readiness items
  specific to this change)

---

## What the orchestrator appends automatically

After the agent's body is written, the script appends:

```
## Orchestration Metrics

| Metric | Value |
|--------|-------|
| Wall-clock time | <elapsed_total> |
| Claude calls | <TOTAL_CLAUDE_CALLS> |
| Total turns | <TOTAL_TURNS> |
| QA rounds | <QA_ROUNDS> |
| Model | <MODEL_CONFIG_LABEL> |

🤖 Generated with [Claude Code](https://claude.com/claude-code) via
multi-agent orchestration (N calls, T turns, R QA rounds)
```

The agent MUST NOT emit those lines — duplicates will appear if it does.

---

## Common failure modes (and how to avoid them)

| Failure mode | Cause | Fix |
|--------------|-------|-----|
| GitHub Action fails on regex | `## What/Why` or `## What / Why` (missing `?` or wrong spacing) | Copy `## What / Why?` byte-exact |
| "no captured evidence" | Coding Agent invented a test transcript | Run the test first, paste real output |
| Bland TL;DR | LLM filler ("This PR introduces a change that…") | Lead with the noun; identifier in backticks; behavior delta in the second sentence |
| Missing punchline | Agent skipped the `## 🎯` section | It is REQUIRED — never omit |
| Test plan checkboxes only | Agent stopped at `## Test plan` instead of the full Merge Checklist | Use `## Merge Checklist` per the schema |
| Monitoring prompt mentions metrics that don't exist | Agent invented metric names | Cross-check against your real metrics catalog/glossary before emitting; mark DERIVED metrics explicitly |

---

## Style guidance

- **Backtick** every identifier (file path, table, column, function,
  flag key, branch name, PR number).
- **Bold** the most load-bearing nouns on first mention in each
  paragraph.
- **Pre-formatted blocks** for terminal output, ASCII diagrams, JSON,
  SQL, code excerpts.
- **No emoji** except the section glyph `🎯` and severity glyphs
  (🔴 🟡 🟢) in `### Section 7: Risk Self-Assessment`.
- **Imperative voice** in the title and the Approach paragraph. Past
  tense in Captured Evidence sections (the work already happened).
- **Domain-canonical technical terms preserved** verbatim — use your
  codebase's real identifiers, in whatever language they are written.
- **No "we"** in operational sections — the PR is a singular artifact,
  not a team narrative.
